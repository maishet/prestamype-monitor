import { createHash } from "node:crypto";
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
const DEFAULT_DETAIL_REFRESH_MS = 15 * 60 * 1_000;
const MAX_PAGES = 5;

export interface LocatorLike {
  click(): Promise<void>;
  isVisible(): Promise<boolean>;
  isChecked?(): Promise<boolean>;
  textContent(): Promise<string | null>;
  count?(): Promise<number>;
  nth?(index: number): LocatorLike;
  first?(): LocatorLike;
  locator?(selector: string): LocatorLike;
}

export interface PageLike {
  goto(url: string): Promise<{ status(): number } | null>;
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
 * What is visible about an auction, so funding progress reopens the panel.
 *
 * The row and the stored opportunity must hash identically or every scan would
 * reopen every panel, so this uses only fields both carry, with the funded
 * share rounded to the two decimals the site itself renders.
 */
function visibleFingerprint(visible: {
  id: string;
  risk: RiskGrade;
  annualReturnPct: number;
  fundedPct: number;
}): string {
  return fingerprint({
    ...visible,
    fundedPct: Math.round(visible.fundedPct * 100) / 100,
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
      await this.waitForRows(page, deadline);

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
    const currencies = config.allowedCurrencies ?? [config.currency];
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
        if (this.isUnchanged(row, id, knownFingerprints, config)) {
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
    config: MonitorConfig,
  ): boolean {
    const known = knownFingerprints[id];
    if (known?.visibleFingerprint !== opportunityRowFingerprint(row))
      return false;
    const checkedAt = Date.parse(known.detailCheckedAt);
    const refresh = config.detailRefreshIntervalMs ?? DEFAULT_DETAIL_REFRESH_MS;
    return Number.isFinite(checkedAt) && this.now() - checkedAt < refresh;
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
    // Visibility first: it is a non-waiting check, while textContent auto-waits
    // for the full locator timeout on an element that may not exist at all.
    if (!(await this.withDeadline(locator.isVisible(), deadline)))
      throw new PageStructureError("MISSING_FIELD", `interaction.${purpose}`);
    const label = await this.withDeadline(locator.textContent(), deadline);
    assertAllowedInteraction({ kind: "click", name: label ?? "" });
    await this.withDeadline(locator.click(), deadline);
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

  private async waitForRows(page: PageLike, deadline: number): Promise<void> {
    await this.waitForContent(
      page,
      "table",
      (html) => !isOpportunityTableLoading(html),
      deadline,
      12_000,
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
    await this.waitForRows(page, deadline);
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
    const context = this.context;
    const browser = this.browser;
    this.page = null;
    this.context = null;
    this.browser = null;
    this.resourcesClosePromise = (async () => {
      const cleanupDeadline = this.now() + 12_000;
      const results = await Promise.allSettled([
        context === null
          ? Promise.resolve()
          : this.withDeadline(context.close(), cleanupDeadline),
        browser === null
          ? Promise.resolve()
          : this.withDeadline(browser.close(), cleanupDeadline),
      ]);
      const failure = results.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      if (failure !== undefined) {
        const message =
          failure.reason instanceof Error
            ? failure.reason.message
            : String(failure.reason);
        // Chromium sometimes takes longer than the cleanup budget to shut down
        // on Lambda. The scan has already produced and persisted its result by
        // then, so failing here only makes SQS redeliver work that succeeded;
        // the container reclaims the process either way.
        if (failure.reason instanceof ScanDeadlineError) {
          console.warn(
            "Browser cleanup exceeded its budget; leaving it to the runtime",
          );
        } else if (
          !/context|target.*closed|failed to find context/iu.test(message)
        ) {
          throw failure.reason;
        }
      }
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
      executablePath: await chromiumBinary.default.executablePath(),
      headless: true,
    });
    return browser as unknown as BrowserLike;
  },
};
