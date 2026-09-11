import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import type { OpportunitySource } from "../application/ports.js";
import type {
  CollectionConflict,
  MonitorConfig,
  Opportunity,
  OpportunityFingerprintRecord,
  PaymentHistory,
  PortfolioSnapshot,
  RiskGrade,
} from "../domain/types.js";
import { normalizeLegalName } from "../domain/normalization.js";
import { withoutCoreDumps } from "../runtime/container.js";
import {
  PageStructureError,
  RateLimitError,
  ScanDeadlineError,
  SessionChallengeError,
  SessionExpiredError,
} from "./errors.js";
import {
  LIVE_SELECTORS,
  OPPORTUNITIES_URL,
  isOpportunityTableLoading,
  isPanelOpen,
  parseOpportunityPanel,
  parseOpportunityRows,
  parsePager,
  parsePartyHistory,
  parsePartyProfile,
  parsePortfolioRows,
  type OpportunityPanel,
  type OpportunityRow,
} from "./live-parsers.js";
import { load } from "cheerio";

export const ORIGIN = "https://www.prestamype.com";
const APEX_ORIGIN = "https://prestamype.com";
/**
 * The whole single-page app is served from CloudFront. Blocking it — which the
 * original resource policy did — aborts every script the page needs, so Vue
 * never boots and the scan evaluates nothing. Analytics vendors stay blocked.
 */
const APPLICATION_ASSET_ORIGIN = "https://d14bodb4yrsx8y.cloudfront.net";

/**
 * The table's rows arrive from here, not from the www host. Blocking it let the
 * app boot and then hang forever on its loading row, which is indistinguishable
 * from a slow page unless the blocked requests are logged.
 */
const APPLICATION_API_ORIGIN = "https://api.prestamype.com";

const OPPORTUNITIES_PATH = "/app/inversionista/oportunidades";
const PORTFOLIO_PATH = "/app/inversionista/mis-inversiones";
const PROTECTED_PATHS = new Set([
  OPPORTUNITIES_PATH,
  PORTFOLIO_PATH,
  "/app/inversionista/estado-cuenta",
  "/app/inversionista/reportes",
  "/app/inversionista/dashboard",
]);

/**
 * Never click anything that could move money. This is checked against the
 * rendered text of the element about to be clicked, so it also guards clicks
 * made by CSS selector — the opportunities table puts an "Invertir" button in
 * every row, and the detail panel a "Realizar inversión" one.
 */
const PROHIBITED_ACTION =
  /invertir|inversi[óo]n|reservar|pagar|confirmar|depositar|dep[óo]sito|retirar/i;

const LETTER_RISKS: readonly RiskGrade[] = ["A+", "A", "B", "C", "D", "E"];
const ACTIVE_PORTFOLIO_STATES = /por cobrar|en proceso/iu;
const MAX_PAGES = 5;
/** How long the browser gets to shut itself down before it is killed. */
const CLEANUP_BUDGET_MS = 3_000;
/** Chromium under @sparticuz ships as either of these. */
const BROWSER_PROCESS = /chrom|headless_shell/iu;

export interface LocatorLike {
  click(options?: {
    force?: boolean;
    position?: { x: number; y: number };
  }): Promise<void>;
  isVisible(): Promise<boolean>;
  isChecked?(): Promise<boolean>;
  textContent(): Promise<string | null>;
  count?(): Promise<number>;
  nth?(index: number): LocatorLike;
  first?(): LocatorLike;
  locator?(selector: string): LocatorLike;
  dispatchEvent?(type: string): Promise<void>;
}

export interface PageLike {
  goto(url: string): Promise<{ status(): number } | null>;
  close?(): Promise<void>;
  url(): string;
  content(): Promise<string>;
  locator(selector: string): LocatorLike;
  route(
    pattern: string,
    handler: (
      route: { abort(): Promise<void>; continue(): Promise<void> },
      request: { resourceType(): string; url(): string },
    ) => Promise<void>,
  ): Promise<void>;
  setDefaultNavigationTimeout(timeoutMs: number): void;
  setDefaultTimeout?(timeoutMs: number): void;
}

export interface BrowserContextLike {
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
  setDefaultTimeout?(timeoutMs: number): void;
}

export interface BrowserLike {
  newContext(options: BrowserContextOptions): Promise<BrowserContextLike>;
  close(): Promise<void>;
}

export interface BrowserLauncher {
  launch(): Promise<BrowserLike>;
}

export interface BrowserContextOptions {
  locale: "es-PE";
  timezoneId: "America/Lima";
  viewport: { width: 1280; height: 720 };
  storageState: object;
}

export interface PrestamypeClientOptions {
  launcher?: BrowserLauncher;
  storageState: object;
  now?: () => number;
  deadlineMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

/**
 * Kills any Chromium still running in this container, and says how many.
 *
 * A graceful close is not something we can insist on. When the shutdown was
 * abandoned mid-way the browser process stayed alive, and because Lambda keeps
 * a warm container between invocations, every abandoned scan stacked another
 * Chromium: eight scans reached the 2 GB ceiling and from there every
 * navigation failed for want of memory. A signal is the one instruction a
 * wedged process cannot ignore.
 *
 * Only this container is visible from here and it runs one invocation at a
 * time, so anything still breathing is ours to reap. It is deliberately inert
 * anywhere but inside Lambda: on a developer machine the same sweep would kill
 * the browser they happen to have open.
 */
export function reapBrowserProcesses(): number {
  if (
    process.platform !== "linux" ||
    process.env.AWS_LAMBDA_FUNCTION_NAME === undefined
  )
    return 0;
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return 0;
  }
  let reaped = 0;
  for (const entry of entries) {
    if (!/^\d+$/u.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;
    let commandLine: string;
    try {
      commandLine = readFileSync(`/proc/${entry}/cmdline`, "utf8");
    } catch {
      continue; // Exited between listing the directory and reading it.
    }
    if (!BROWSER_PROCESS.test(commandLine)) continue;
    try {
      process.kill(pid, "SIGKILL");
      reaped += 1;
    } catch {
      // Already gone, which is the outcome we wanted anyway.
    }
  }
  return reaped;
}

export function shouldBlockResource(
  resourceType: string,
  rawUrl = ORIGIN,
): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return true;
  }
  if (url.origin === APPLICATION_ASSET_ORIGIN)
    return !["script", "stylesheet", "xhr", "fetch"].includes(resourceType);
  // Data only: the API host has no reason to serve documents or scripts here.
  if (url.origin === APPLICATION_API_ORIGIN)
    return !["xhr", "fetch"].includes(resourceType);
  if (["image", "font", "media"].includes(resourceType)) return true;
  if (url.origin === APEX_ORIGIN) return resourceType !== "document";
  if (url.origin !== ORIGIN) return true;
  return !["document", "script", "stylesheet", "xhr", "fetch"].includes(
    resourceType,
  );
}

export function assertAllowedInteraction(interaction: {
  kind: "click";
  name: string;
}): void {
  if (PROHIBITED_ACTION.test(interaction.name)) {
    throw new PageStructureError("UNSUPPORTED_VALUE", "interaction");
  }
}

function fingerprint(value: object): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * Identity of a row across scans. The table exposes no id and no link, so this
 * is derived from the fields that do not move while an auction is open.
 */
export function opportunityRowKey(row: OpportunityRow): string {
  return fingerprint({
    currency: row.currency,
    estimatedPaymentAt: row.estimatedPaymentAt,
    investmentType: row.investmentType,
    legalName: normalizeLegalName(row.legalName),
    totalAmountCents: row.totalAmountCents,
  }).slice(0, 32);
}

/**
 * What is visible about an auction, so material progress reopens the panel.
 *
 * The row and the stored opportunity must hash identically or every scan would
 * reopen every panel, so this uses only fields both carry.
 *
 * The funded share is rounded to whole percent — what the table itself prints.
 * At two decimals it moved on essentially every scan of an active auction, so
 * nothing was ever skipped and each scan reopened every eligible panel. The
 * cost of the coarser bucket is bounded: the score does not depend on funding
 * at all, only the projected amount does.
 */
function visibleFingerprint(visible: {
  id: string;
  risk: RiskGrade;
  annualReturnPct: number;
  fundedPct: number;
}): string {
  return fingerprint({
    ...visible,
    fundedPct: Math.round(visible.fundedPct),
  });
}

export function opportunityRowFingerprint(row: OpportunityRow): string {
  return visibleFingerprint({
    id: opportunityRowKey(row),
    risk: rowRisk(row),
    annualReturnPct: row.annualReturnPct,
    fundedPct: row.fundedPct,
  });
}

export function opportunityFingerprint(opportunity: Opportunity): string {
  const total = opportunity.totalAmountCents;
  return visibleFingerprint({
    id: opportunity.id,
    risk: opportunity.risk,
    annualReturnPct: opportunity.annualReturnPct,
    fundedPct: total > 0 ? (opportunity.fundedAmountCents / total) * 100 : 0,
  });
}

export function rowRisk(row: OpportunityRow): RiskGrade {
  return row.protectedCapital ? "PROTEGIDA" : (row.risk ?? "E");
}

function minimumReturnFor(config: MonitorConfig, risk: RiskGrade): number {
  return risk === "PROTEGIDA"
    ? (config.minimumProtectedAnnualReturnPct ?? config.minimumAnnualReturnPct)
    : config.minimumAnnualReturnPct;
}

/** The deepest return worth walking to, across every risk band allowed. */
function walkFloor(config: MonitorConfig): number {
  const floors = config.allowedRisks.map((risk) =>
    minimumReturnFor(config, risk),
  );
  return floors.length === 0
    ? config.minimumAnnualReturnPct
    : Math.min(...floors);
}

export class PrestamypeClient implements OpportunitySource {
  private readonly launcher: BrowserLauncher;
  private readonly now: () => number;
  private readonly deadlineMs: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private browser: BrowserLike | null = null;
  private context: BrowserContextLike | null = null;
  private page: PageLike | null = null;
  private closed = false;
  private initialization: Promise<PageLike> | null = null;
  private closePromise: Promise<void> | null = null;
  private operationTail: Promise<void> = Promise.resolve();
  private resourcesClosePromise: Promise<void> | null = null;
  private cleanupScheduled = false;
  private scanDeadline: number | null = null;
  private observedBalanceCents: number | null = null;
  private readonly requestCounts = new Map<string, number>();

  constructor(private readonly options: PrestamypeClientOptions) {
    this.launcher = options.launcher ?? productionLauncher;
    this.now = options.now ?? Date.now;
    this.deadlineMs = options.deadlineMs ?? 25_000;
    this.sleep =
      options.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  beginScan(): void {
    if (this.closed)
      throw new PageStructureError("UNSUPPORTED_VALUE", "clientState");
    this.scanDeadline = this.now() + this.deadlineMs;
  }

  availableBalanceCents(): number | null {
    return this.observedBalanceCents;
  }

  private currentScanDeadline(): number {
    this.scanDeadline ??= this.now() + this.deadlineMs;
    return this.scanDeadline;
  }

  async getPortfolio(): Promise<PortfolioSnapshot> {
    const deadline = this.currentScanDeadline();
    const release = await this.acquireOperation(deadline);
    try {
      const page = await this.getPage(deadline);
      await this.navigate(page, PORTFOLIO_PATH, deadline);
      await this.assertAuthenticated(page, deadline);
      // A table that never rendered parses as an empty portfolio, and an empty
      // portfolio reads as no exposure to anybody: concentration would be scored
      // against holdings that were merely unread, and it is worth five points.
      // Failing costs this one scan, and the next tick is three minutes away.
      if (!(await this.waitForRows(page, deadline)))
        throw new Error("The portfolio table did not render");

      const exposureByParty: Record<string, number> = {};
      const collectionConflicts: CollectionConflict[] = [];
      let activeTotalCents = 0;
      let rowsSeen = 0;

      for (let page_ = 1; page_ <= MAX_PAGES; page_ += 1) {
        const html = await this.withDeadline(page.content(), deadline);
        for (const row of parsePortfolioRows(html)) {
          rowsSeen += 1;
          const party = normalizeLegalName(row.legalName);
          if (ACTIVE_PORTFOLIO_STATES.test(row.state)) {
            activeTotalCents += row.investedAmountCents;
            exposureByParty[party] =
              (exposureByParty[party] ?? 0) + row.investedAmountCents;
          }
          if (row.collectionStage !== null) {
            collectionConflicts.push({
              party: { legalName: row.legalName, taxId: null },
              state: row.state,
              stage: row.collectionStage,
            });
          }
        }
        if (!(await this.goToNextPage(page, html, deadline))) break;
      }

      console.info(
        "Portfolio scanned",
        JSON.stringify({
          rows: rowsSeen,
          parties: Object.keys(exposureByParty).length,
          activeTotalCents,
          collectionConflicts: collectionConflicts.length,
        }),
      );
      return {
        // Only the detail panel renders the balance; the monitor folds in what
        // the opportunity scan observes.
        availableBalanceCents: this.observedBalanceCents,
        activeTotalCents: rowsSeen === 0 ? null : activeTotalCents,
        exposureByParty,
        ...(collectionConflicts.length === 0 ? {} : { collectionConflicts }),
      };
    } catch (error) {
      this.closeOnDeadline(error);
      throw error;
    } finally {
      release();
    }
  }

  async listEligibleOpportunities(
    config: MonitorConfig,
    knownFingerprints: Readonly<Record<string, OpportunityFingerprintRecord>>,
  ): Promise<Opportunity[]> {
    const deadline = this.currentScanDeadline();
    const release = await this.acquireOperation(deadline);
    try {
      return await this.scanOpportunities(config, knownFingerprints, deadline);
    } catch (error) {
      this.closeOnDeadline(error);
      throw error;
    } finally {
      release();
    }
  }

  private async scanOpportunities(
    config: MonitorConfig,
    knownFingerprints: Readonly<Record<string, OpportunityFingerprintRecord>>,
    deadline: number,
  ): Promise<Opportunity[]> {
    const page = await this.getPage(deadline);
    await this.navigate(page, OPPORTUNITIES_PATH, deadline);
    await this.step("authenticate", () =>
      this.assertAuthenticated(page, deadline),
    );
    await this.step("wait-rows", () => this.waitForRows(page, deadline));
    await this.step("sort", () => this.sortByHighestReturn(page, deadline));
    await this.step("wait-sorted-rows", () => this.waitForRows(page, deadline));

    const floor = walkFloor(config);
    const currencies = config.allowedCurrencies;
    const results: Opportunity[] = [];
    let scanned = 0;
    let skippedUnchanged = 0;
    let exhausted = false;

    for (
      let pageNumber = 1;
      pageNumber <= MAX_PAGES && !exhausted;
      pageNumber += 1
    ) {
      const html = await this.withDeadline(page.content(), deadline);
      const rows = parseOpportunityRows(html);
      for (const [index, row] of rows.entries()) {
        scanned += 1;
        if (row.annualReturnPct < floor) {
          exhausted = true;
          break;
        }
        const risk = rowRisk(row);
        if (
          !config.allowedRisks.includes(risk) ||
          !currencies.includes(row.currency) ||
          row.annualReturnPct < minimumReturnFor(config, risk)
        )
          continue;

        const id = opportunityRowKey(row);
        if (this.isUnchanged(row, id, knownFingerprints)) {
          skippedUnchanged += 1;
          continue;
        }
        results.push(
          await this.openAndParseDetail(page, row, index, id, deadline),
        );
      }
      if (!exhausted && !(await this.goToNextPage(page, html, deadline))) break;
    }

    console.info(
      "Opportunities scanned",
      JSON.stringify({
        scanned,
        skippedUnchanged,
        detailed: results.length,
        floor,
      }),
    );
    return results;
  }

  private isUnchanged(
    row: OpportunityRow,
    id: string,
    knownFingerprints: Readonly<Record<string, OpportunityFingerprintRecord>>,
  ): boolean {
    const known = knownFingerprints[id];
    if (known === undefined) return false;
    // An auction that already sent its one message has nothing left to tell us,
    // however much its funding moves afterwards: a second message is impossible
    // by construction, so its panel never needs opening again.
    if (known.alerted === true) return true;
    // Otherwise the table settles it. It carries the risk, the return, the
    // amount and the funded share, so whatever could change a verdict shows up
    // here, and a row that hashes the same is the row already held.
    //
    // A periodic refresh used to reopen the panel regardless, which at a
    // three-minute cadence re-read every eligible auction every five scans. It
    // accounted for nearly all of the 109 panels opened across 60 scans, at
    // about three seconds each, and could only ever re-confirm a verdict that
    // was already delivered or already below the threshold.
    return known.visibleFingerprint === opportunityRowFingerprint(row);
  }

  private async openAndParseDetail(
    page: PageLike,
    row: OpportunityRow,
    index: number,
    id: string,
    deadline: number,
  ): Promise<Opportunity> {
    await this.openRowPanel(page, index, deadline);
    await this.assertAuthenticated(page, deadline);
    const panel = parseOpportunityPanel(
      await this.withDeadline(page.content(), deadline),
    );
    if (panel.availableBalanceCents !== null)
      this.observedBalanceCents = panel.availableBalanceCents;

    const debtor = await this.readPartyTab(page, "Deudor", deadline);
    const supplier = await this.readPartyTab(page, "Proveedor", deadline);
    await this.closePanel(page, deadline);

    if (
      debtor.history?.averageDelayDays !== undefined &&
      debtor.history?.averageDelayDays !== null &&
      debtor.history.averageDelayDays > 365
    )
      console.warn(
        "Implausible average delay",
        JSON.stringify({
          auctionCode: panel.auctionCode,
          averageDelayDays: debtor.history.averageDelayDays,
        }),
      );

    return toOpportunity(id, row, panel, debtor, supplier);
  }

  private async readPartyTab(
    page: PageLike,
    label: "Deudor" | "Proveedor",
    deadline: number,
  ): Promise<{
    history: PaymentHistory | null;
    profile: ReturnType<typeof parsePartyProfile>;
  }> {
    const opened = await this.openPanelTab(page, label, deadline);
    if (!opened) return { history: null, profile: null };
    // The tab's cards arrive on their own request too. A tab that never fills
    // costs this party its history, not the whole opportunity.
    const html = await this.waitForContent(
      page,
      `tab:${label}`,
      (content) => parsePartyHistory(content) !== null,
      deadline,
      8_000,
    );
    if (html === null) return { history: null, profile: null };
    return {
      history: parsePartyHistory(html),
      profile: parsePartyProfile(html),
    };
  }

  // ------------------------------------------------------------ interactions
  private async safeClick(
    locator: LocatorLike,
    purpose: string,
    deadline: number,
  ): Promise<void> {
    this.ensureDeadline(deadline);
    if (purpose !== "overlay.close" && this.page !== null) {
      await this.dismissOverlay(this.page, deadline);
    }
    // Visibility first: it is a non-waiting check, while textContent auto-waits
    // for the full locator timeout on an element that may not exist at all.
    if (!(await this.withDeadline(locator.isVisible(), deadline)))
      throw new PageStructureError("MISSING_FIELD", `interaction.${purpose}`);
    const label = await this.withDeadline(locator.textContent(), deadline);
    assertAllowedInteraction({ kind: "click", name: label ?? "" });
    await this.withDeadline(locator.click(), deadline);
  }

  private async dismissOverlay(
    page: PageLike,
    deadline: number,
  ): Promise<void> {
    const selector =
      ':nth-match(:is(.generic-modal-overlay, [role="dialog"][aria-modal="true"], dialog[open]):visible, 1)';
    for (let dismissed = 0; dismissed < 4; dismissed += 1) {
      const modal = page.locator(selector).first?.() ?? page.locator(selector);
      if (!(await this.withDeadline(modal.isVisible(), deadline))) return;
      const text = (
        (await this.withDeadline(modal.textContent(), deadline)) ?? ""
      )
        .normalize("NFD")
        .replace(/\p{M}/gu, "");
      // A campaign may mention investing; only authentication/consent screens
      // require manual intervention. Never click their confirm/accept controls.
      if (
        /captcha|verifica.{0,30}(identidad|humano)|codigo de verificacion/iu.test(
          text,
        )
      )
        throw new SessionChallengeError();
      if (/sesion.{0,20}(expir|caduc)|inicia.{0,10}sesion/iu.test(text))
        throw new SessionExpiredError();
      if (
        /acept[ae][rs]?.{0,50}(terminos|condiciones|contrato)|firma.{0,25}contrato/iu.test(
          text,
        )
      )
        throw new PageStructureError(
          "UNSUPPORTED_VALUE",
          "overlay.manual-consent",
        );
      // The live page puts an <i class="icon-close"> over its button hitbox.
      // Force the containing close button so the overlay cannot intercept it.
      const icon = page.locator(`${selector} i.icon-close`).first?.() ??
        page.locator(`${selector} i.icon-close`);
      const closeSelector = `${selector} :is(button, [role="button"]):visible:is(:has(i.icon-close), [aria-label="Cerrar" i], [aria-label="Close" i], :text-is("Cerrar"), :text-is("Ahora no"), :text-is("Close"), :text-is("\u00d7"), :text-is("X"))`;
      const close =
        page.locator(closeSelector).first?.() ?? page.locator(closeSelector);
      if (await this.withDeadline(icon.isVisible(), deadline)) {
        // Campaign overlays are dismissible by clicking their backdrop. This
        // is more reliable than the nested icon, which can be covered by the
        // overlay itself even when Playwright reports it as visible.
        await this.withDeadline(
          modal.click({ force: true, position: { x: 4, y: 4 } }),
          deadline,
        );
        // A few variants ignore backdrop clicks; force the containing close
        // button as a second attempt before declaring the overlay stuck.
        if (await this.withDeadline(modal.isVisible(), deadline)) {
          // The campaign's Vue handler listens on the overlay itself. A
          // dispatched click preserves that target even when Chromium's hit
          // testing says the overlay covers the pointer coordinate.
          if (modal.dispatchEvent !== undefined) {
            try {
              await this.withDeadline(modal.dispatchEvent("click"), deadline);
            } catch {
              // Continue to the close-button fallback below.
            }
          }
        }
        if (await this.withDeadline(modal.isVisible(), deadline)) {
          try {
            await this.withDeadline(close.click({ force: true }), deadline);
          } catch {
            // Leave the normal disappearance check below to report a precise
            // PageStructureError if neither dismissal path worked.
          }
        }
      } else {
        if (!(await this.withDeadline(close.isVisible(), deadline)))
          throw new PageStructureError("MISSING_FIELD", "overlay.safe-close");
        await this.safeClick(close, "overlay.close", deadline);
      }
      const limit = Math.min(deadline, this.now() + 3_000);
      while (await this.withDeadline(modal.isVisible(), limit)) {
        if (this.now() + 100 >= limit)
          throw new PageStructureError("MISSING_FIELD", "overlay.did-not-close");
        await this.withDeadline(this.sleep(100), limit);
      }
      console.info("Dismissible overlay closed");
    }
    throw new PageStructureError("MISSING_FIELD", "overlay.too-many");
  }

  /**
   * Polls the rendered page until `ready` accepts it, or the budget runs out.
   *
   * Everything on this site arrives after the navigation resolves: the tables,
   * the slide-over panel and each of its tabs. Playwright's own waiting is not
   * usable here because `isVisible` never waits and `textContent` waits for the
   * full locator timeout, so both turn a slow page into a failed scan. Running
   * out of budget returns null and is the caller's problem, never an error.
   */
  private async waitForContent(
    page: PageLike,
    label: string,
    ready: (html: string) => boolean,
    deadline: number,
    budgetMs: number,
  ): Promise<string | null> {
    const limit = Math.min(deadline, this.now() + budgetMs);
    const started = this.now();
    for (;;) {
      const remaining = limit - this.now();
      if (remaining <= 0) {
        console.warn(
          "Wait budget ran out",
          JSON.stringify({ waitingFor: label, waitedMs: this.now() - started }),
        );
        this.logRequestSummary(`timeout:${label}`);
        return null;
      }
      const html = await this.withDeadline(page.content(), limit);
      if (ready(html)) {
        console.info(
          "Ready",
          JSON.stringify({
            waitingFor: label,
            waitedMs: this.now() - started,
            bytes: html.length,
          }),
        );
        this.logRequestSummary(`ready:${label}`);
        return html;
      }
      await this.withDeadline(this.sleep(Math.min(250, remaining)), limit + 50);
    }
  }

  /** False when the budget ran out with the table still unrendered. */
  private async waitForRows(
    page: PageLike,
    deadline: number,
  ): Promise<boolean> {
    return (
      (await this.waitForContent(
        page,
        "table",
        (html) => !isOpportunityTableLoading(html),
        deadline,
        12_000,
      )) !== null
    );
  }

  private async sortByHighestReturn(
    page: PageLike,
    deadline: number,
  ): Promise<void> {
    const trigger = page.locator(
      ".multi-select.select-sort .multi-select-trigger",
    );
    // isVisible does not auto-wait but textContent does, so the check has to
    // come first: asking a missing element for its text blocks for the whole
    // locator timeout and fails the scan instead of degrading it.
    if (!(await this.withDeadline(trigger.isVisible(), deadline))) {
      console.warn("Sort control not rendered; scanning in the default order");
      return;
    }
    const current =
      (await this.withDeadline(trigger.textContent(), deadline)) ?? "";
    if (/retorno\s+mayor/iu.test(current)) return;
    await this.safeClick(trigger, "sort.open", deadline);
    const option = page.locator(
      ".multi-select-dropdown .multi-select-option:has-text('Retorno mayor')",
    );
    if (!(await this.withDeadline(option.isVisible(), deadline))) {
      console.warn("Sort option 'Retorno mayor' not found");
      return;
    }
    await this.safeClick(option, "sort.select", deadline);
  }

  private async openRowPanel(
    page: PageLike,
    index: number,
    deadline: number,
  ): Promise<void> {
    const rows = page.locator(LIVE_SELECTORS.dataRow);
    const row = rows.nth?.(index);
    if (row?.locator === undefined)
      throw new PageStructureError("MISSING_FIELD", "interaction.row");
    const target = row.locator(
      `${LIVE_SELECTORS.clientCell} ${LIVE_SELECTORS.clientName}`,
    );
    await this.safeClick(target, `row.${index}`, deadline);
    // The slide-over mounts and then fills itself from a second request, so it
    // is not enough for it to exist: wait until the auction code is rendered.
    const html = await this.waitForContent(
      page,
      "panel",
      (content) =>
        isPanelOpen(content) && /C[oó]digo de subasta/iu.test(content),
      deadline,
      8_000,
    );
    if (html === null) throw new PageStructureError("MISSING_FIELD", "panel");
  }

  private async openPanelTab(
    page: PageLike,
    label: string,
    deadline: number,
  ): Promise<boolean> {
    const tab = page.locator(`${LIVE_SELECTORS.panelTab}:has-text('${label}')`);
    if (!(await this.withDeadline(tab.isVisible(), deadline))) {
      console.warn(`Panel tab not available: ${label}`);
      return false;
    }
    await this.safeClick(tab, `panel.tab.${label}`, deadline);
    return true;
  }

  private async closePanel(page: PageLike, deadline: number): Promise<void> {
    const close = page.locator(
      ".panel-header .icon-close-im, .panel-header button[aria-label='Cerrar']",
    );
    if (await this.withDeadline(close.isVisible(), deadline))
      await this.safeClick(close, "panel.close", deadline);
  }

  /** Advances the paginator when the current page is exhausted. */
  private async goToNextPage(
    page: PageLike,
    html: string,
    deadline: number,
  ): Promise<boolean> {
    const pager = parsePager(load(html));
    if (pager === null || pager.to >= pager.total) return false;
    const next = page.locator(".pagination-content .next-button button");
    if (!(await this.withDeadline(next.isVisible(), deadline))) return false;
    await this.safeClick(next, "pager.next", deadline);
    // The pager said there are more rows, so stopping quietly here would report
    // a partial portfolio as if it were the whole of it.
    if (!(await this.waitForRows(page, deadline)))
      throw new Error("A further page of rows did not render");
    return true;
  }

  // -------------------------------------------------------------- lifecycle

  async close(): Promise<void> {
    if (this.closePromise !== null) return this.closePromise;
    this.closed = true;
    this.closePromise = this.performClose();
    return this.closePromise;
  }

  private async performClose(): Promise<void> {
    const cleanupDeadline = this.now() + 12_000;
    const pending = Promise.allSettled([
      this.operationTail,
      this.initialization ?? Promise.resolve(),
    ]).then(() => undefined);
    try {
      await this.withDeadline(pending, cleanupDeadline);
    } catch (error) {
      if (error instanceof ScanDeadlineError) {
        this.scheduleEventualCleanup();
        return;
      }
      throw error;
    }
    await this.closeResources();
  }

  private async closeResources(): Promise<void> {
    if (this.resourcesClosePromise !== null) return this.resourcesClosePromise;
    const browser = this.browser;
    this.page = null;
    this.context = null;
    this.browser = null;
    this.resourcesClosePromise = (async () => {
      // Closing the browser closes its contexts and pages with it, so this is
      // the only step worth taking. Closing them separately first was not
      // merely redundant: the context close is what hangs, and abandoning the
      // shutdown there left the browser process behind for the warm container
      // to inherit. Whatever survives the budget is killed outright.
      const started = this.now();
      let unexpected: unknown;
      let closedItself = true;
      if (browser !== null) {
        try {
          await this.withDeadline(
            browser.close(),
            this.now() + CLEANUP_BUDGET_MS,
          );
        } catch (error) {
          closedItself = false;
          const message =
            error instanceof Error ? error.message : String(error);
          if (
            !(error instanceof ScanDeadlineError) &&
            !/context|target.*closed|failed to find context/iu.test(message)
          )
            unexpected = error;
        }
      }
      const reaped = reapBrowserProcesses();
      const detail = JSON.stringify({
        elapsedMs: this.now() - started,
        reaped,
      });
      if (closedItself) console.info("Browser closed", detail);
      else console.warn("Browser had to be killed to close", detail);
      if (unexpected !== undefined) throw unexpected;
    })();
    return this.resourcesClosePromise;
  }
  private async getPage(deadline: number): Promise<PageLike> {
    if (this.closed)
      throw new PageStructureError("UNSUPPORTED_VALUE", "clientState");
    if (this.page !== null) return this.page;
    this.initialization ??= this.initialize();
    const page = await this.withDeadline(this.initialization, deadline);
    if (this.closed)
      throw new PageStructureError("UNSUPPORTED_VALUE", "clientState");
    return page;
  }

  private async initialize(): Promise<PageLike> {
    try {
      this.browser = await this.launcher.launch();
      this.assertInitializationOpen();
      this.context = await this.browser.newContext({
        locale: "es-PE",
        timezoneId: "America/Lima",
        viewport: { width: 1280, height: 720 },
        storageState: this.options.storageState,
      });
      this.assertInitializationOpen();
      this.context.setDefaultTimeout?.(12_000);
      this.page = await this.context.newPage();
      this.assertInitializationOpen();
      this.page.setDefaultNavigationTimeout(12_000);
      this.page.setDefaultTimeout?.(12_000);
      await this.page.route("**/*", async (route, request) => {
        const routeDeadline = this.now() + 12_000;
        const blocked = shouldBlockResource(
          request.resourceType(),
          request.url(),
        );
        this.recordRequest(request.url(), request.resourceType(), blocked);
        if (blocked) await this.withDeadline(route.abort(), routeDeadline);
        else await this.withDeadline(route.continue(), routeDeadline);
      });
      this.assertInitializationOpen();
      return this.page;
    } catch (error) {
      if (this.closed) await this.closeResources().catch(() => undefined);
      throw error;
    }
  }

  private async navigate(
    page: PageLike,
    path: string,
    deadline: number,
  ): Promise<void> {
    this.ensureDeadline(deadline);
    const url = new URL(path, ORIGIN);
    if (!isAllowedNavigation(url))
      throw new PageStructureError("INVALID_URL", "navigation");
    const response = await this.withDeadline(page.goto(url.href), deadline);
    const status = response?.status();
    console.info("Navigated", JSON.stringify({ path, status: status ?? null }));
    if (status === 403 || status === 429) throw new RateLimitError(status);
    const landed = new URL(page.url());
    if (isLoginPath(landed)) throw new SessionExpiredError();
    if (!isAllowedNavigation(landed))
      throw new PageStructureError("INVALID_URL", "navigationResult");
  }

  private async assertAuthenticated(
    page: PageLike,
    deadline: number,
  ): Promise<void> {
    if (
      await this.withDeadline(
        page.locator('[data-challenge="captcha"]').isVisible(),
        deadline,
      )
    )
      throw new SessionChallengeError();
    if (isLoginPath(new URL(page.url()))) throw new SessionExpiredError();
    const path = new URL(page.url()).pathname;
    if (!PROTECTED_PATHS.has(path))
      throw new PageStructureError("MISSING_FIELD", "authenticatedPage");
    const html = await this.withDeadline(page.content(), deadline);
    if (
      /class="[^"]*\brow_table\b|class="[^"]*\bheader_table\b|Inversionista/iu.test(
        html,
      )
    )
      return;
    throw new PageStructureError("MISSING_FIELD", "authenticatedPage");
  }

  private recordRequest(
    rawUrl: string,
    resourceType: string,
    blocked: boolean,
  ): void {
    let origin: string;
    try {
      origin = new URL(rawUrl).origin;
    } catch {
      origin = "invalid";
    }
    const key = `${blocked ? "blocked" : "allowed"} ${origin} ${resourceType}`;
    this.requestCounts.set(key, (this.requestCounts.get(key) ?? 0) + 1);
  }

  /** Dumps and clears the request tally; called once per page milestone. */
  private logRequestSummary(phase: string): void {
    if (this.requestCounts.size === 0) return;
    const summary = Object.fromEntries(
      [...this.requestCounts.entries()].sort(
        ([, left], [, right]) => right - left,
      ),
    );
    console.info("Requests", JSON.stringify({ phase, summary }));
    this.requestCounts.clear();
  }

  /** Wraps a scan phase so a failure names the phase instead of the stack. */
  private async step<T>(phase: string, run: () => Promise<T>): Promise<T> {
    const started = this.now();
    try {
      return await run();
    } catch (error) {
      console.error(
        "Scan phase failed",
        JSON.stringify({
          phase,
          elapsedMs: this.now() - started,
          error: error instanceof Error ? error.name : "unknown",
        }),
      );
      this.logRequestSummary(`failed:${phase}`);
      throw error;
    }
  }

  private ensureDeadline(deadline: number): void {
    if (this.now() >= deadline) throw new ScanDeadlineError();
  }

  private async withDeadline<T>(
    operation: Promise<T>,
    deadline: number,
  ): Promise<T> {
    const remaining = deadline - this.now();
    if (remaining <= 0) throw new ScanDeadlineError();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            const error = new ScanDeadlineError() as ScanDeadlineError & {
              hardTimeout?: boolean;
            };
            error.hardTimeout = true;
            reject(error);
          }, remaining);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private closeOnDeadline(error: unknown): void {
    if (
      !(error instanceof ScanDeadlineError) ||
      !(error as ScanDeadlineError & { hardTimeout?: boolean }).hardTimeout
    )
      return;
    this.closed = true;
    this.closePromise ??= Promise.resolve();
    this.scheduleEventualCleanup();
  }

  private async acquireOperation(deadline: number): Promise<() => void> {
    if (this.closed)
      throw new PageStructureError("UNSUPPORTED_VALUE", "clientState");
    const predecessor = this.operationTail.catch(() => undefined);
    let release!: () => void;
    const own = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.operationTail = predecessor.then(() => own);
    try {
      await this.withDeadline(predecessor, deadline);
    } catch (error) {
      release();
      this.closeOnDeadline(error);
      throw error;
    }
    if (this.closed) {
      release();
      throw new PageStructureError("UNSUPPORTED_VALUE", "clientState");
    }
    return release;
  }

  private assertInitializationOpen(): void {
    if (this.closed)
      throw new PageStructureError("UNSUPPORTED_VALUE", "clientState");
  }

  private scheduleEventualCleanup(): void {
    if (this.cleanupScheduled) return;
    this.cleanupScheduled = true;
    void Promise.allSettled([
      this.operationTail,
      this.initialization ?? Promise.resolve(),
    ])
      .then(() => this.closeResources())
      .catch(() => undefined);
  }
}

function toOpportunity(
  id: string,
  row: OpportunityRow,
  panel: OpportunityPanel,
  debtor: {
    history: PaymentHistory | null;
    profile: {
      legalName: string;
      taxId: string | null;
      risk: RiskGrade | null;
    } | null;
  },
  supplier: {
    history: PaymentHistory | null;
    profile: {
      legalName: string;
      taxId: string | null;
      risk: RiskGrade | null;
    } | null;
  },
): Opportunity {
  const risk = panel.protectedCapital
    ? "PROTEGIDA"
    : (panel.risk ?? debtor.profile?.risk ?? rowRisk(row));
  return {
    id,
    auctionCode: panel.auctionCode,
    url: OPPORTUNITIES_URL,
    commercialName: panel.commercialName || row.commercialName,
    investmentType: row.investmentType,
    // Prestamype never publishes the supplier's name or tax id: its tab shows
    // only industry and economic activity. Falling back to the panel heading
    // would silently label the debtor as the supplier, so leave it empty.
    supplier: {
      legalName: supplier.profile?.legalName ?? "",
      taxId: supplier.profile?.taxId ?? null,
    },
    debtor: {
      legalName: debtor.profile?.legalName ?? panel.legalName,
      taxId: debtor.profile?.taxId ?? null,
    },
    risk: LETTER_RISKS.includes(risk) || risk === "PROTEGIDA" ? risk : "E",
    currency: panel.currency,
    annualReturnPct: panel.annualReturnPct,
    monthlyReturnPct: panel.monthlyReturnPct,
    totalAmountCents: panel.totalAmountCents,
    fundedAmountCents: panel.fundedAmountCents,
    remainingAmountCents: panel.remainingAmountCents,
    closesAt: panel.closesAt,
    dueAt: panel.dueAt ?? row.estimatedPaymentAt,
    debtorHistory: debtor.history,
    supplierHistory: supplier.history,
    collectionProblem: false,
  };
}

function isAllowedNavigation(url: URL): boolean {
  if (url.origin !== ORIGIN || url.username !== "" || url.password !== "")
    return false;
  return PROTECTED_PATHS.has(url.pathname) || isLoginPath(url);
}

function isLoginPath(url: URL): boolean {
  return url.origin === ORIGIN && /^\/iniciar-sesion\/?$/.test(url.pathname);
}

const productionLauncher: BrowserLauncher = {
  async launch(): Promise<BrowserLike> {
    // Lambda exposes layer packages through NODE_PATH. Node's ESM resolver does
    // not search NODE_PATH, while createRequire does and also preserves the
    // CommonJS default export used by @sparticuz/chromium.
    const runtimeRequire = createRequire(import.meta.url);
    const { chromium: playwrightChromium } = runtimeRequire(
      "playwright-core",
    ) as typeof import("playwright-core");
    const chromiumModule = await import(
      pathToFileURL(runtimeRequire.resolve("@sparticuz/chromium")).href
    );
    const chromiumBinary = chromiumModule as {
      default: typeof import("@sparticuz/chromium").default;
    };
    const browser = await playwrightChromium.launch({
      args: chromiumBinary.default.args,
      executablePath: withoutCoreDumps(
        await chromiumBinary.default.executablePath(),
      ),
      headless: true,
    });
    return browser as unknown as BrowserLike;
  },
};
