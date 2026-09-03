import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  isOpportunityTableLoading,
  isPanelOpen,
  parseMoney,
  parseOpportunityPanel,
  parseOpportunityRows,
  parsePager,
  parsePartyHistory,
  parsePartyProfile,
  parsePercentage,
  parsePortfolioRows,
  parseSpanishDate,
} from "../../src/browser/live-parsers.js";
import { PageStructureError } from "../../src/browser/errors.js";
import { load } from "cheerio";

const fixture = (name: string): string =>
  readFileSync(resolve("tests/fixtures/live", name), "utf8");

describe("primitives", () => {
  it("reads the three money spellings the site uses", () => {
    expect(parseMoney("S/ 250,990.68", "x")).toEqual({
      currency: "PEN",
      cents: 25_099_068,
    });
    expect(parseMoney("S/250,990.68", "x")).toEqual({
      currency: "PEN",
      cents: 25_099_068,
    });
    expect(parseMoney("$ 94,476.82", "x")).toEqual({
      currency: "USD",
      cents: 9_447_682,
    });
    expect(parseMoney("S/0.00", "x").cents).toBe(0);
  });

  it("rejects an amount with no currency at all", () => {
    expect(() => parseMoney("250,990.68", "x")).toThrow(PageStructureError);
  });

  it("reads Spanish dates with and without the abbreviation dot", () => {
    expect(parseSpanishDate("03 oct. 2026", "x")).toBe("2026-10-03");
    expect(parseSpanishDate("03 sep 2026", "x")).toBe("2026-09-03");
    expect(parseSpanishDate("02 ene. 2027", "x")).toBe("2027-01-02");
  });

  it("reads a percentage out of surrounding text", () => {
    expect(parsePercentage("14.84 %", "x")).toBe(14.84);
    expect(parsePercentage("9.25% anual 0.74% mensual", "x")).toBe(9.25);
  });
});

describe("opportunities table", () => {
  const html = fixture("opportunities-table.html");

  it("detects the loading state instead of reporting zero opportunities", () => {
    expect(
      isOpportunityTableLoading(fixture("opportunities-table-loading.html")),
    ).toBe(true);
    expect(isOpportunityTableLoading(html)).toBe(false);
  });

  it("parses every row of the filtered and sorted page", () => {
    const rows = parseOpportunityRows(html);
    expect(rows).toHaveLength(10);
    expect(rows[0]).toEqual({
      commercialName: "METALVAL",
      legalName: "METALVAL S.A.C.",
      risk: "C",
      protectedCapital: false,
      currency: "PEN",
      totalAmountCents: 25_099_068,
      fundedPct: 31.66,
      investmentType: "Factoring",
      annualReturnPct: 14.84,
      unmissable: false,
      estimatedPaymentAt: "2026-10-27",
      daysToPayment: 54,
    });
  });

  it("reads dollars and Confirming from the VISTA GOLD row", () => {
    const vistaGold = parseOpportunityRows(html).find(
      (row) => row.commercialName === "VISTA GOLD",
    );
    expect(vistaGold).toMatchObject({
      currency: "USD",
      totalAmountCents: 9_447_682,
      investmentType: "Confirming",
      risk: "B",
      annualReturnPct: 11.88,
    });
  });

  it("keeps the returns descending so the minimum-return cutoff is sound", () => {
    const returns = parseOpportunityRows(html).map(
      (row) => row.annualReturnPct,
    );
    expect(returns).toEqual([...returns].sort((a, b) => b - a));
    expect(returns[0]).toBe(14.84);
  });

  it("prefers the progress bar width over the rounded percentage", () => {
    // The row prints "32%" but the bar carries 31.66%.
    expect(parseOpportunityRows(html)[0]?.fundedPct).toBe(31.66);
  });

  it("reports how many opportunities the filter left", () => {
    expect(parsePager(load(html))).toEqual({ from: 1, to: 10, total: 45 });
  });

  it("marks protected rows instead of failing on the missing letter", () => {
    const rows = parseOpportunityRows(fixture("panel-invertir-protegida.html"));
    const protectedRows = rows.filter((row) => row.protectedCapital);
    expect(protectedRows.length).toBeGreaterThan(0);
    for (const row of protectedRows) expect(row.risk).toBeNull();
    expect(
      rows.filter((row) => row.risk !== null).map((row) => row.risk),
    ).toEqual(["C", "D"]);
  });
});

describe("detail panel", () => {
  it("parses a panel whose risk is a letter", () => {
    const panel = parseOpportunityPanel(
      fixture("panel-invertir-riesgo-letra.html"),
    );
    expect(panel).toMatchObject({
      auctionCode: "M5dGmP0G",
      commercialName: "C & M SERVICENTROS",
      legalName: "C & M SERVICENTROS S.A.C.",
      risk: "C",
      protectedCapital: false,
      currency: "PEN",
      totalAmountCents: 17_900_810,
      fundedAmountCents: 4_677_257,
      remainingAmountCents: 13_223_553,
      fundedPct: 26.13,
      annualReturnPct: 14.16,
      monthlyReturnPct: 1.11,
      closesAt: "2026-09-03",
      dueAt: "2026-11-27",
      availableBalanceCents: 0,
      minimumInvestmentCents: 10_000,
    });
  });

  it("keeps collected plus remaining equal to the auction total", () => {
    const panel = parseOpportunityPanel(
      fixture("panel-invertir-riesgo-letra.html"),
    );
    expect(panel.fundedAmountCents + panel.remainingAmountCents).toBe(
      panel.totalAmountCents,
    );
  });

  it("parses a protected panel and its monthly return", () => {
    const panel = parseOpportunityPanel(
      fixture("panel-invertir-protegida.html"),
    );
    expect(panel).toMatchObject({
      auctionCode: "IRo34SdQ",
      commercialName: "COMPANIA MINERA ARES",
      risk: null,
      protectedCapital: true,
      annualReturnPct: 9.25,
      monthlyReturnPct: 0.74,
      fundedPct: 95.71,
    });
    expect(panel.closesInText).toMatch(/Faltan/u);
  });

  it.each([
    ["panel-invertir-riesgo-letra.html"],
    ["panel-invertir-protegida.html"],
  ])("compounds the monthly return into the annual one in %s", (name) => {
    const panel = parseOpportunityPanel(fixture(name));
    // A sanity check on the pair: misreading either badge breaks the identity.
    const compounded = ((1 + panel.monthlyReturnPct! / 100) ** 12 - 1) * 100;
    expect(compounded).toBeCloseTo(panel.annualReturnPct, 1);
  });

  it("knows whether a panel is open", () => {
    expect(isPanelOpen(fixture("panel-invertir-riesgo-letra.html"))).toBe(true);
    expect(isPanelOpen(fixture("opportunities-table-loading.html"))).toBe(
      false,
    );
  });
});

describe("party tabs", () => {
  it("maps the Deudor tab onto the payment-history model", () => {
    expect(parsePartyHistory(fixture("panel-deudor.html"))).toEqual({
      totalAuctions: 51,
      paidOnTime: 43,
      paidLate: 1,
      currentOnTime: 7,
      overdue: 0,
      averageDelayDays: 1020,
      delinquencyPct: 0.46,
      historicalAmountCents: 1_107_837_939,
    });
  });

  it("parses the Proveedor tab, which has no summary metrics", () => {
    const history = parsePartyHistory(fixture("panel-proveedor.html"));
    expect(history).toMatchObject({
      currentOnTime: 117,
      overdue: 0,
      paidOnTime: 260,
      paidLate: 20,
      totalAuctions: 397,
      delinquencyPct: null,
      averageDelayDays: null,
    });
  });

  it("reads the debtor identity, tax id and letter grade", () => {
    expect(parsePartyProfile(fixture("panel-deudor.html"))).toEqual({
      legalName: "COMPANIA MINERA ARES",
      taxId: "20123456789",
      risk: "B",
    });
  });

  it("returns null when the tab carries no profile", () => {
    expect(parsePartyProfile(fixture("panel-proveedor.html"))).toBeNull();
  });
});

describe("portfolio", () => {
  const rows = parsePortfolioRows(fixture("mis-inversiones.html"));

  it("parses every investment on the page", () => {
    expect(rows).toHaveLength(10);
    expect(rows[1]).toEqual({
      commercialName: "MARATHON",
      legalName: "SUPERDEPORTE PLUS PERU S.A.C.",
      risk: "B",
      investedAmountCents: 680_752,
      currency: "PEN",
      annualReturnPct: 18.16,
      state: "Por cobrar",
      collectionStage: null,
    });
  });

  it("flags the only client under collection, which is the blacklist signal", () => {
    const underCollection = rows.filter((row) => row.collectionStage !== null);
    expect(underCollection).toHaveLength(1);
    expect(underCollection[0]).toMatchObject({
      commercialName: "CORPORACION LERIBE",
      state: "Por cobrar",
      collectionStage: "Cobranza administrativa I",
    });
  });

  it("reads the states Prestamype documents in its own tooltip", () => {
    expect(new Set(rows.map((row) => row.state))).toEqual(
      new Set(["Por cobrar", "Inversión exitosa"]),
    );
  });
});
