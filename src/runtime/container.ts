import { readdirSync, statfsSync } from "node:fs";

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

export function isSpentContainer(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return SPENT_CONTAINER.test(message);
}

/**
 * What the sandbox has left, so a container that stops working says why.
 *
 * `ERR_INSUFFICIENT_RESOURCES` names no resource. Free space in `/tmp` — where
 * @sparticuz/chromium unpacks the binary and Playwright writes a profile per
 * launch — and the descriptor count are the two that a repeated browser launch
 * can exhaust, and both are a directory read away.
 */
export function containerResources(): Record<string, number> {
  try {
    const tmp = statfsSync("/tmp");
    return {
      tmpFreeMb: Math.round(
        (Number(tmp.bfree) * Number(tmp.bsize)) / 1_048_576,
      ),
      openFds: readdirSync("/proc/self/fd").length,
    };
  } catch {
    // No procfs, so not Lambda, so nothing here to measure.
    return {};
  }
}

/**
 * Ends the process so Lambda builds a fresh sandbox for the next tick.
 *
 * There is no API for discarding a warm container, but the runtime replaces one
 * whose process exits. It costs a cold start on the following scan, which is
 * about half a second against the alternative of every scan until closing time
 * failing in the same broken sandbox.
 *
 * Inert outside Lambda: the same call in a test run would take the test runner
 * down with it.
 */
export function exitForFreshContainer(): boolean {
  if (process.env.AWS_LAMBDA_FUNCTION_NAME === undefined) return false;
  process.exit(1);
}
