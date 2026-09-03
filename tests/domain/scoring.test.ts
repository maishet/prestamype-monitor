import { describe, expect, it } from "vitest";

import {
  scoreConcentration,
  scoreDebtorHistory,
  scoreExperience,
  scoreOpportunity,
  scoreReturn,
  scoreRisk,
  scoreSupplierHistory,
  scoreTerm,
} from "../../src/domain/scoring.js";
import { possibleInvestmentCents } from "../../src/domain/investment-projection.js";
import type {
  Opportunity,
  PaymentHistory,
  PortfolioSnapshot,
} from "../../src/domain/types.js";

const favorableHistory: PaymentHistory = {
  totalAuctions: 100,
  paidOnTime: 100,
  paidLate: 0,
  currentOnTime: 0,
  overdue: 0,
  averageDelayDays: 0,
  delinquencyPct: 0,
  historicalAmountCents: 10_000_000,
};

const opportunity: Opportunity = {
  id: "opp-1",
  auctionCode: "M5dGmP0G",
  commercialName: "CLIENTE",
  investmentType: "Factoring",
  url: "https://example.test/opp-1",
  supplier: { legalName: "Proveedor SAC", taxId: "20111111111" },
  debtor: { legalName: "Deudor SAC", taxId: "20222222222" },
  risk: "A",
  currency: "PEN",
  annualReturnPct: 20,
  monthlyReturnPct: null,
  totalAmountCents: 100_000,
  fundedAmountCents: 0,
  remainingAmountCents: 100_000,
  closesAt: "2026-01-01T00:00:00.000Z",
  dueAt: "2026-03-31T00:00:00.000Z",
  debtorHistory: favorableHistory,
  supplierHistory: favorableHistory,
  collectionProblem: false,
};

const portfolio: PortfolioSnapshot = {
  availableBalanceCents: 0,
  activeTotalCents: 1_000_000,
  exposureByParty: { "DEUDOR SAC": 0 },
};

describe("scoring components", () => {
  it("awards return points from 5 at 15 percent to 15 at 20 percent", () => {
    expect(scoreReturn(15)).toBe(5);
    expect(scoreReturn(17.5)).toBe(10);
    expect(scoreReturn(20)).toBe(15);
    expect(scoreReturn(25)).toBe(15);
  });

  it.each([
    ["A+", 10],
    ["A", 10],
    ["B", 8],
    ["C", 6],
    ["D", 0],
    ["E", 0],
  ] as const)("scores risk %s as %i", (risk, expected) => {
    expect(scoreRisk(risk)).toBe(expected);
  });

  it("scores term boundaries and rejects absent, invalid, or non-positive terms", () => {
    expect(scoreTerm("2026-01-01T00:00:00Z", "2026-04-01T00:00:00Z")).toBe(5);
    expect(scoreTerm("2026-01-01T00:00:00Z", "2026-04-02T00:00:00Z")).toBe(4);
    expect(scoreTerm("2026-01-01T00:00:00Z", "2026-05-01T00:00:00Z")).toBe(4);
    expect(scoreTerm("2026-01-01T00:00:00Z", "2026-06-30T00:00:00Z")).toBe(2);
    expect(scoreTerm(null, "2026-01-02T00:00:00Z")).toBe(0);
    expect(scoreTerm("invalid", "2026-01-02T00:00:00Z")).toBe(0);
    expect(scoreTerm("2026-01-02T00:00:00Z", "2026-01-01T00:00:00Z")).toBe(0);
  });

  it("scores histories using bounded on-time, delinquency, and delay formulas", () => {
    expect(scoreDebtorHistory(favorableHistory)).toBe(30);
    expect(scoreSupplierHistory(favorableHistory)).toBe(20);
    expect(scoreDebtorHistory(null)).toBe(4);
    expect(scoreSupplierHistory(null)).toBe(3);

    const partial = {
      ...favorableHistory,
      totalAuctions: 10,
      paidOnTime: 5,
      averageDelayDays: 15,
      delinquencyPct: 50,
    };
    expect(scoreDebtorHistory(partial)).toBe(15);
    expect(scoreSupplierHistory(partial)).toBe(10);
  });

  it("scores combined experience logarithmically and amount linearly", () => {
    expect(scoreExperience(null, null)).toBe(0);
    expect(scoreExperience(favorableHistory, null)).toBe(15);
    expect(
      scoreExperience(
        {
          ...favorableHistory,
          totalAuctions: 50,
          historicalAmountCents: 5_000_000,
        },
        {
          ...favorableHistory,
          totalAuctions: 50,
          historicalAmountCents: 5_000_000,
        },
      ),
    ).toBe(15);
  });

  it("scores projected debtor concentration at exact boundaries", () => {
    expect(
      scoreConcentration(opportunity, { ...portfolio, activeTotalCents: null }),
    ).toBe(2);
    expect(
      scoreConcentration(
        { ...opportunity, debtor: { ...opportunity.debtor, legalName: "  " } },
        portfolio,
      ),
    ).toBe(2);
    expect(
      scoreConcentration(
        { ...opportunity, remainingAmountCents: 0 },
        { ...portfolio, activeTotalCents: 0 },
      ),
    ).toBe(2);
    expect(
      scoreConcentration(opportunity, { ...portfolio, activeTotalCents: 0 }),
    ).toBe(2);
    expect(
      scoreConcentration(opportunity, {
        ...portfolio,
        availableBalanceCents: 100_000,
        exposureByParty: { "DEUDOR SAC": 340_000 },
      }),
    ).toBe(3);
    expect(
      scoreConcentration(opportunity, {
        ...portfolio,
        availableBalanceCents: 100_000,
        exposureByParty: { "DEUDOR SAC": 615_000 },
      }),
    ).toBe(1);
    expect(
      scoreConcentration(opportunity, {
        ...portfolio,
        availableBalanceCents: 100_000,
        exposureByParty: { "DEUDOR SAC": 835_000 },
      }),
    ).toBe(0);
  });

  it("uses available balance as the exact projected amount, including zero", () => {
    const candidate = { ...opportunity, remainingAmountCents: 1_000_000 };
    const base = {
      ...portfolio,
      activeTotalCents: 100_000,
      exposureByParty: { "DEUDOR SAC": 10_000 },
    };
    const zero = { ...base, availableBalanceCents: 0 };
    const hundred = { ...base, availableBalanceCents: 10_000 };

    expect(possibleInvestmentCents(candidate, zero)).toBe(0);
    expect(possibleInvestmentCents(candidate, hundred)).toBe(10_000);
    expect(scoreConcentration(candidate, zero)).toBe(5);
    expect(scoreConcentration(candidate, hundred)).toBe(5);
    expect(
      scoreConcentration(candidate, {
        ...base,
        availableBalanceCents: Number.NaN,
      }),
    ).toBe(2);
  });

  it("does not award undue points for negative or non-finite data", () => {
    const invalid = {
      ...favorableHistory,
      totalAuctions: Number.NaN,
      paidOnTime: Number.POSITIVE_INFINITY,
      averageDelayDays: Number.NEGATIVE_INFINITY,
      delinquencyPct: -10,
      historicalAmountCents: -1,
    };
    expect(scoreReturn(Number.NaN)).toBe(0);
    expect(scoreDebtorHistory(invalid)).toBe(0);
    expect(scoreSupplierHistory(invalid)).toBe(0);
    expect(scoreExperience(invalid, invalid)).toBe(0);
    expect(
      scoreConcentration(
        { ...opportunity, remainingAmountCents: Number.NaN },
        portfolio,
      ),
    ).toBe(2);
    expect(
      scoreConcentration(
        { ...opportunity, remainingAmountCents: -1 },
        portfolio,
      ),
    ).toBe(5);
    expect(
      scoreConcentration(opportunity, {
        ...portfolio,
        exposureByParty: { "DEUDOR SAC": Number.POSITIVE_INFINITY },
      }),
    ).toBe(2);
    expect(
      scoreConcentration(opportunity, {
        ...portfolio,
        exposureByParty: { "DEUDOR SAC": -1 },
      }),
    ).toBe(2);
    expect(
      scoreConcentration(opportunity, {
        ...portfolio,
        exposureByParty: {},
      }),
    ).toBe(5);
  });
});

describe("scoreOpportunity", () => {
  it("exposes all components and rounds only the raw total once", () => {
    const result = scoreOpportunity(opportunity, portfolio);
    expect(result.components).toEqual({
      return: 15,
      risk: 10,
      term: 5,
      debtorHistory: 30,
      supplierHistory: 20,
      experience: 15,
      concentration: 5,
    });
    expect(result.total).toBe(100);
  });
});
