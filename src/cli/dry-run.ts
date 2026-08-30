import {
  lstat as nodeLstat,
  readFile as nodeReadFile,
  realpath as nodeRealpath,
} from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { OpportunitySource, SessionStore } from "../application/ports.js";
import {
  parseOpportunityCards,
  parseOpportunityDetail,
} from "../browser/parsers.js";
import type { BrowserLauncher } from "../browser/prestamype-client.js";
import { DEFAULT_CONFIG } from "../config/defaults.js";
import { evaluateOpportunity } from "../domain/evaluate.js";
import type {
  BlacklistEntry,
  Evaluation,
  MonitorConfig,
  Opportunity,
  PortfolioSnapshot,
} from "../domain/types.js";
import {
  decryptSession,
  type StorageState,
} from "../security/session-crypto.js";
import { redactSensitiveText } from "../security/redaction.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const FIXTURE_FILES = {
  list: "opportunities.html",
  detail: "opportunity-detail.html",
} as const;

export class DryRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DryRunError";
  }
}

export interface DryRunAdapterDependencies {
  store: SessionStore;
  key: Uint8Array;
  launcher: BrowserLauncher;
  config?: MonitorConfig;
  blacklist?: readonly BlacklistEntry[];
}

export type DryRunModuleLoader = (specifier: string) => Promise<unknown>;

interface FixtureStats {
  isSymbolicLink(): boolean;
  isDirectory(): boolean;
  isFile(): boolean;
}

export interface DryRunFixtureFileSystem {
  lstat(path: string): Promise<FixtureStats>;
  realpath(path: string): Promise<string>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
}

export interface DryRunDependencies {
  output?: (line: string) => void;
  errorOutput?: (line: string) => void;
  environment?: Readonly<Record<string, string | undefined>>;
  moduleLoader?: DryRunModuleLoader;
  fixtureDirectory?: string;
  /** Test seam only. Injected fixture content is trusted by its caller. */
  fixtureContent?: { list: string; detail: string };
  fixtureFs?: DryRunFixtureFileSystem;
  timeoutMs?: number;
  createClient?: (
    storageState: StorageState,
    launcher: BrowserLauncher,
  ) => OpportunitySource;
  now?: () => Date;
}

export interface DryRunResult {
  mode: "fixture" | "live";
  evaluated: number;
}

export function resolveDryRunAdapterSpecifier(
  specifier: string,
  cwd = process.cwd(),
): string {
  const value = specifier.trim();
  if (value === "") throw new DryRunError("Live dry-run is not configured");
  if (/^[\\/]{2}/.test(value))
    throw new DryRunError("Live dry-run adapter specifier is not allowed");
  if (/^(?:https?|ftp):/i.test(value))
    throw new DryRunError("Live dry-run adapter specifier is not allowed");
  if (/^file:/i.test(value)) {
    let decoded = value;
    for (let round = 0; round <= 3; round += 1) {
      const fileTail = decoded.slice("file:".length);
      if (
        /%(?:2f|5c)/i.test(decoded) ||
        (/^[\\/]{2}/.test(fileTail) && !/^\/\/\/[^/\\]/.test(fileTail))
      )
        throw new DryRunError("Live dry-run adapter specifier is not allowed");
      if (round === 3 || !decoded.includes("%")) break;
      try {
        const next = decodeURIComponent(decoded);
        if (next === decoded) break;
        decoded = next;
      } catch {
        throw new DryRunError("Live dry-run adapter specifier is not allowed");
      }
    }
    const explicitAuthority = /^file:\/\/([^/]*)/i.exec(value)?.[1];
    if (explicitAuthority !== undefined && explicitAuthority !== "")
      throw new DryRunError("Live dry-run adapter specifier is not allowed");
    let fileUrl: URL;
    try {
      fileUrl = new URL(value);
    } catch {
      throw new DryRunError("Live dry-run adapter specifier is not allowed");
    }
    if (
      fileUrl.protocol !== "file:" ||
      fileUrl.hostname !== "" ||
      fileUrl.username !== "" ||
      fileUrl.password !== "" ||
      fileUrl.pathname === "" ||
      fileUrl.pathname === "/" ||
      /%00/i.test(fileUrl.pathname)
    )
      throw new DryRunError("Live dry-run adapter specifier is not allowed");
    return value;
  }
  if (/^(?:data|node):/i.test(value)) return value;
  const windowsAbsolute = /^[A-Za-z]:[\\/]/.test(value);
  if (windowsAbsolute) return pathToFileURL(value).href;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value))
    throw new DryRunError("Live dry-run adapter specifier is not allowed");
  if (
    isAbsolute(value) ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith(".\\") ||
    value.startsWith("..\\")
  )
    return pathToFileURL(resolve(cwd, value)).href;
  if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+(?:\/[a-z0-9._/-]+)?$/i.test(value))
    throw new DryRunError("Live dry-run adapter specifier is not allowed");
  return value;
}

function modeFromArgs(args: readonly string[]): "fixture" | "live" {
  if (args.length !== 1 || !["--fixture", "--live"].includes(args[0] ?? ""))
    throw new DryRunError("Choose exactly one mode: --fixture or --live");
  return args[0] === "--fixture" ? "fixture" : "live";
}

export function redactDryRunOutput(value: string): string {
  return redactSensitiveText(value)
    .split(/\r?\n/)
    .slice(0, 200)
    .map((rawLine) => {
      const line = rawLine.slice(0, 1_000);
      return line;
    })
    .join("\n")
    .slice(0, 12_000);
}

function safeOutput(sink: (line: string) => void, value: string): void {
  sink(redactDryRunOutput(value));
}

function fixturePath(directory: string, filename: string): string {
  const root = resolve(directory);
  const target = resolve(root, filename);
  const child = relative(root, target);
  if (child.startsWith("..") || isAbsolute(child))
    throw new DryRunError("Fixture path is not allowed");
  return target;
}

async function loadFixtures(
  dependencies: DryRunDependencies,
): Promise<{ list: string; detail: string }> {
  if (dependencies.fixtureContent !== undefined)
    return dependencies.fixtureContent;
  const knownDirectory = resolve("tests/fixtures");
  const directory = resolve(dependencies.fixtureDirectory ?? knownDirectory);
  if (directory.toLocaleLowerCase() !== knownDirectory.toLocaleLowerCase())
    throw new DryRunError("Fixture directory is not allowed");
  const fs = dependencies.fixtureFs ?? {
    lstat: nodeLstat,
    realpath: nodeRealpath,
    readFile: nodeReadFile,
  };
  const rootStats = await fs.lstat(directory);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory())
    throw new DryRunError("Fixture directory is not allowed");
  const realRoot = await fs.realpath(directory);
  const resolveKnownFile = async (filename: string): Promise<string> => {
    const path = fixturePath(directory, filename);
    const stats = await fs.lstat(path);
    if (stats.isSymbolicLink() || !stats.isFile())
      throw new DryRunError("Fixture path is not allowed");
    const realFile = await fs.realpath(path);
    const child = relative(realRoot, realFile);
    if (child.startsWith("..") || isAbsolute(child))
      throw new DryRunError("Fixture path is not allowed");
    return realFile;
  };
  const [listPath, detailPath] = await Promise.all([
    resolveKnownFile(FIXTURE_FILES.list),
    resolveKnownFile(FIXTURE_FILES.detail),
  ]);
  const [list, detail] = await Promise.all([
    fs.readFile(listPath, "utf8"),
    fs.readFile(detailPath, "utf8"),
  ]);
  return { list, detail };
}

const fixturePortfolio: PortfolioSnapshot = {
  availableBalanceCents: 0,
  activeTotalCents: 0,
  exposureByTaxId: {},
};

async function runFixture(
  dependencies: DryRunDependencies,
): Promise<DryRunResult> {
  const fixtures = await loadFixtures(dependencies);
  const summary = parseOpportunityCards(fixtures.list).find(
    (candidate) => candidate.id === "opp-a-16",
  );
  if (summary === undefined)
    throw new DryRunError("Sanitized fixture is invalid");
  const opportunity = parseOpportunityDetail(fixtures.detail, summary);
  const evaluation = evaluateOpportunity({
    opportunity,
    portfolio: fixturePortfolio,
    blacklistEntries: [],
    config: DEFAULT_CONFIG,
  });
  safeOutput(
    dependencies.output ?? console.log,
    [
      "DRY-RUN FIXTURE (sin red)",
      `Decisión: ${evaluation.decision}`,
      `Score: ${evaluation.score.toFixed(1)}/100`,
      `Riesgo: ${opportunity.risk}`,
      `Retorno anual: ${opportunity.annualReturnPct.toFixed(2)}%`,
      `Restante: PEN ${(opportunity.remainingAmountCents / 100).toFixed(2)}`,
      `ID: ${opportunity.id}`,
    ].join("\n"),
  );
  return { mode: "fixture", evaluated: 1 };
}

function isAdapter(value: unknown): value is DryRunAdapterDependencies {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const candidate = value as Record<string, unknown>;
  if ("notifier" in candidate || "repository" in candidate) return false;
  const store = candidate.store as Partial<SessionStore> | undefined;
  const launcher = candidate.launcher as Partial<BrowserLauncher> | undefined;
  return (
    candidate.key instanceof Uint8Array &&
    candidate.key.byteLength === 32 &&
    typeof store?.loadEncryptedSession === "function" &&
    typeof launcher?.launch === "function"
  );
}

async function loadAdapter(
  dependencies: DryRunDependencies,
  signal: AbortSignal,
): Promise<DryRunAdapterDependencies> {
  const specifier = dependencies.environment?.PRESTAMYPE_DRY_RUN_ADAPTER;
  if (specifier === undefined || specifier.trim() === "")
    throw new DryRunError("Live dry-run is not configured");
  const loader = dependencies.moduleLoader ?? ((value) => import(value));
  const resolvedSpecifier = resolveDryRunAdapterSpecifier(specifier);
  let loaded: unknown;
  try {
    loaded = await raceWithAbort(loader(resolvedSpecifier), signal);
  } catch (error) {
    if (error instanceof DryRunError) throw error;
    throw new DryRunError("Live dry-run adapter could not be loaded");
  }
  if (
    typeof loaded !== "object" ||
    loaded === null ||
    !("createDryRunDependencies" in loaded) ||
    typeof loaded.createDryRunDependencies !== "function"
  )
    throw new DryRunError("Live dry-run adapter is invalid");
  const adapter = await raceWithAbort(
    Promise.resolve(loaded.createDryRunDependencies()),
    signal,
  );
  if (!isAdapter(adapter))
    throw new DryRunError("Live dry-run adapter is invalid");
  return adapter;
}

async function runLive(
  dependencies: DryRunDependencies,
): Promise<DryRunResult> {
  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new DryRunError("Invalid dry-run timeout");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);
  let source: OpportunitySource | undefined;
  try {
    const adapter = await loadAdapter(dependencies, controller.signal);
    const encrypted = await raceWithAbort(
      adapter.store.loadEncryptedSession({ signal: controller.signal }),
      controller.signal,
    );
    if (encrypted === null)
      throw new DryRunError("Encrypted session is missing");
    const storageState = decryptSession(encrypted, adapter.key);
    if (dependencies.createClient !== undefined) {
      source = dependencies.createClient(storageState, adapter.launcher);
    } else {
      const { PrestamypeClient } =
        await import("../browser/prestamype-client.js");
      source = new PrestamypeClient({
        storageState,
        launcher: adapter.launcher,
        deadlineMs: timeoutMs,
      });
    }
    const config = adapter.config ?? DEFAULT_CONFIG;
    source.beginScan?.();
    const portfolio = await raceWithAbort(
      source.getPortfolio(),
      controller.signal,
    );
    const opportunities = await raceWithAbort(
      source.listEligibleOpportunities(config, {}),
      controller.signal,
    );
    const detectedAt = (dependencies.now ?? (() => new Date()))();
    const { formatOpportunityAlert } =
      await import("../notifications/telegram-message.js");
    for (const opportunity of opportunities) {
      const evaluation = sanitizeEvaluation(
        evaluateOpportunity({
          opportunity,
          portfolio,
          blacklistEntries: adapter.blacklist ?? [],
          config,
        }),
      );
      const safeOpportunity = sanitizeOpportunity(opportunity);
      safeOutput(
        dependencies.output ?? console.log,
        `[NO ENVIADO]\n${formatOpportunityAlert(safeOpportunity, evaluation, portfolio, detectedAt)}`,
      );
    }
    return { mode: "live", evaluated: opportunities.length };
  } catch (error) {
    if (error instanceof DryRunError) throw error;
    throw new DryRunError(
      controller.signal.aborted
        ? "Live dry-run timed out safely"
        : "Live dry-run failed safely",
    );
  } finally {
    clearTimeout(timer);
    if (source !== undefined) {
      try {
        await closeWithin(source, 2_000);
      } catch {
        // Cleanup details may contain browser/session data and are never exposed.
      }
    }
  }
}

function sanitizeDomainString(value: string): string {
  return redactDryRunOutput(value).replace(/\r?\n/g, " ").slice(0, 400);
}

function sanitizeOpportunity(opportunity: Opportunity): Opportunity {
  let safeUrl = sanitizeDomainString(opportunity.url);
  try {
    const parsed = new URL(safeUrl);
    parsed.search = "";
    parsed.hash = "";
    safeUrl = parsed.href;
  } catch {
    safeUrl = "";
  }
  return {
    ...opportunity,
    id: sanitizeDomainString(opportunity.id),
    url: safeUrl,
    supplier: {
      legalName: sanitizeDomainString(opportunity.supplier.legalName),
      taxId: null,
    },
    debtor: {
      legalName: sanitizeDomainString(opportunity.debtor.legalName),
      taxId: null,
    },
  };
}

function sanitizeEvaluation(evaluation: Evaluation): Evaluation {
  return {
    ...evaluation,
    reasons: evaluation.reasons.map(sanitizeDomainString),
    warnings: evaluation.warnings.map(sanitizeDomainString),
  };
}

async function closeWithin(
  source: OpportunitySource,
  timeoutMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      source.close(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function raceWithAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw new DryRunError("Live dry-run timed out safely");
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      finish();
      reject(new DryRunError("Live dry-run timed out safely"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(
      (value) => {
        if (settled) return;
        settled = true;
        finish();
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        finish();
        reject(error);
      },
    );
  });
}

export async function runDryRun(
  args: readonly string[],
  dependencies: DryRunDependencies = {},
): Promise<DryRunResult> {
  return modeFromArgs(args) === "fixture"
    ? runFixture(dependencies)
    : runLive(dependencies);
}

export async function runDryRunCli(
  args: readonly string[] = process.argv.slice(2),
  environment: Readonly<Record<string, string | undefined>> = process.env,
  dependencies: DryRunDependencies = {},
): Promise<number> {
  try {
    await runDryRun(args, { ...dependencies, environment });
    return 0;
  } catch (error) {
    (dependencies.errorOutput ?? console.error)(
      error instanceof DryRunError ? error.message : "Dry-run failed safely",
    );
    return 1;
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void runDryRunCli().then((status) => {
    process.exitCode = status;
  });
}
