import {
  chmodSync,
  readdirSync,
  rmSync,
  statSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/**
 * Errors that mean the sandbox is spent rather than the scan having gone wrong.
 *
 * A Chromium that will not launch, or that dies on its first navigation, never
 * recovers inside the same warm container. Lambda handed the same poisoned
 * sandbox to every three-minute tick and each one failed in under a second,
 * with `ERR_INSUFFICIENT_RESOURCES` and `browser.newContext` alternating for
 * twenty minutes; nothing in the scan itself could have broken that cycle.
 */
const SPENT_CONTAINER =
  /ERR_INSUFFICIENT_RESOURCES|browser\.newContext|Failed to launch|Target (?:page, context or browser has been )?closed/iu;

/**
 * What a browser leaves in `/tmp` that is safe to delete between scans.
 *
 * Deliberately a denylist. `/tmp` also holds the Chromium that
 * @sparticuz/chromium unpacks once per sandbox — roughly 200 MB of the 512 MB
 * budget — and deleting that would cost an extraction on every scan instead of
 * one per container.
 */
const DISPOSABLE = [
  /^playwright/u,
  /^puppeteer_dev/u,
  /^\.org\.chromium\./u,
  /^\.com\.google\.Chrome/u,
  /^Crashpad$/u,
  /^core\./u,
];

const TEMPORARY = "/tmp";

/** Exported because deleting the wrong name here costs the sandbox its browser. */
export function isDisposableTemporary(name: string): boolean {
  return DISPOSABLE.some((pattern) => pattern.test(name));
}

export function isSpentContainer(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return SPENT_CONTAINER.test(message);
}

/** Bounded so a runaway directory cannot turn a log line into a stack walk. */
function sizeOf(path: string, budget = { entries: 20_000 }): number {
  if (budget.entries <= 0) return 0;
  budget.entries -= 1;
  let stats;
  try {
    stats = statSync(path);
  } catch {
    return 0;
  }
  if (!stats.isDirectory()) return stats.size;
  let total = 0;
  let children: string[];
  try {
    children = readdirSync(path);
  } catch {
    return 0;
  }
  for (const child of children) total += sizeOf(join(path, child), budget);
  return total;
}

/**
 * What the sandbox has left, so a container that stops working says why.
 *
 * `ERR_INSUFFICIENT_RESOURCES` names no resource, and free space alone did not
 * identify one either: `/tmp` sat at 312 MB free for three scans and then fell
 * to 18 MB in a single one. The heaviest entries are what says which directory
 * did it, and the guess this replaces — Playwright profile directories — is not
 * assumed to be the answer.
 */
export function containerResources(): Record<string, unknown> {
  try {
    const tmp = statfsSync(TEMPORARY);
    const heaviest = readdirSync(TEMPORARY)
      .map((name) => ({
        name,
        mb: Math.round(sizeOf(join(TEMPORARY, name)) / 1_048_576),
      }))
      .filter((entry) => entry.mb > 0)
      .sort((left, right) => right.mb - left.mb)
      .slice(0, 6);
    return {
      tmpFreeMb: Math.round(
        (Number(tmp.bfree) * Number(tmp.bsize)) / 1_048_576,
      ),
      openFds: readdirSync("/proc/self/fd").length,
      heaviest,
    };
  } catch {
    // No procfs, so not Lambda, so nothing here to measure.
    return {};
  }
}

/**
 * Deletes the browser leftovers in `/tmp`, returning how many went.
 *
 * Runs before the scan rather than after it, so a sandbox that is already full
 * repairs itself on the next tick instead of needing a deploy. Exiting the
 * process does not do this: Lambda restarts the runtime on the same filesystem,
 * so `/tmp` came back with the same 14 MB free and the same failure.
 */
export function sweepBrowserTemporaries(): Record<string, number> {
  let names: string[];
  try {
    names = readdirSync(TEMPORARY);
  } catch {
    return { swept: 0 };
  }
  let swept = 0;
  for (const name of names) {
    if (!isDisposableTemporary(name)) continue;
    try {
      rmSync(join(TEMPORARY, name), { recursive: true, force: true });
      swept += 1;
    } catch {
      // In use by something that outlived its scan; the next sweep gets it.
    }
  }
  return { swept };
}

/**
 * Ends the process so Lambda rebuilds the runtime for the next tick.
 *
 * A weaker remedy than it looks: it does clear leaked descriptors and memory,
 * but Lambda restarts the process on the same `/tmp`, so it cannot recover a
 * sandbox that ran out of disk. That is what the sweep is for.
 *
 * Inert outside Lambda: the same call in a test run would take the test runner
 * down with it.
 */
export function exitForFreshContainer(): boolean {
  if (process.env.AWS_LAMBDA_FUNCTION_NAME === undefined) return false;
  process.exit(1);
}

/**
 * Wraps the browser binary in a shell that forbids core dumps.
 *
 * Chromium crashes as it shuts down and the kernel writes a 1.2 GB core file
 * into `/tmp`, which holds 512 MB. One crash filled the disk and every scan
 * after it failed to launch a browser at all.
 *
 * No Chromium flag prevents this. The dump belongs to the kernel, governed by
 * RLIMIT_CORE, and a process inherits that limit from whatever spawned it, so
 * the limit has to be lowered between Node and the browser. `exec` replaces the
 * shell rather than forking, keeping the pid and the inherited descriptors that
 * Playwright speaks to the browser over: the wrapper is invisible to it.
 *
 * Outside Lambda the real path is returned untouched, so a developer keeps
 * whatever core behaviour their machine is configured for.
 */
export function withoutCoreDumps(executablePath: string): string {
  if (process.env.AWS_LAMBDA_FUNCTION_NAME === undefined) return executablePath;
  const wrapper = join(TEMPORARY, "chromium-no-core");
  try {
    writeFileSync(
      wrapper,
      [
        "#!/bin/sh",
        "ulimit -c 0",
        // Quoted so a path with a space survives, and exec'd so no shell lingers.
        `exec ${JSON.stringify(executablePath)} "$@"`,
        "",
      ].join("\n"),
    );
    chmodSync(wrapper, 0o755);
  } catch {
    // A core dump is survivable; no browser at all is not.
    return executablePath;
  }
  return wrapper;
}
