import { afterEach, describe, expect, it, vi } from "vitest";

import type { MonitorConfig } from "../../src/domain/types.js";
import {
  PageStructureError,
  ScanDeadlineError,
  RateLimitError,
  SessionChallengeError,
  SessionExpiredError,
} from "../../src/browser/errors.js";
import {
  PrestamypeClient,
  assertAllowedInteraction,
  opportunityFingerprint,
  shouldBlockResource,
  summaryFingerprint,
  type BrowserContextLike,
  type BrowserLike,
  type BrowserLauncher,
  type LocatorLike,
  type PageLike,
} from "../../src/browser/prestamype-client.js";

const config: MonitorConfig = {
  allowedRisks: ["A+", "A", "B", "C"],
  minimumAnnualReturnPct: 15,
  currency: "PEN",
  minimumInvestmentCents: 10_000,
  highPriorityScore: 80,
  reviewScore: 70,
};

const cards = (
  rows: readonly {
    id: string;
    risk: string;
    annualReturn: string;
    remaining?: string;
  }[],
) =>
  rows
    .map(
      ({ id, risk, annualReturn, remaining = "S/ 1.000,00" }) => `
    <article data-opportunity-card>
      <a data-field="detail-link" href="/app/inversionista/oportunidades/${id}">Detalle</a>
      <span data-field="supplier-name">Proveedor ${id}</span><span data-field="supplier-tax-id">20123456789</span>
      <span data-field="debtor-name">Pagador ${id}</span><span data-field="debtor-tax-id">20987654321</span>
      <span data-field="risk">${risk}</span><span data-field="currency">PEN</span>
      <span data-field="annual-return">${annualReturn}</span><span data-field="remaining-amount">${remaining}</span>
    </article>`,
    )
    .join("");

const detail = (id: string): string => `<main data-page="opportunity-detail">
  <span data-field="supplier-name">Proveedor ${id}</span><span data-field="supplier-tax-id">20123456789</span>
  <span data-field="debtor-name">Pagador ${id}</span><span data-field="debtor-tax-id">20987654321</span>
  <span data-field="risk">A</span><span data-field="currency">PEN</span>
  <span data-field="annual-return">16,50%</span><span data-field="monthly-return">1,20%</span>
  <span data-field="total-amount">S/ 2.000,00</span><span data-field="funded-amount">S/ 1.000,00</span>
  <span data-field="remaining-amount">S/ 1.000,00</span>
</main>`;

class FakeLocator implements LocatorLike {
  constructor(
    private readonly visible = true,
    private readonly text: string | null = null,
  ) {}
  clicks = 0;
  async click(): Promise<void> {
    this.clicks += 1;
  }
  async isVisible(): Promise<boolean> {
    return this.visible;
  }
  async textContent(): Promise<string | null> {
    return this.text;
  }
}

class FakePage implements PageLike {
  currentUrl = "https://prestamype.com/app/inversionista/portafolio";
  html =
    '<main data-page="portfolio"><span data-field="available-balance">S/ 50,00</span></main>';
  readonly visits: string[] = [];
  readonly actions: string[] = [];
  statusByPath: Record<string, number> = {};
  listHtml = cards([{ id: "one", risk: "A", annualReturn: "16,50%" }]);
  detailHtml: Record<string, string> = { one: detail("one") };
  authenticated = true;
  captcha = false;
  sortConfirmation = "Retorno mayor";
  neverContent = false;
  contentGate: Promise<void> | null = null;
  routeHandler:
    | ((
        route: { abort(): Promise<void>; continue(): Promise<void> },
        request: { resourceType(): string; url(): string },
      ) => Promise<void>)
    | undefined;

  async goto(url: string): Promise<{ status(): number } | null> {
    this.visits.push(url);
    this.currentUrl = url;
    const path = new URL(url).pathname;
    if (path.endsWith("/oportunidades")) this.html = this.listHtml;
    else if (path.includes("/oportunidades/"))
      this.html = this.detailHtml[path.split("/").at(-1)!] ?? "";
    return { status: () => this.statusByPath[path] ?? 200 };
  }
  url(): string {
    return this.currentUrl;
  }
  async content(): Promise<string> {
    if (this.neverContent) return await new Promise<string>(() => undefined);
    if (this.contentGate !== null) await this.contentGate;
    return this.html;
  }
  locator(selector: string): LocatorLike {
    this.actions.push(selector);
    if (selector === '[data-page="authenticated"]')
      return new FakeLocator(this.authenticated);
    if (selector === '[data-challenge="captcha"]')
      return new FakeLocator(this.captcha);
    if (selector === '[data-action="sort-return-desc"]')
      return new FakeLocator(true, "Retorno mayor");
    if (selector === '[data-state="sort-return-desc"]')
      return new FakeLocator(
        this.sortConfirmation !== "",
        this.sortConfirmation,
      );
    if (selector.startsWith('[data-filter-risk="'))
      return new FakeLocator(true, selector);
    return new FakeLocator(false);
  }
  async route(
    _pattern: string,
    handler: NonNullable<FakePage["routeHandler"]>,
  ): Promise<void> {
    this.routeHandler = handler;
  }
  setDefaultNavigationTimeout(timeoutMs: number): void {
    expect(timeoutMs).toBe(12_000);
  }
}

function harness(page = new FakePage(), now: () => number = () => 0) {
  const contextOptions: unknown[] = [];
  let pageCount = 0;
  let contextCloses = 0;
  let browserCloses = 0;
  const context: BrowserContextLike = {
    newPage: async () => {
      pageCount += 1;
      return page;
    },
    close: async () => {
      contextCloses += 1;
    },
  };
  const browser: BrowserLike = {
    newContext: async (options) => {
      contextOptions.push(options);
      return context;
    },
    close: async () => {
      browserCloses += 1;
    },
  };
  const launcher: BrowserLauncher = { launch: async () => browser };
  const client = new PrestamypeClient({
    launcher,
    storageState: { cookies: [], origins: [] },
    now,
    deadlineMs: 25_000,
  });
  return {
    client,
    page,
    contextOptions,
    counts: () => ({ pageCount, contextCloses, browserCloses }),
  };
}

describe("safe browser policy", () => {
  it("blocks heavy resources and every third-party request", () => {
    for (const kind of ["image", "font", "media"])
      expect(shouldBlockResource(kind, "https://prestamype.com/a")).toBe(true);
    expect(
      shouldBlockResource("script", "https://google-analytics.com/a.js"),
    ).toBe(true);
    expect(shouldBlockResource("xhr", "https://evil.example/api")).toBe(true);
    for (const kind of ["document", "script", "xhr", "fetch"])
      expect(shouldBlockResource(kind, "https://prestamype.com/app")).toBe(
        false,
      );
  });

  it("rejects unsafe navigation and prohibited interaction names", () => {
    for (const name of [
      "Invertir",
      "reservar ahora",
      "PAGAR",
      "Confirmar inversión",
    ])
      expect(() => assertAllowedInteraction({ kind: "click", name })).toThrow(
        PageStructureError,
      );
    expect(() =>
      assertAllowedInteraction({ kind: "click", name: "cualquier botón" }),
    ).toThrow(PageStructureError);
    expect(() =>
      assertAllowedInteraction({ kind: "click", name: "Retorno mayor" }),
    ).not.toThrow();
  });
});

describe("PrestamypeClient", () => {
  it("uses one fixed, headless context and closes idempotently", async () => {
    const h = harness();
    await h.client.getPortfolio();
    await h.client.getPortfolio();
    await h.client.close();
    await h.client.close();
    expect(h.contextOptions).toEqual([
      {
        locale: "es-PE",
        timezoneId: "America/Lima",
        viewport: { width: 1280, height: 720 },
        storageState: { cookies: [], origins: [] },
      },
    ]);
    expect(h.counts()).toEqual({
      pageCount: 1,
      contextCloses: 1,
      browserCloses: 1,
    });
  });

  it("orders, filters allowlisted risks, cuts off below 15%, and opens details sequentially", async () => {
    const h = harness();
    h.page.listHtml = cards([
      { id: "one", risk: "A", annualReturn: "18,00%" },
      { id: "two", risk: "B", annualReturn: "15,00%" },
      { id: "low", risk: "C", annualReturn: "14,99%" },
      { id: "after", risk: "A", annualReturn: "19,00%" },
    ]);
    h.page.detailHtml = { one: detail("one"), two: detail("two") };
    const result = await h.client.listEligibleOpportunities(config, {});
    expect(result.map((item) => item.id)).toEqual(["one", "two"]);
    expect(h.page.visits.map((url) => new URL(url).pathname)).toEqual([
      "/app/inversionista/oportunidades",
      "/app/inversionista/oportunidades/one",
      "/app/inversionista/oportunidades/two",
    ]);
    expect(
      h.page.actions.some((selector) =>
        /invertir|reservar|pagar|confirmar/i.test(selector),
      ),
    ).toBe(false);
  });

  it("skips unchanged visible cards", async () => {
    const h = harness();
    const [summary] = (
      await import("../../src/browser/parsers.js")
    ).parseOpportunityCards(h.page.listHtml);
    const result = await h.client.listEligibleOpportunities(config, {
      one: summaryFingerprint(summary!),
    });
    expect(result).toEqual([]);
    expect(h.page.visits).toHaveLength(1);
  });

  it("uses the same visible-card fingerprint for a summary and its detail", async () => {
    const [summary] = (
      await import("../../src/browser/parsers.js")
    ).parseOpportunityCards(
      cards([{ id: "one", risk: "A", annualReturn: "16,50%" }]),
    );
    const opportunity = (
      await import("../../src/browser/parsers.js")
    ).parseOpportunityDetail(detail("one"), summary!);
    expect(summaryFingerprint(summary!)).toBe(
      opportunityFingerprint(opportunity),
    );
    expect(
      opportunityFingerprint({ ...opportunity, dueAt: "2030-01-01" }),
    ).toBe(opportunityFingerprint(opportunity));
  });

  it("reopens only when visible card material changes", async () => {
    const h = harness();
    const { parseOpportunityCards, parseOpportunityDetail } =
      await import("../../src/browser/parsers.js");
    const [summary] = parseOpportunityCards(h.page.listHtml);
    const persisted = opportunityFingerprint(
      parseOpportunityDetail(detail("one"), summary!),
    );
    expect(
      await h.client.listEligibleOpportunities(config, { one: persisted }),
    ).toEqual([]);
    h.page.listHtml = cards([{ id: "one", risk: "A", annualReturn: "17,00%" }]);
    expect(
      (
        await h.client.listEligibleOpportunities(config, { one: persisted })
      ).map((x) => x.id),
    ).toEqual(["one"]);
  });

  it.each([
    ["captcha", SessionChallengeError],
    ["login", SessionExpiredError],
    ["rate", RateLimitError],
    ["sort", PageStructureError],
  ] as const)(
    "raises a safe typed error for %s",
    async (scenario, ErrorType) => {
      const h = harness();
      if (scenario === "captcha") h.page.captcha = true;
      if (scenario === "login")
        h.page.currentUrl = "https://prestamype.com/login";
      if (scenario === "rate")
        h.page.statusByPath["/app/inversionista/oportunidades"] = 429;
      if (scenario === "sort") h.page.sortConfirmation = "";
      if (scenario === "login")
        h.page.goto = async () => ({ status: () => 200 });
      const promise = h.client.listEligibleOpportunities(config, {});
      await expect(promise).rejects.toBeInstanceOf(ErrorType);
      await expect(
        promise.catch((error: Error) => error.message),
      ).resolves.not.toMatch(/<html|cookie|authorization/i);
    },
  );

  it("treats a missing authenticated DOM marker as a structure change", async () => {
    const h = harness();
    h.page.authenticated = false;
    await expect(
      h.client.listEligibleOpportunities(config, {}),
    ).rejects.toBeInstanceOf(PageStructureError);
  });

  it("checks the total deadline before every navigation/action", async () => {
    let tick = 0;
    const h = harness(new FakePage(), () => (tick += 10_000));
    await expect(
      h.client.listEligibleOpportunities(config, {}),
    ).rejects.toBeInstanceOf(ScanDeadlineError);
    expect(h.page.visits.length).toBeLessThanOrEqual(1);
  });

  it("times out an actually hung Playwright operation near the deadline", async () => {
    vi.useFakeTimers();
    const h = harness(new FakePage(), () => Date.now());
    h.page.neverContent = true;
    const promise = h.client.listEligibleOpportunities(config, {});
    const assertion = expect(promise).rejects.toBeInstanceOf(ScanDeadlineError);
    await vi.advanceTimersByTimeAsync(25_001);
    await assertion;
    expect(h.counts()).toEqual({
      pageCount: 1,
      contextCloses: 1,
      browserCloses: 1,
    });
  });

  it("checks authentication again after each detail navigation", async () => {
    const h = harness();
    const originalGoto = h.page.goto.bind(h.page);
    h.page.goto = async (url) => {
      const response = await originalGoto(url);
      if (url.endsWith("/one")) h.page.captcha = true;
      return response;
    };
    await expect(
      h.client.listEligibleOpportunities(config, {}),
    ).rejects.toBeInstanceOf(SessionChallengeError);
  });

  it("treats a missing auth marker after detail navigation as a DOM change", async () => {
    const h = harness();
    const originalGoto = h.page.goto.bind(h.page);
    h.page.goto = async (url) => {
      const response = await originalGoto(url);
      if (url.endsWith("/one")) h.page.authenticated = false;
      return response;
    };
    await expect(
      h.client.listEligibleOpportunities(config, {}),
    ).rejects.toBeInstanceOf(PageStructureError);
  });

  it("aggregates visible portfolio exposure rows", async () => {
    const h = harness();
    h.page.html = `<main data-page="portfolio">
      <span data-field="available-balance">S/ 50,00</span><span data-field="active-total">S/ 300,00</span>
      <div data-portfolio-exposure><span data-field="tax-id">20123456789</span><span data-field="amount">S/ 100,00</span></div>
      <div data-portfolio-exposure><span data-field="tax-id">20123456789</span><span data-field="amount">S/ 200,00</span></div>
    </main>`;
    expect(await h.client.getPortfolio()).toEqual({
      availableBalanceCents: 5_000,
      activeTotalCents: 30_000,
      exposureByTaxId: { "20123456789": 30_000 },
    });
  });

  it("does not describe a positive portfolio as known when exposure rows are absent", async () => {
    const h = harness();
    h.page.html = `<main data-page="portfolio"><span data-field="active-total">S/ 300,00</span></main>`;
    expect(await h.client.getPortfolio()).toEqual({
      availableBalanceCents: null,
      activeTotalCents: null,
      exposureByTaxId: {},
    });
  });

  it("rejects malformed visible portfolio exposure", async () => {
    const h = harness();
    h.page.html = `<main><span data-field="active-total">S/ 10,00</span>
      <div data-portfolio-exposure><span data-field="tax-id">not-a-ruc</span><span data-field="amount">S/ 10,00</span></div></main>`;
    await expect(h.client.getPortfolio()).rejects.toBeInstanceOf(
      PageStructureError,
    );
  });

  it("shares concurrent initialization", async () => {
    const h = harness();
    await Promise.all([h.client.getPortfolio(), h.client.getPortfolio()]);
    expect(h.contextOptions).toHaveLength(1);
    expect(h.counts().pageCount).toBe(1);
  });

  it("serializes concurrent public page operations without DOM interleaving", async () => {
    const h = harness();
    let release!: () => void;
    h.page.contentGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = h.client.getPortfolio();
    await vi.waitFor(() => expect(h.page.visits).toHaveLength(1));
    const second = h.client.getPortfolio();
    await Promise.resolve();
    expect(h.page.visits).toHaveLength(1);
    release();
    await Promise.all([first, second]);
    expect(h.page.visits).toHaveLength(2);
  });

  it("still closes the browser when context close throws", async () => {
    const h = harness();
    await h.client.getPortfolio();
    const context = (h.client as unknown as { context: BrowserContextLike })
      .context;
    context.close = async () => {
      throw new Error("context close failed");
    };
    await expect(h.client.close()).rejects.toThrow("context close failed");
    expect(h.counts().browserCloses).toBe(1);
  });

  it("close waits for initialization in flight and prevents later use", async () => {
    const page = new FakePage();
    let release!: (browser: BrowserLike) => void;
    let browserCloses = 0;
    const browser: BrowserLike = {
      newContext: async () => ({
        newPage: async () => page,
        close: async () => undefined,
      }),
      close: async () => {
        browserCloses += 1;
      },
    };
    const launcher: BrowserLauncher = {
      launch: async () =>
        await new Promise<BrowserLike>((resolve) => {
          release = resolve;
        }),
    };
    const client = new PrestamypeClient({ launcher, storageState: {} });
    const use = client.getPortfolio();
    const useRejected = expect(use).rejects.toBeInstanceOf(PageStructureError);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const closing = client.close();
    release(browser);
    await useRejected;
    await closing;
    expect(browserCloses).toBe(1);
    await expect(client.getPortfolio()).rejects.toBeInstanceOf(
      PageStructureError,
    );
  });

  it("does not await a hung initialization after the public deadline and cleans up if it later resolves", async () => {
    vi.useFakeTimers();
    let release!: (browser: BrowserLike) => void;
    let browserCloses = 0;
    const browser: BrowserLike = {
      newContext: async () => ({
        newPage: async () => new FakePage(),
        close: async () => undefined,
      }),
      close: async () => {
        browserCloses += 1;
      },
    };
    const launcher: BrowserLauncher = {
      launch: async () =>
        await new Promise<BrowserLike>((resolve) => {
          release = resolve;
        }),
    };
    const client = new PrestamypeClient({
      launcher,
      storageState: {},
      now: () => Date.now(),
      deadlineMs: 25_000,
    });
    const use = client.getPortfolio();
    const rejected = expect(use).rejects.toBeInstanceOf(ScanDeadlineError);
    await vi.advanceTimersByTimeAsync(25_001);
    await rejected;
    await expect(client.close()).resolves.toBeUndefined();
    release(browser);
    await vi.runAllTimersAsync();
    await Promise.resolve();
    expect(browserCloses).toBe(1);
  });
});

afterEach(() => vi.useRealTimers());
