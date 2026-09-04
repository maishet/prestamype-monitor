import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  PrestamypeClient,
  assertAllowedInteraction,
  opportunityFingerprint,
  opportunityRowFingerprint,
  opportunityRowKey,
  rowRisk,
  shouldBlockResource,
  type BrowserLauncher,
  type LocatorLike,
  type PageLike,
  reapBrowserProcesses,
} from "../../src/browser/prestamype-client.js";
import { parseOpportunityRows } from "../../src/browser/live-parsers.js";
import {
  PageStructureError,
  SessionExpiredError,
} from "../../src/browser/errors.js";
import type { MonitorConfig } from "../../src/domain/types.js";

const fixture = (name: string): string =>
  readFileSync(resolve("tests/fixtures/live", name), "utf8");

const TABLE = fixture("opportunities-table.html");
const PANEL = fixture("panel-invertir-riesgo-letra.html");
const DEUDOR = fixture("panel-deudor.html");
const PROVEEDOR = fixture("panel-proveedor.html");
const PORTFOLIO = fixture("mis-inversiones.html");

const config: MonitorConfig = {
  allowedRisks: ["A+", "A", "B", "C", "PROTEGIDA"],
  minimumAnnualReturnPct: 12,
  currency: "PEN",
  allowedCurrencies: ["PEN", "USD"],
  minimumInvestmentCents: 10_000,
  highPriorityScore: 80,
  reviewScore: 70,
};

interface FakePageOptions {
  readonly onClick?: (selector: string) => void;
  readonly html?: () => string;
  readonly table?: string;
}

/**
 * A page whose content is the captured markup. Clicks are recorded and drive
 * the same state transitions the real slide-over does.
 */
function createFakePage(options: FakePageOptions = {}) {
  const clicks: string[] = [];
  const table = options.table ?? TABLE;
  let current = table;
  let url = "https://www.prestamype.com/app/inversionista/oportunidades";

  const setHtml = (html: string): void => {
    current = html;
  };

  const locator = (selector: string): LocatorLike => {
    const self: LocatorLike = {
      async click() {
        clicks.push(selector);
        options.onClick?.(selector);
        if (selector.includes("cell-content")) setHtml(PANEL);
        else if (selector.includes("Deudor")) setHtml(DEUDOR);
        else if (selector.includes("Proveedor")) setHtml(PROVEEDOR);
        else if (selector.includes("icon-close")) setHtml(table);
      },
      async isVisible() {
        if (selector.includes("captcha")) return false;
        if (selector.includes("next-button")) return false;
        if (selector.includes("panel-main")) return current === PANEL;
        return true;
      },
      async textContent() {
        if (selector.includes("multi-select-trigger"))
          return "Ordenar por: Retorno mayor";
        if (selector.includes("cell-content")) return "METALVAL";
        if (selector.includes("tab-item")) return "Deudor";
        return "";
      },
      nth: () => self,
      first: () => self,
      locator: (nested: string) => locator(`${selector} ${nested}`),
    };
    return self;
  };

  const page: PageLike = {
    async goto(target: string) {
      url = target;
      setHtml(target.includes("mis-inversiones") ? PORTFOLIO : table);
      return { status: () => 200 };
    },
    url: () => url,
    content: async () => options.html?.() ?? current,
    locator,
    route: async () => undefined,
    setDefaultNavigationTimeout: () => undefined,
    setDefaultTimeout: () => undefined,
  };
  return { page, clicks, setUrl: (value: string) => (url = value) };
}

function createLauncher(page: PageLike): BrowserLauncher {
  return {
    launch: async () => ({
      newContext: async () => ({
        newPage: async () => page,
        close: async () => undefined,
        setDefaultTimeout: () => undefined,
      }),
      close: async () => undefined,
    }),
  };
}

function createClient(page: PageLike, overrides: object = {}) {
  return new PrestamypeClient({
    launcher: createLauncher(page),
    storageState: {},
    deadlineMs: 60_000,
    sleep: async () => undefined,
    ...overrides,
  });
}

describe("shouldBlockResource", () => {
  it("allows the CloudFront bundle the single-page app is served from", () => {
    const asset = "https://d14bodb4yrsx8y.cloudfront.net/assets/e893ef9.js";
    // This is the regression that made every production scan evaluate zero
    // opportunities: blocking it stops Vue from ever rendering the table.
    expect(shouldBlockResource("script", asset)).toBe(false);
    expect(
      shouldBlockResource(
        "stylesheet",
        "https://d14bodb4yrsx8y.cloudfront.net/assets/css/d74978f.css",
      ),
    ).toBe(false);
    expect(shouldBlockResource("image", asset)).toBe(true);
  });

  it("allows the API host the table's rows actually come from", () => {
    // The app booted fine once CloudFront was allowed and then hung forever on
    // its loading row, because every data call goes to this other subdomain.
    for (const type of ["xhr", "fetch"])
      expect(
        shouldBlockResource(type, "https://api.prestamype.com/v1/auctions"),
      ).toBe(false);
    // Data only: no documents or scripts from the API host.
    for (const type of ["document", "script", "stylesheet"])
      expect(
        shouldBlockResource(type, "https://api.prestamype.com/whatever"),
      ).toBe(true);
  });

  it("blocks other prestamype subdomains that are not the app or its API", () => {
    expect(
      shouldBlockResource(
        "script",
        "https://creditos-hipotecarios.prestamype.com/x.js",
      ),
    ).toBe(true);
  });

  it("still allows the application's own documents and data calls", () => {
    for (const type of ["document", "script", "xhr", "fetch"])
      expect(shouldBlockResource(type, "https://www.prestamype.com/app")).toBe(
        false,
      );
    expect(
      shouldBlockResource("image", "https://www.prestamype.com/x.png"),
    ).toBe(true);
  });

  it("blocks every analytics and consent vendor on the page", () => {
    for (const vendor of [
      "https://www.hotjar.com/x.js",
      "https://www.facebook.com/tr",
      "https://consent.cookiebot.com/uc.js",
      "https://display.popt.in/x.js",
      "https://evil.example/x.js",
    ])
      expect(shouldBlockResource("script", vendor)).toBe(true);
  });
});

describe("assertAllowedInteraction", () => {
  it("refuses anything that could move money", () => {
    for (const name of [
      "Invertir",
      "Realizar inversión",
      "Realizar depósito",
      "Confirmar",
      "Pagar",
      "Retirar",
    ])
      expect(() => assertAllowedInteraction({ kind: "click", name })).toThrow(
        PageStructureError,
      );
  });

  it("allows the navigation controls the scan needs", () => {
    for (const name of ["Filtros", "Retorno mayor", "Deudor", "METALVAL", ""])
      expect(() =>
        assertAllowedInteraction({ kind: "click", name }),
      ).not.toThrow();
  });
});

describe("row identity", () => {
  const rows = parseOpportunityRows(TABLE);

  it("gives every row on the page a distinct stable key", () => {
    const keys = rows.map(opportunityRowKey);
    expect(new Set(keys).size).toBe(rows.length);
  });

  it("ignores funding moves too small for the site to even display", () => {
    const row = rows[0]!;
    // The table prints whole percent; re-opening a panel because funding went
    // from 34.31% to 34.34% was what kept the scan from ever skipping a row.
    const nudged = { ...row, fundedPct: row.fundedPct + 0.03 };
    expect(opportunityRowFingerprint(nudged)).toBe(
      opportunityRowFingerprint(row),
    );
    const moved = { ...row, fundedPct: row.fundedPct + 1.5 };
    expect(opportunityRowFingerprint(moved)).not.toBe(
      opportunityRowFingerprint(row),
    );
  });

  it("keeps the key stable while funding progresses", () => {
    const row = rows[0]!;
    const advanced = { ...row, fundedPct: row.fundedPct + 10 };
    expect(opportunityRowKey(advanced)).toBe(opportunityRowKey(row));
    expect(opportunityRowFingerprint(advanced)).not.toBe(
      opportunityRowFingerprint(row),
    );
  });

  it("reports protected rows as their own grade", () => {
    expect(rowRisk({ ...rows[0]!, protectedCapital: true, risk: null })).toBe(
      "PROTEGIDA",
    );
    expect(rowRisk(rows[0]!)).toBe("C");
  });
});

describe("PrestamypeClient scan", () => {
  let fake: ReturnType<typeof createFakePage>;

  beforeEach(() => {
    fake = createFakePage();
  });

  it("opens the client name, never the row or its Invertir button", async () => {
    const client = createClient(fake.page);
    client.beginScan();
    await client.listEligibleOpportunities(config, {});
    await client.close();
    const rowClicks = fake.clicks.filter((selector) =>
      selector.includes("row_table"),
    );
    expect(rowClicks.length).toBeGreaterThan(0);
    for (const selector of rowClicks) {
      expect(selector).toContain(".cell-content.client .label");
      expect(selector).not.toContain("action-column");
    }
  });

  it("returns opportunities built from the row and its panel", async () => {
    const client = createClient(fake.page);
    client.beginScan();
    const opportunities = await client.listEligibleOpportunities(config, {});
    await client.close();

    expect(opportunities.length).toBeGreaterThan(0);
    const first = opportunities[0]!;
    expect(first).toMatchObject({
      auctionCode: "M5dGmP0G",
      url: "https://www.prestamype.com/app/inversionista/oportunidades",
      currency: "PEN",
      annualReturnPct: 14.16,
      risk: "C",
      investmentType: "Factoring",
    });
    expect(first.debtorHistory).toMatchObject({ totalAuctions: 51 });
    expect(first.debtor.taxId).toBe("20123456789");
  });

  it("stops walking once returns drop below the configured floor", async () => {
    const client = createClient(fake.page);
    client.beginScan();
    const opportunities = await client.listEligibleOpportunities(
      { ...config, minimumAnnualReturnPct: 14 },
      {},
    );
    await client.close();
    // Only the 14.84% and the two 14.16% rows clear a 14% floor.
    expect(opportunities).toHaveLength(3);
  });

  it("reaches protected auctions only when they get their own floor", async () => {
    // The unfiltered table mixes protected rows (5-9%) among lettered ones.
    const unfiltered = fixture("panel-invertir-protegida.html");
    const rows = parseOpportunityRows(unfiltered);
    expect(rows.some((row) => row.protectedCapital)).toBe(true);

    const scan = async (extra: Partial<MonitorConfig>) => {
      const page = createFakePage({ table: unfiltered });
      const client = createClient(page.page);
      client.beginScan();
      const found = await client.listEligibleOpportunities(
        { ...config, minimumAnnualReturnPct: 14, ...extra },
        {},
      );
      await client.close();
      return { found, clicks: page.clicks };
    };

    const strict = await scan({});
    const lenient = await scan({ minimumProtectedAnnualReturnPct: 5 });
    // A single floor stops the walk early; the protected floor reads deeper.
    expect(lenient.clicks.length).toBeGreaterThan(strict.clicks.length);
  });

  it("skips a row whose visible values have not changed", async () => {
    const rows = parseOpportunityRows(TABLE);
    const known = Object.fromEntries(
      rows.map((row) => [
        opportunityRowKey(row),
        {
          visibleFingerprint: opportunityRowFingerprint(row),
          detailCheckedAt: new Date().toISOString(),
        },
      ]),
    );
    const client = createClient(fake.page);
    client.beginScan();
    const opportunities = await client.listEligibleOpportunities(config, known);
    await client.close();
    expect(opportunities).toEqual([]);
    expect(fake.clicks.filter((s) => s.includes("row_table"))).toEqual([]);
  });

  it("reopens a row once the detail refresh interval has passed", async () => {
    const rows = parseOpportunityRows(TABLE);
    const known = Object.fromEntries(
      rows.map((row) => [
        opportunityRowKey(row),
        {
          visibleFingerprint: opportunityRowFingerprint(row),
          detailCheckedAt: new Date(Date.now() - 3_600_000).toISOString(),
        },
      ]),
    );
    const client = createClient(fake.page);
    client.beginScan();
    const opportunities = await client.listEligibleOpportunities(config, known);
    await client.close();
    expect(opportunities.length).toBeGreaterThan(0);
  });

  it("hashes a stored opportunity the same way as the row it came from", async () => {
    // C & M SERVICENTROS: the row the panel fixture belongs to. Its bar width
    // (26.13%) has to hash the same as collected/total from the panel.
    const row = parseOpportunityRows(TABLE).find(
      (candidate) => candidate.commercialName === "C & M SERVICENTROS",
    )!;
    const opportunity = {
      id: opportunityRowKey(row),
      risk: rowRisk(row),
      annualReturnPct: row.annualReturnPct,
      fundedAmountCents: 4_677_257,
      totalAmountCents: 17_900_810,
    } as Parameters<typeof opportunityFingerprint>[0];
    // If these drifted apart the scan would reopen every panel forever.
    expect(opportunityFingerprint(opportunity)).toBe(
      opportunityRowFingerprint(row),
    );
  });

  it("leaves the supplier anonymous instead of copying the debtor", async () => {
    const client = createClient(fake.page);
    client.beginScan();
    const [opportunity] = await client.listEligibleOpportunities(config, {});
    await client.close();
    // The site publishes the debtor's name and RUC but only the supplier's
    // industry, so labelling the debtor as supplier would be a real mistake.
    expect(opportunity!.debtor.legalName).not.toBe("");
    expect(opportunity!.debtor.taxId).toBe("20123456789");
    expect(opportunity!.supplier.legalName).toBe("");
    expect(opportunity!.supplier.taxId).toBeNull();
    // The supplier's history is published even though its identity is not.
    expect(opportunity!.supplierHistory).toMatchObject({ paidOnTime: 260 });
  });

  it("reads the available balance out of the detail panel", async () => {
    const client = createClient(fake.page);
    client.beginScan();
    expect(client.availableBalanceCents()).toBeNull();
    await client.listEligibleOpportunities(config, {});
    await client.close();
    expect(client.availableBalanceCents()).toBe(0);
  });
});

describe("PrestamypeClient portfolio", () => {
  it("sums active exposure by normalized party and flags collections", async () => {
    const fake = createFakePage();
    const client = createClient(fake.page);
    client.beginScan();
    const portfolio = await client.getPortfolio();
    await client.close();

    expect(portfolio.collectionConflicts).toEqual([
      {
        party: { legalName: "CORPORACION LERIBE S.A.C.", taxId: null },
        state: "Por cobrar",
        stage: "Cobranza administrativa I",
      },
    ]);
    // Only "Por cobrar" and "En proceso" positions are still at risk.
    expect(portfolio.exposureByParty["SUPERDEPORTE PLUS PERU SAC"]).toBe(
      680_752,
    );
    expect(portfolio.exposureByParty["HAUG S A"]).toBeUndefined();
    expect(portfolio.activeTotalCents).toBeGreaterThan(0);
  });
});

describe("PrestamypeClient failure handling", () => {
  it("reports an expired session when the app redirects to the login page", async () => {
    const fake = createFakePage();
    fake.page.goto = async () => {
      fake.setUrl("https://www.prestamype.com/iniciar-sesion");
      return { status: () => 200 };
    };
    const client = createClient(fake.page);
    client.beginScan();
    await expect(client.listEligibleOpportunities(config, {})).rejects.toThrow(
      SessionExpiredError,
    );
    await client.close();
  });

  it("checks visibility before reading text, which auto-waits", async () => {
    // textContent() blocks for the whole locator timeout on a missing element.
    // Asking for it first turned an absent sort control into a failed scan.
    const order: string[] = [];
    const fake = createFakePage();
    const original = fake.page.locator;
    fake.page.locator = (selector: string) => {
      const inner = original(selector);
      return {
        ...inner,
        isVisible: async () => {
          order.push(`isVisible:${selector}`);
          return inner.isVisible();
        },
        textContent: async () => {
          order.push(`textContent:${selector}`);
          return inner.textContent();
        },
      };
    };
    const client = createClient(fake.page);
    client.beginScan();
    await client.listEligibleOpportunities(config, {});
    await client.close();
    const sortCalls = order.filter((entry) => entry.includes("select-sort"));
    expect(sortCalls[0]).toMatch(/^isVisible:/u);
  });

  it("does not hang when the table never stops loading", async () => {
    const loading = fixture("opportunities-table-loading.html");
    const fake = createFakePage({ html: () => loading });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const now = vi.fn(() => 0);
    let clock = 0;
    now.mockImplementation(() => clock);
    const client = createClient(fake.page, {
      now,
      sleep: async () => {
        clock += 250;
      },
      deadlineMs: 60_000,
    });
    client.beginScan();
    // The wait must run out its budget and move on, not throw a deadline error.
    const opportunities = await client.listEligibleOpportunities(config, {});
    await client.close();
    expect(opportunities).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("closes only the browser and lets it take its context along", async () => {
    const order: string[] = [];
    const fake = createFakePage();
    fake.page.close = async () => {
      order.push("page");
    };
    const launcher: BrowserLauncher = {
      launch: async () => ({
        newContext: async () => ({
          newPage: async () => fake.page,
          close: async () => {
            order.push("context");
          },
          setDefaultTimeout: () => undefined,
        }),
        close: async () => {
          order.push("browser");
        },
      }),
    };
    const client = new PrestamypeClient({
      launcher,
      storageState: {},
      deadlineMs: 60_000,
      sleep: async () => undefined,
    });
    client.beginScan();
    await client.getPortfolio();
    await client.close();
    // Closing the context first is the step that hung on Lambda, and when it
    // hung the browser process was never closed at all.
    expect(order).toEqual(["browser"]);
  });
  it("reports the kill when the browser will not close in time", async () => {
    const fake = createFakePage();
    const launcher: BrowserLauncher = {
      launch: async () => ({
        newContext: async () => ({
          newPage: async () => fake.page,
          close: async () => undefined,
          setDefaultTimeout: () => undefined,
        }),
        close: () => new Promise<void>(() => undefined),
      }),
    };
    let clock = 0;
    const client = new PrestamypeClient({
      launcher,
      storageState: {},
      deadlineMs: 60_000,
      now: () => clock,
      sleep: async () => {
        clock += 250;
      },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    client.beginScan();
    await client.getPortfolio();
    clock += 60_000;
    vi.useFakeTimers();
    try {
      const closing = client.close();
      await vi.advanceTimersByTimeAsync(4_000);
      await expect(closing).resolves.toBeUndefined();
      // The scan must never end believing a wedged Chromium shut itself down:
      // that belief is what let eight of them pile up into the 2 GB ceiling.
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("had to be killed"),
        expect.stringContaining("reaped"),
      );
    } finally {
      vi.useRealTimers();
      warn.mockRestore();
    }
  });
  it("never reaps anything outside Lambda", () => {
    // The sweep matches any Chromium in the container. On a developer machine
    // that is the browser they have open, so the guard is not a nicety.
    expect(process.env.AWS_LAMBDA_FUNCTION_NAME).toBeUndefined();
    expect(reapBrowserProcesses()).toBe(0);
  });
  it("still closes the browser when context close throws", async () => {
    const fake = createFakePage();
    const launcher: BrowserLauncher = {
      launch: async () => ({
        newContext: async () => ({
          newPage: async () => fake.page,
          close: async () => {
            throw new Error("Target page, context or browser has been closed");
          },
          setDefaultTimeout: () => undefined,
        }),
        close: async () => undefined,
      }),
    };
    const client = new PrestamypeClient({
      launcher,
      storageState: {},
      deadlineMs: 60_000,
      sleep: async () => undefined,
    });
    client.beginScan();
    await client.getPortfolio();
    await expect(client.close()).resolves.toBeUndefined();
  });

  it("refuses to work after it has been closed", async () => {
    const fake = createFakePage();
    const client = createClient(fake.page);
    await client.close();
    await expect(client.getPortfolio()).rejects.toThrow(PageStructureError);
  });
});
