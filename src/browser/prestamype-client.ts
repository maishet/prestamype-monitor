import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { load } from "cheerio";

import type { OpportunitySource } from "../application/ports.js";
import type {
  MonitorConfig,
  Opportunity,
  PortfolioSnapshot,
  OpportunityFingerprintRecord,
} from "../domain/types.js";
import {
  PageStructureError,
  RateLimitError,
  ScanDeadlineError,
  SessionChallengeError,
  SessionExpiredError,
} from "./errors.js";
import {
  parseOpportunityCards,
  parseOpportunityDetail,
  parseVisibleMoneyCents,
  isProblematicCollectionStatus,
  type OpportunitySummary,
} from "./parsers.js";

export const ORIGIN = "https://www.prestamype.com";
const APEX_ORIGIN = "https://prestamype.com";
const OPPORTUNITIES_PATH = "/app/inversionista/oportunidades";
const PORTFOLIO_PATH = "/app/inversionista/mis-inversiones";
const PROTECTED_PATHS = [
  OPPORTUNITIES_PATH,
  PORTFOLIO_PATH,
  "/app/inversionista/estado-cuenta",
  "/app/inversionista/reportes",
  "/app/inversionista/dashboard",
] as const;
const PROHIBITED_ACTION = /invertir|reservar|pagar|confirmar/i;
const ALLOWED_ACTIONS = new Set([
  "Filtros",
  "Aplicar filtros",
  "Ordenar por: Recomendado",
  "Retorno mayor",
  "A+",
  "A",
  "B",
  "C",
]);

function isAlreadyClosedBrowserError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:Target|browserContext|context|browser)\s*(?:page,?\s*)?(?:has been closed|disposeBrowserContext|closed)/i.test(
    message,
  );
}

export interface LocatorLike {
  click(): Promise<void>;
  isVisible(): Promise<boolean>;
  textContent(): Promise<string | null>;
}

export interface PageLike {
  goto(url: string): Promise<{ status(): number } | null>;
  url(): string;
  content(): Promise<string>;
  locator(selector: string): LocatorLike;
  getByRole(role: string, options: { name: string; exact: boolean }): LocatorLike;
  getByText?(text: string, options: { exact: boolean }): LocatorLike;
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
}

export function shouldBlockResource(
  resourceType: string,
  rawUrl = ORIGIN,
): boolean {
  if (["image", "font", "media"].includes(resourceType)) return true;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return true;
  }
  if (url.origin === APEX_ORIGIN) return resourceType !== "document";
  if (url.origin !== ORIGIN) return true;
  return !["document", "script", "xhr", "fetch"].includes(resourceType);
}

export function assertAllowedInteraction(interaction: {
  kind: "click";
  name: string;
}): void {
  if (
    PROHIBITED_ACTION.test(interaction.name) ||
    !ALLOWED_ACTIONS.has(interaction.name)
  ) {
    throw new PageStructureError("UNSUPPORTED_VALUE", "interaction");
  }
}

function fingerprint(value: object): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function visibleCardFingerprint(
  summary: OpportunitySummary | Opportunity,
): string {
  return fingerprint({
    annualReturnPct: summary.annualReturnPct,
    currency: summary.currency,
    debtor: summary.debtor,
    id: summary.id,
    remainingAmountCents: summary.remainingAmountCents,
    risk: summary.risk,
    supplier: summary.supplier,
    url: summary.url,
  });
}

export function summaryFingerprint(summary: OpportunitySummary): string {
  return visibleCardFingerprint(summary);
}

export function opportunityFingerprint(opportunity: Opportunity): string {
  return visibleCardFingerprint(opportunity);
}

export class PrestamypeClient implements OpportunitySource {
  private readonly launcher: BrowserLauncher;
  private readonly now: () => number;
  private readonly deadlineMs: number;
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

  constructor(private readonly options: PrestamypeClientOptions) {
    this.launcher = options.launcher ?? productionLauncher;
    this.now = options.now ?? Date.now;
    this.deadlineMs = options.deadlineMs ?? 25_000;
  }

  beginScan(): void {
    if (this.closed)
      throw new PageStructureError("UNSUPPORTED_VALUE", "clientState");
    this.scanDeadline = this.now() + this.deadlineMs;
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
      const $ = load(await this.withDeadline(page.content(), deadline));
      const balanceText = $('[data-field="available-balance"]').first().text();
      const parsedActiveTotal = parseOptionalPenCents(
        $('[data-field="active-total"]').first().text(),
      );
      const exposureByTaxId: Record<string, number> = {};
      const rows = $(PORTFOLIO_SELECTORS.exposureRow).toArray();
      for (const row of rows) {
        const taxId = $(row)
          .find(PORTFOLIO_SELECTORS.taxId)
          .first()
          .text()
          .trim();
        if (!/^\d{11}$/.test(taxId))
          throw new PageStructureError(
            "INVALID_FIELD",
            "portfolioExposure.taxId",
          );
        const amount = parseOptionalPenCents(
          $(row).find(PORTFOLIO_SELECTORS.amount).first().text(),
        );
        if (amount === null)
          throw new PageStructureError(
            "MISSING_FIELD",
            "portfolioExposure.amount",
          );
        exposureByTaxId[taxId] = (exposureByTaxId[taxId] ?? 0) + amount;
      }
      const collectionConflicts = $(PORTFOLIO_SELECTORS.collectionRow)
        .toArray()
        .flatMap((row) => {
          const scope = $(row);
          const required = (selector: string, field: string): string => {
            const value = scope.find(selector).first().text().trim();
            if (value === "")
              throw new PageStructureError("MISSING_FIELD", field);
            return value;
          };
          const identity = (role: "supplier" | "debtor") => {
            const legalName = required(
              role === "supplier"
                ? PORTFOLIO_SELECTORS.supplierName
                : PORTFOLIO_SELECTORS.debtorName,
              `portfolioCollection.${role}.legalName`,
            );
            const rawTaxId = scope
              .find(
                role === "supplier"
                  ? PORTFOLIO_SELECTORS.supplierTaxId
                  : PORTFOLIO_SELECTORS.debtorTaxId,
              )
              .first()
              .text()
              .trim();
            if (rawTaxId !== "" && !/^\d{11}$/.test(rawTaxId))
              throw new PageStructureError(
                "INVALID_FIELD",
                `portfolioCollection.${role}.taxId`,
              );
            return { legalName, taxId: rawTaxId === "" ? null : rawTaxId };
          };
          const status = required(
            PORTFOLIO_SELECTORS.collectionStatus,
            "portfolioCollection.status",
          );
          const supplier = identity("supplier");
          const debtor = identity("debtor");
          if (!isProblematicCollectionStatus(status)) return [];
          const evidence = scope
            .find(PORTFOLIO_SELECTORS.collectionEvidence)
            .first()
            .text()
            .trim();
          return [
            {
              supplier,
              debtor,
              status,
              evidence: evidence === "" ? null : evidence,
            },
          ];
        });
      return {
        availableBalanceCents: parseOptionalPenCents(balanceText),
        activeTotalCents:
          parsedActiveTotal !== null &&
          parsedActiveTotal > 0 &&
          rows.length === 0
            ? null
            : parsedActiveTotal,
        exposureByTaxId,
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
      return await this.listEligibleWithinDeadline(
        config,
        knownFingerprints,
        deadline,
      );
    } catch (error) {
      this.closeOnDeadline(error);
      throw error;
    } finally {
      release();
    }
  }

  private async listEligibleWithinDeadline(
    config: MonitorConfig,
    knownFingerprints: Readonly<Record<string, OpportunityFingerprintRecord>>,
    deadline: number,
  ): Promise<Opportunity[]> {
    const page = await this.getPage(deadline);
    await this.navigate(page, OPPORTUNITIES_PATH, deadline);
    await this.assertAuthenticated(page, deadline);
    try {
      await this.clickAccessible(page, "button", "Filtros", deadline);
      for (const risk of ["A+", "A", "B", "C"] as const) {
        if (config.allowedRisks.includes(risk)) {
          await this.clickAccessible(page, "checkbox", risk, deadline);
        }
      }
      await this.clickAccessible(page, "button", "Aplicar filtros", deadline);
    } catch (error) {
      if (!(error instanceof PageStructureError)) throw error;
      console.error("Sanitized optional filter interaction unavailable");
    }
    let sortControlsAvailable = true;
    try {
      await this.clickAccessible(
        page,
        "button",
        "Ordenar por: Recomendado",
        deadline,
      );
      await this.clickAccessible(page, "button", "Retorno mayor", deadline);
    } catch (error) {
      if (!(error instanceof PageStructureError)) throw error;
      sortControlsAvailable = false;
      console.error("Sanitized optional sort interaction unavailable");
    }
    if (sortControlsAvailable) {
      this.ensureDeadline(deadline);
      const sortState = page.locator('[data-state="sort-return-desc"]');
      if (
        !(await this.withDeadline(sortState.isVisible(), deadline)) ||
        (await this.withDeadline(sortState.textContent(), deadline))?.trim() !==
          "Retorno mayor"
      ) {
        throw new PageStructureError("MISSING_FIELD", "sortConfirmation");
      }
    }

    const summaries = parseOpportunityCards(
      await this.withDeadline(page.content(), deadline),
    );
    if (!sortControlsAvailable)
      summaries.sort((left, right) => right.annualReturnPct - left.annualReturnPct);
    const results: Opportunity[] = [];
    for (const summary of summaries) {
      if (summary.annualReturnPct < config.minimumAnnualReturnPct) break;
      if (
        !config.allowedRisks.includes(summary.risk) ||
        summary.currency !== config.currency
      )
        continue;
      const known = knownFingerprints[summary.id];
      const checkedAt =
        known === undefined ? Number.NaN : Date.parse(known.detailCheckedAt);
      const refreshInterval = config.detailRefreshIntervalMs ?? 15 * 60 * 1_000;
      const recentlyChecked =
        Number.isFinite(checkedAt) && this.now() - checkedAt < refreshInterval;
      if (
        known?.visibleFingerprint === summaryFingerprint(summary) &&
        recentlyChecked
      )
        continue;
      await this.navigate(page, new URL(summary.url).pathname, deadline);
      await this.assertAuthenticated(page, deadline);
      results.push(
        parseOpportunityDetail(
          await this.withDeadline(page.content(), deadline),
          summary,
        ),
      );
    }
    return results;
  }

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
          result.status === "rejected" &&
          !isAlreadyClosedBrowserError(result.reason),
      );
      if (failure !== undefined) throw failure.reason;
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
        if (shouldBlockResource(request.resourceType(), request.url()))
          await this.withDeadline(route.abort(), routeDeadline);
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
    const legacyMarker = await this.withDeadline(
      page.locator('[data-page="authenticated"]').isVisible(),
      deadline,
    );
    const opportunitiesHeading = legacyMarker
      ? true
      : await this.withDeadline(
          page
            .getByRole("heading", { name: "Oportunidades", exact: true })
            .isVisible(),
          deadline,
        );
    const lambdaProtectedRoute =
      process.env.AWS_LAMBDA_FUNCTION_NAME === "prestamype-monitor-scan" &&
      process.env.LAMBDA_TASK_ROOT !== undefined &&
      (PROTECTED_PATHS.includes(
        new URL(page.url()).pathname as (typeof PROTECTED_PATHS)[number],
      ) ||
        /^\/app\/inversionista\/oportunidades\/[A-Za-z0-9_-]+$/.test(
          new URL(page.url()).pathname,
        ));
    if (!opportunitiesHeading)
      console.error(
        "Sanitized auth page markers",
        JSON.stringify({
          url: new URL(page.url()).pathname,
          legacyMarker,
          opportunitiesHeading,
          lambdaProtectedRoute,
        }),
      );
    if (!opportunitiesHeading && !lambdaProtectedRoute)
      throw new PageStructureError("MISSING_FIELD", "authenticatedPage");
  }

  private async clickAccessible(
    page: PageLike,
    role: "button" | "checkbox" | "option",
    name: string,
    deadline: number,
  ): Promise<void> {
    this.ensureDeadline(deadline);
    assertAllowedInteraction({ kind: "click", name });
    // The live UI renders the active-filter count in the accessible name
    // (for example, "Filtros 4"). Keep exact matching for every action except
    // this control so the selector remains stable as the count changes.
    let locator = page.getByRole(role, {
      name,
      exact: !(role === "button" && name === "Filtros"),
    });
    let visible = await this.withDeadline(locator.isVisible(), deadline);
    if (!visible && name === "Filtros") {
      locator = page.locator(
        'button:has-text("Filtros"), [role="button"]:has-text("Filtros"), [aria-label*="Filtros"]',
      );
      visible = await this.withDeadline(locator.isVisible(), deadline);
      if (!visible && page.getByText !== undefined) {
        locator = page.getByText("Filtros", { exact: false });
        visible = await this.withDeadline(locator.isVisible(), deadline);
      }
    }
    if (!visible) {
      console.error(
        "Sanitized missing interaction",
        JSON.stringify({ role, name }),
      );
      throw new PageStructureError("MISSING_FIELD", "interaction");
    }
    await this.withDeadline(locator.click(), deadline);
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

export const PORTFOLIO_SELECTORS = {
  exposureRow: "[data-portfolio-exposure]",
  taxId: '[data-field="tax-id"]',
  amount: '[data-field="amount"]',
  collectionRow: "[data-portfolio-collection]",
  supplierName: '[data-field="supplier-name"]',
  supplierTaxId: '[data-field="supplier-tax-id"]',
  debtorName: '[data-field="debtor-name"]',
  debtorTaxId: '[data-field="debtor-tax-id"]',
  collectionStatus: '[data-field="collection-status"]',
  collectionEvidence: '[data-field="collection-evidence"]',
} as const;

function isAllowedNavigation(url: URL): boolean {
  if (url.origin !== ORIGIN || url.username !== "" || url.password !== "")
    return false;
  return (
    PROTECTED_PATHS.includes(
      url.pathname as (typeof PROTECTED_PATHS)[number],
    ) ||
    /^\/app\/inversionista\/oportunidades\/[A-Za-z0-9_-]+$/.test(
      url.pathname,
    ) ||
    isLoginPath(url)
  );
}

function isLoginPath(url: URL): boolean {
  return url.origin === ORIGIN && /^\/iniciar-sesion\/?$/.test(url.pathname);
}

function parseOptionalPenCents(raw: string): number | null {
  const compact = raw.trim();
  if (compact === "") return null;
  return parseVisibleMoneyCents(compact, "PEN", "portfolioAmount");
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
    const chromiumModule = (await import(
      pathToFileURL(runtimeRequire.resolve("@sparticuz/chromium")).href
    )) as typeof import("@sparticuz/chromium");
    const browser = await playwrightChromium.launch({
      args: chromiumModule.default.args,
      executablePath: await chromiumModule.default.executablePath(),
      headless: true,
    });
    return browser as unknown as BrowserLike;
  },
};
