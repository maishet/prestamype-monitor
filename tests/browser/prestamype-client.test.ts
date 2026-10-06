import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { load } from "cheerio";
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
const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

/** The captured panel, re-headed as if it had been opened for this row. */
function panelFor(row: { commercialName: string; legalName: string }): string {
  return PANEL.replace(
    /<p class="title">[^<]*<\/p>/u,
    `<p class="title">${escapeHtml(row.commercialName)}</p>`,
  ).replace(
    /<p class="sub-title">[^<]*<\/p>/u,
    `<p class="sub-title">${escapeHtml(row.legalName)}</p>`,
  );
}

/** A capture taken with the slide-over open, as the board shows it closed. */
function withoutPanel(html: string): string {
  if (!html.includes('class="panel-main"')) return html;
  const $ = load(html);
  $(".container-panel").remove();
  return $.html();
}

function createFakePage(options: FakePageOptions = {}) {
  const clicks: string[] = [];
  const table = withoutPanel(options.table ?? TABLE);
  const rows = parseOpportunityRows(table, { logSkipped: false });
  let current = table;
  let url = "https://www.prestamype.com/app/inversionista/oportunidades";

  const setHtml = (html: string): void => {
    current = html;
  };

  // The row a click selector points at: by the company name the client asks
  // for, else by position, else the panel fixture's own row.
  const rowFor = (selector: string) => {
    const named = /text-is\("((?:[^"\\]|\\.)*)"\)/u.exec(selector);
    if (named !== null) {
      const name = named[1]!.replaceAll('\\"', '"').replaceAll("\\\\", "\\");
      return rows.find((row) => row.commercialName === name);
    }
    const position = /nth=(\d+)/u.exec(selector);
    return position === null ? rows[1] : rows[Number(position[1])];
  };

  const locator = (selector: string): LocatorLike => {
    const self: LocatorLike = {
      async click() {
        clicks.push(selector);
        options.onClick?.(selector);
        if (selector.includes("cell-content"))
          setHtml(panelFor(rowFor(selector) ?? rows[1]!));
        else if (selector.includes("Deudor")) setHtml(DEUDOR);
        else if (selector.includes("Proveedor")) setHtml(PROVEEDOR);
        else if (selector.includes("icon-close")) setHtml(table);
      },
      async isVisible() {
        if (
          selector.includes("generic-modal-overlay") ||
          selector.includes("slider-modal--first-investment") ||
          selector.includes('[role="dialog"]') ||
          selector.includes("dialog[open]")
        )
          return false;
        if (selector.includes("captcha")) return false;
        if (selector.includes("next-button")) return false;
        if (selector.includes("panel-main"))
          return current.includes('class="panel-main"');
        return true;
      },
      async textContent() {
        if (selector.includes("multi-select-trigger"))
          return "Ordenar por: Retorno mayor";
        if (selector.includes("cell-content")) return "METALVAL";
        if (selector.includes("tab-item")) return "Deudor";
        return "";
      },
      nth: (index: number) => locator(`${selector} >> nth=${index}`),
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

  it("allows company names containing investment words but blocks exact money actions", () => {
    expect(() =>
      assertAllowedInteraction({
        kind: "click",
        name: "INVERSIONES JORDIE S.A.",
      }),
    ).not.toThrow();
    for (const name of ["Invertir", "Realizar inversión", "Depositar"]) {
      expect(() => assertAllowedInteraction({ kind: "click", name })).toThrow(
        PageStructureError,
      );
    }
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
  it.each([
    ["CAPTCHA", true],
    ["Inicia sesión", true],
    ["Aceptar términos y condiciones", true],
    ["Campaña sin cierre", false],
  ])("does not interact with blocking screen %s", async (message, hasClose) => {
    const fake = createFakePage();
    const original = fake.page.locator;
    const click = vi.fn();
    fake.page.locator = (selector) => {
      if (!selector.includes("generic-modal-overlay"))
        return original(selector);
      return {
        isVisible: async () =>
          selector.includes("icon-close") || selector.includes("button")
            ? hasClose
            : true,
        textContent: async () => message,
        click,
      };
    };
    const client = createClient(fake.page);
    try {
      await expect(
        client.listEligibleOpportunities(config, {}),
      ).rejects.toThrow();
      expect(click).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });

  it.each(["Campa�a de septiembre", "Campa�a X", "Aviso informativo"])(
    "dismisses %s before interacting with the table",
    async (title) => {
      let open = true;
      const fake = createFakePage();
      const content = fake.page.content;
      fake.page.content = async () =>
        (await content()) +
        (open
          ? '<div class="slider-modal--first-investment"><button class="actions-button"><i class="icon-close"></i></button><button>¡Participa ahora!</button></div>'
          : "");
      const original = fake.page.locator;
      const actions: string[] = [];
      fake.page.locator = (selector) => {
        const locator = original(selector);
        delete locator.first;
        if (selector.includes("generic-modal-overlay")) {
          return {
            ...locator,
            isVisible: async () => open,
            textContent: async () =>
              selector.includes("button") ? "Cerrar" : title,
            click: async () => {
              actions.push(selector);
              open = false;
            },
          };
        }
        return {
          ...locator,
          click: async () => {
            if (open) throw new Error("Campaign intercepts pointer events");
            await locator.click();
          },
        };
      };
      const client = createClient(fake.page);
      try {
        await client.listEligibleOpportunities(config, {});
        expect(open).toBe(false);
        expect(actions).toHaveLength(1);
        // The production path first clicks the campaign backdrop; this also
        // covers the real page variant where the nested icon is intercepted.
        expect(actions[0]).toContain("generic-modal-overlay");
      } finally {
        await client.close();
      }
    },
  );

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

  it("treats a re-rendered Deudor tab as optional enrichment", async () => {
    const original = fake.page.locator;
    fake.page.locator = (selector) => {
      const locator = original(selector);
      if (!selector.includes(":has-text('Deudor')")) return locator;
      return {
        ...locator,
        async click() {
          throw new PageStructureError(
            "MISSING_FIELD",
            "interaction.panel.tab.Deudor",
          );
        },
      };
    };
    const client = createClient(fake.page);
    client.beginScan();
    const opportunities = await client.listEligibleOpportunities(config, {});
    await client.close();

    expect(opportunities.length).toBeGreaterThan(0);
    expect(opportunities[0]?.debtorHistory).toBeNull();
  });

  it("stops after Invertir when the detail policy rejects further enrichment", async () => {
    const client = createClient(fake.page);
    client.beginScan();
    const opportunities = await client.listEligibleOpportunities(
      config,
      {},
      {
        needsDebtor: () => false,
        needsSupplier: () => false,
      },
    );
    await client.close();

    expect(opportunities.length).toBeGreaterThan(0);
    expect(fake.clicks.some((selector) => selector.includes("Deudor"))).toBe(
      false,
    );
    expect(fake.clicks.some((selector) => selector.includes("Proveedor"))).toBe(
      false,
    );
    expect(opportunities.every((item) => item.debtorHistory === null)).toBe(
      true,
    );
  });

  it("loads Deudor but skips Proveedor when its maximum cannot change the decision", async () => {
    const client = createClient(fake.page);
    client.beginScan();
    const opportunities = await client.listEligibleOpportunities(
      config,
      {},
      {
        needsDebtor: () => true,
        needsSupplier: () => false,
      },
    );
    await client.close();

    expect(fake.clicks.some((selector) => selector.includes("Deudor"))).toBe(
      true,
    );
    expect(fake.clicks.some((selector) => selector.includes("Proveedor"))).toBe(
      false,
    );
    expect(opportunities[0]?.debtorHistory).not.toBeNull();
    expect(opportunities[0]?.supplierHistory).toBeNull();
  });

  it("returns completed details before the remaining scan budget becomes unsafe", async () => {
    let clock = 0;
    let closedPanels = 0;
    const page = createFakePage({
      onClick: (selector) => {
        if (!selector.includes("icon-close")) return;
        closedPanels += 1;
        if (closedPanels === 1) clock = 41_000;
      },
    });
    const client = createClient(page.page, {
      now: () => clock,
      deadlineMs: 60_000,
    });
    client.beginScan();

    const opportunities = await client.listEligibleOpportunities(config, {});
    await client.close();

    expect(opportunities).toHaveLength(1);
    expect(closedPanels).toBe(1);
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

  it("reopens an unchanged row marked with incomplete detail", async () => {
    const row = parseOpportunityRows(TABLE)[0]!;
    const known = {
      [opportunityRowKey(row)]: {
        visibleFingerprint: opportunityRowFingerprint(row),
        detailCheckedAt: new Date().toISOString(),
        alerted: false,
        detailIncomplete: true,
      },
    };
    const client = createClient(fake.page);
    client.beginScan();
    const opportunities = await client.listEligibleOpportunities(config, known);
    await client.close();
    expect(opportunities.length).toBeGreaterThan(0);
    expect(fake.clicks.some((s) => s.includes("row_table"))).toBe(true);
  });

  it("waits for this row's panel instead of reading the one still closing", async () => {
    // Live sequence: the slide-over for row A is still in the DOM, auction
    // code and all, when row B is clicked. Reading it stored A's auction
    // under B's key, so B was never evaluated and A was saved several times.
    const rows = parseOpportunityRows(TABLE, { logSkipped: false });
    let opened: (typeof rows)[number] | undefined;
    let closing: string | null = null;
    let lingeringReads = 0;
    const fake = createFakePage({
      onClick: (selector) => {
        if (selector.includes("cell-content")) {
          const position = /nth=(\d+)/u.exec(selector);
          opened = position === null ? undefined : rows[Number(position[1])];
        } else if (selector.includes("icon-close") && opened !== undefined) {
          // The Invertir panel stays in the DOM for a while after its close
          // is clicked, whatever else gets clicked meanwhile.
          closing = panelFor(opened);
          lingeringReads = 3;
        }
      },
    });
    const content = fake.page.content;
    fake.page.content = async () => {
      if (closing !== null && lingeringReads > 0) {
        lingeringReads -= 1;
        return closing;
      }
      return content();
    };
    const client = createClient(fake.page);
    client.beginScan();
    const opportunities = await client.listEligibleOpportunities(
      { ...config, minimumAnnualReturnPct: 14 },
      {},
    );
    await client.close();
    const expected = rows
      .filter((row) => row.annualReturnPct >= 14)
      .map((row) => row.commercialName);
    expect(opportunities.map((item) => item.commercialName)).toEqual(expected);
  });

  it("lets the closing panel leave before clicking the next row", async () => {
    const events: string[] = [];
    let closingReads = 0;
    const fake = createFakePage({
      onClick: (selector) => {
        if (selector.includes("icon-close")) {
          events.push("click:close");
          closingReads = 2;
        } else if (selector.includes("cell-content")) events.push("click:row");
      },
    });
    const content = fake.page.content;
    fake.page.content = async () => {
      if (closingReads > 0) {
        closingReads -= 1;
        events.push("read:panel");
        return PANEL;
      }
      const html = await content();
      events.push(
        html.includes('class="panel-main"') ? "read:panel" : "read:table",
      );
      return html;
    };
    const client = createClient(fake.page);
    client.beginScan();
    await client.listEligibleOpportunities(
      { ...config, minimumAnnualReturnPct: 14 },
      {},
    );
    await client.close();
    const close = events.indexOf("click:close");
    const next = events.indexOf("click:row", close);
    expect(close).toBeGreaterThan(-1);
    expect(next).toBeGreaterThan(close);
    // The two stale reads and then the table, all before the next click.
    expect(events.slice(close + 1, next)).toEqual([
      "read:panel",
      "read:panel",
      "read:table",
    ]);
  });

  it("does not fail when a panel already disappeared before cleanup", async () => {
    const client = createClient(fake.page);
    client.beginScan();
    let visibilityChecks = 0;
    const page = {
      locator: () => ({
        isVisible: async () => visibilityChecks++ === 0,
        textContent: async () => "Cerrar",
        click: async () => undefined,
      }),
    } as unknown as PageLike;
    await expect(
      (
        client as unknown as {
          closePanel: (page: PageLike, deadline: number) => Promise<void>;
        }
      ).closePanel(page, Date.now() + 1_000),
    ).resolves.toBeUndefined();
    await client.close();
  });

  it("does not reopen an unchanged row however stale the detail is", async () => {
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
    // Age alone used to reopen the panel. Nothing the panel holds can move
    // without the table moving too, so the clock was buying nothing.
    expect(opportunities).toEqual([]);
    expect(fake.clicks.filter((s) => s.includes("row_table"))).toEqual([]);
  });

  it("never reopens a row that already sent its one alert", async () => {
    const rows = parseOpportunityRows(TABLE);
    const known = Object.fromEntries(
      rows.map((row) => [
        opportunityRowKey(row),
        {
          visibleFingerprint: opportunityRowFingerprint(row),
          // Long past the refresh interval, which used to be enough on its own
          // to reopen every panel: at a three-minute cadence that reopened one
          // in five scans for auctions whose message had already gone out.
          detailCheckedAt: new Date(Date.now() - 3_600_000).toISOString(),
          alerted: true,
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

  it("leaves an alerted row shut even when its funding moves", async () => {
    const rows = parseOpportunityRows(TABLE);
    const known = Object.fromEntries(
      rows.map((row) => [
        opportunityRowKey(row),
        // A stale hash means the table moved, which normally reopens the panel.
        // It cannot help here: the one message this auction gets has been sent,
        // so re-reading it only delays the scan.
        { visibleFingerprint: "stale", detailCheckedAt: "", alerted: true },
      ]),
    );
    const client = createClient(fake.page);
    client.beginScan();
    const opportunities = await client.listEligibleOpportunities(config, known);
    await client.close();
    expect(opportunities).toEqual([]);
  });

  it("reopens a row that moved and has never alerted", async () => {
    const rows = parseOpportunityRows(TABLE);
    const known = Object.fromEntries(
      rows.map((row) => [
        opportunityRowKey(row),
        { visibleFingerprint: "stale", detailCheckedAt: "", alerted: false },
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

  it("forces the safe sort controls after overlays have been dismissed", async () => {
    const fake = createFakePage();
    const original = fake.page.locator;
    fake.page.locator = (selector: string) => {
      const inner = original(selector);
      if (
        !selector.includes("select-sort") &&
        !selector.includes("multi-select-option")
      )
        return inner;
      return {
        ...inner,
        textContent: async () =>
          selector.includes("select-sort")
            ? "Ordenar por: Recomendado"
            : "Retorno mayor",
        click: async (options) => {
          if (options?.force !== true) throw new Error("element is not stable");
          await inner.click(options);
        },
      };
    };
    const client = createClient(fake.page);
    client.beginScan();
    await expect(
      client.listEligibleOpportunities(config, {}),
    ).resolves.toBeDefined();
    await client.close();
  });

  it("dismisses a blocking campaign before waiting for opportunity rows", async () => {
    let campaignOpen = true;
    const loading = fixture("opportunities-table-loading.html");
    const fake = createFakePage({
      html: () => (campaignOpen ? loading : TABLE),
    });
    const original = fake.page.locator;
    fake.page.locator = (selector) => {
      if (selector.includes("generic-modal-overlay"))
        return {
          isVisible: async () => campaignOpen,
          textContent: async () => "Aviso de campaña",
          click: async () => {
            campaignOpen = false;
          },
          first: () => fake.page.locator(selector),
          nth: () => fake.page.locator(selector),
        };
      const locator = original(selector);
      if (selector.includes("select-sort"))
        return {
          ...locator,
          isVisible: async () => !campaignOpen,
        };
      return locator;
    };

    const client = createClient(fake.page);
    client.beginScan();
    try {
      await client.listEligibleOpportunities(
        { ...config, allowedRisks: [] },
        {},
      );
      expect(campaignOpen).toBe(false);
    } finally {
      await client.close();
    }
  });

  it("reloads opportunities once if sorting leaves the refreshed table unready", async () => {
    const loading = fixture("opportunities-table-loading.html");
    let currentHtml = loading;
    const fake = createFakePage({ html: () => currentHtml });
    let navigations = 0;
    let sorted = false;
    fake.page.goto = async (target) => {
      fake.setUrl(target);
      navigations += 1;
      currentHtml = TABLE;
      return { status: () => 200 };
    };
    const original = fake.page.locator;
    fake.page.locator = (selector) => {
      if (selector.includes("multi-select-trigger")) {
        const locator = original(selector);
        return {
          ...locator,
          isVisible: async () => true,
          textContent: async () =>
            sorted ? "Ordenar por: Retorno mayor" : "Ordenar por: Recomendado",
        };
      }
      if (selector.includes("multi-select-option"))
        return {
          ...original(selector),
          isVisible: async () => true,
          textContent: async () => "Retorno mayor",
          click: async () => {
            sorted = true;
            currentHtml = loading;
          },
        };
      return original(selector);
    };

    let clock = 0;
    const client = createClient(fake.page, {
      now: () => clock,
      sleep: async (milliseconds: number) => {
        clock += milliseconds;
      },
    });
    client.beginScan();
    try {
      await client.listEligibleOpportunities(
        { ...config, allowedRisks: [] },
        {},
      );
      expect(navigations).toBe(2);
    } finally {
      await client.close();
    }
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
    // An unread board must fail closed rather than be mistaken for an empty
    // opportunity list or continue into sorting without a rendered control.
    // It is not a changed page either: that would pause the monitor for a load
    // the next tick gets through.
    const failure = await client
      .listEligibleOpportunities(config, {})
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(PageStructureError);
    expect((failure as Error).message).toBe(
      "The opportunities table did not render",
    );
    await client.close();
    expect(warn).toHaveBeenCalledWith(
      "Wait budget ran out",
      expect.stringContaining('"loadingRows":'),
    );
    warn.mockRestore();
  });

  it("reopens the board once when the first load never renders the table", async () => {
    const loading = fixture("opportunities-table-loading.html");
    let currentHtml = loading;
    const fake = createFakePage({ html: () => currentHtml });
    let navigations = 0;
    fake.page.goto = async (target) => {
      fake.setUrl(target);
      navigations += 1;
      if (navigations === 2) currentHtml = TABLE;
      return { status: () => 200 };
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let clock = 0;
    const client = createClient(fake.page, {
      now: () => clock,
      sleep: async (milliseconds: number) => {
        clock += milliseconds;
      },
    });
    client.beginScan();
    try {
      await client.listEligibleOpportunities(
        { ...config, allowedRisks: [] },
        {},
      );
      expect(navigations).toBe(2);
    } finally {
      await client.close();
      warn.mockRestore();
    }
  });

  it("still reports a changed page when rendered rows no longer parse", async () => {
    const changed = TABLE.replaceAll("<td", "<div").replaceAll(
      "</td>",
      "</div>",
    );
    const fake = createFakePage({ html: () => changed });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let clock = 0;
    const client = createClient(fake.page, {
      now: () => clock,
      sleep: async (milliseconds: number) => {
        clock += milliseconds;
      },
    });
    client.beginScan();
    await expect(
      client.listEligibleOpportunities(config, {}),
    ).rejects.toBeInstanceOf(PageStructureError);
    await client.close();
    warn.mockRestore();
  });

  it("treats a page that stops answering mid-wait as an unrendered table", async () => {
    let navigations = 0;
    let hung = false;
    const fake = createFakePage({ html: () => TABLE });
    const content = fake.page.content;
    fake.page.content = () =>
      hung ? new Promise<string>(() => undefined) : content();
    fake.page.goto = async (target) => {
      fake.setUrl(target);
      navigations += 1;
      hung = false;
      return { status: () => 200 };
    };
    const original = fake.page.locator;
    fake.page.locator = (selector) => {
      if (selector.includes("multi-select-trigger"))
        return {
          ...original(selector),
          textContent: async () => "Ordenar por: Recomendado",
        };
      if (selector.includes("multi-select-option"))
        return {
          ...original(selector),
          click: async () => {
            hung = true;
          },
        };
      return original(selector);
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.useFakeTimers();
    const client = createClient(fake.page, {
      now: () => Date.now(),
      sleep: (milliseconds: number) =>
        new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
    });
    client.beginScan();
    try {
      const scan = client.listEligibleOpportunities(
        { ...config, allowedRisks: [] },
        {},
      );
      await vi.advanceTimersByTimeAsync(13_000);
      // The wait's own twelve seconds ran out, not the scan's deadline: this
      // used to surface as ScanDeadlineError and skip the reload below.
      await expect(scan).resolves.toEqual([]);
      expect(navigations).toBe(2);
    } finally {
      vi.useRealTimers();
      await client.close();
      warn.mockRestore();
    }
  });

  it("refuses to report an unrendered portfolio as an empty one", async () => {
    const loading = fixture("opportunities-table-loading.html");
    const fake = createFakePage({ html: () => loading });
    let clock = 0;
    const client = createClient(fake.page, {
      now: () => clock,
      sleep: async () => {
        clock += 250;
      },
      deadlineMs: 60_000,
    });
    client.beginScan();
    // Zero rows would read as no exposure to anybody, and the concentration
    // score is worth five points of a recommendation to invest.
    await expect(client.getPortfolio()).rejects.toThrow(
      "The portfolio table did not render",
    );
    await client.close();
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

  it("retries a 5xx once and then fails without pausing the monitor", async () => {
    const fake = createFakePage();
    const goto = fake.page.goto;
    const statuses = [500, 503, 200];
    let navigations = 0;
    fake.page.goto = async (target) => {
      await goto(target);
      navigations += 1;
      return {
        status: () => statuses[Math.min(navigations, statuses.length) - 1]!,
      };
    };
    const client = createClient(fake.page);
    client.beginScan();
    // The site's own error page has none of the app's markup. Reading that as
    // a changed page paused the monitor until someone sent /recuperar.
    const failure = await client
      .listEligibleOpportunities(config, {})
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(PageStructureError);
    expect((failure as Error).message).toBe(
      "Prestamype responded with HTTP 503",
    );
    expect(navigations).toBe(2);
    await client.close();
  });

  it("carries on when the retry after a 5xx succeeds", async () => {
    const fake = createFakePage();
    const goto = fake.page.goto;
    let navigations = 0;
    fake.page.goto = async (target) => {
      await goto(target);
      navigations += 1;
      return { status: () => (navigations === 1 ? 502 : 200) };
    };
    const client = createClient(fake.page);
    client.beginScan();
    await expect(
      client.listEligibleOpportunities(config, {}),
    ).resolves.not.toHaveLength(0);
    await client.close();
  });

  it("refuses to work after it has been closed", async () => {
    const fake = createFakePage();
    const client = createClient(fake.page);
    await client.close();
    await expect(client.getPortfolio()).rejects.toThrow(PageStructureError);
  });
});
