import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import { evaluateOpportunity } from "../../src/domain/evaluate.js";
import type {
  BlacklistEntry,
  Opportunity,
  PaymentHistory,
  PortfolioSnapshot,
} from "../../src/domain/types.js";

const history: PaymentHistory = {
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
  debtorHistory: history,
  supplierHistory: history,
  collectionProblem: false,
};

const portfolio: PortfolioSnapshot = {
  availableBalanceCents: 0,
  activeTotalCents: 1_000_000,
  exposureByParty: { "DEUDOR SAC": 0 },
};

const leribe: BlacklistEntry = {
  taxId: "20517854523",
  normalizedName: "CORPORACION LERIBE SAC",
  reason: "Cobranza administrativa I",
  source: "manual",
  createdAt: "2026-08-26T00:00:00.000Z",
};

const evaluate = (
  candidate: Opportunity,
  overrides: Partial<Parameters<typeof evaluateOpportunity>[0]> = {},
) =>
  evaluateOpportunity({
    opportunity: candidate,
    portfolio,
    blacklistEntries: [],
    ...overrides,
  });

describe("DEFAULT_CONFIG", () => {
  it("accepts A+ through C and requires 15 percent annual return", () => {
    expect(DEFAULT_CONFIG.allowedRisks).toEqual(["A+", "A", "B", "C"]);
    expect(DEFAULT_CONFIG.minimumAnnualReturnPct).toBe(15);
    expect(DEFAULT_CONFIG.allowedCurrencies).toEqual(["PEN"]);
  });
});

describe("evaluateOpportunity", () => {
  it("rejects PEN when only USD is allowed", () => {
    const result = evaluate(opportunity, {
      config: { ...DEFAULT_CONFIG, allowedCurrencies: ["USD"] },
    });
    expect(result.decision).toBe("IGNORE");
    expect(result.reasons).toContain("Currency PEN is not allowed");
  });

  it("scores USD when allowedCurrencies permits it regardless of legacy currency", () => {
    const result = evaluate(
      { ...opportunity, currency: "USD" },
      {
        config: { ...DEFAULT_CONFIG, allowedCurrencies: ["PEN", "USD"] },
      },
    );
    expect(result.decision).toBe("INVEST");
    expect(result.score).toBeGreaterThan(0);
  });

  it("ignores 14.99 percent and allows the exact 15 percent return boundary", () => {
    expect(evaluate({ ...opportunity, annualReturnPct: 14.99 }).decision).toBe(
      "IGNORE",
    );
    expect(
      evaluate({ ...opportunity, annualReturnPct: 15 }).score,
    ).toBeGreaterThan(0);
  });

  it.each(["D", "E"] as const)("ignores disallowed risk %s", (risk) => {
    expect(evaluate({ ...opportunity, risk }).decision).toBe("IGNORE");
  });

  it("ignores USD and remaining amounts below S/100", () => {
    expect(evaluate({ ...opportunity, currency: "USD" }).decision).toBe(
      "IGNORE",
    );
    expect(
      evaluate({ ...opportunity, remainingAmountCents: 9_999 }).decision,
    ).toBe("IGNORE");
  });

  it("accumulates all applicable configurable filter failures deterministically", () => {
    const result = evaluate({
      ...opportunity,
      risk: "E",
      currency: "USD",
      annualReturnPct: 14,
      remainingAmountCents: 1,
    });
    expect(result).toMatchObject({
      decision: "IGNORE",
      score: 0,
      components: {},
    });
    expect(result.reasons).toHaveLength(4);
  });

  it("returns DO_NOT_INVEST for blacklist regardless of a theoretical perfect score", () => {
    const result = evaluate(
      {
        ...opportunity,
        supplier: {
          legalName: "Corporación Leribe S.A.C.",
          taxId: "20517854523",
        },
      },
      { blacklistEntries: [leribe] },
    );
    expect(result).toMatchObject({
      decision: "DO_NOT_INVEST",
      score: 0,
      components: {},
    });
    expect(result.warnings.join(" ")).toContain("Cobranza administrativa I");
    expect(result.warnings.join(" ")).toContain("supplier");
  });

  it("returns DO_NOT_INVEST and warning for a collection problem", () => {
    const result = evaluate({ ...opportunity, collectionProblem: true });
    expect(result).toMatchObject({
      decision: "DO_NOT_INVEST",
      score: 0,
      components: {},
    });
    expect(result.warnings.join(" ").toLowerCase()).toContain("cobranza");
  });

  it("preserves blacklist and collection warnings together", () => {
    const result = evaluate(
      {
        ...opportunity,
        supplier: { legalName: "Corporación Leribe S.A.C.", taxId: null },
        collectionProblem: true,
      },
      { blacklistEntries: [leribe] },
    );
    expect(result.decision).toBe("DO_NOT_INVEST");
    expect(result.warnings).toHaveLength(2);
  });

  it.each([
    [20, 15, 80, "INVEST"],
    [19.95, 15, 79.9, "REVIEW"],
    [15, 15, 70, "REVIEW"],
    [15, 15.5, 69.9, "IGNORE"],
  ] as const)(
    "maps a final score of %s-return/%s-delay to %s and %s",
    (annualReturnPct, averageDelayDays, score, decision) => {
      const result = evaluate({
        ...opportunity,
        annualReturnPct,
        debtorHistory: { ...history, averageDelayDays },
        supplierHistory: null,
      });
      expect(result.score).toBe(score);
      expect(result.decision).toBe(decision);
    },
  );

  it("uses configurable thresholds against the rounded final score", () => {
    const actual = evaluate(opportunity);
    expect(actual.decision).toBe("INVEST");
    expect(
      evaluate(opportunity, {
        config: {
          ...DEFAULT_CONFIG,
          highPriorityScore: actual.score + 1,
          reviewScore: actual.score,
        },
      }).decision,
    ).toBe("REVIEW");
    expect(
      evaluate(opportunity, {
        config: {
          ...DEFAULT_CONFIG,
          highPriorityScore: actual.score + 2,
          reviewScore: actual.score + 1,
        },
      }).decision,
    ).toBe("IGNORE");
  });

  it("warns about missing history without turning it into a veto", () => {
    const result = evaluate({ ...opportunity, supplierHistory: null });
    expect(result.decision).toBe("INVEST");
    expect(result.warnings.join(" ").toLowerCase()).toContain(
      "supplier history",
    );
  });

  it("provides two or three deterministic favorable reasons for alertable decisions", () => {
    const first = evaluate(opportunity);
    const second = evaluate(opportunity);
    expect(first.decision).toBe("INVEST");
    expect(first.reasons).toEqual(second.reasons);
    expect(first.reasons.length).toBeGreaterThanOrEqual(2);
    expect(first.reasons.length).toBeLessThanOrEqual(3);
    expect(first.reasons.join(" ")).toMatch(/retorno/i);
    expect(first.reasons.join(" ")).toMatch(/riesgo/i);
  });

  it("does not let corrupt debtor exposure elevate a borderline decision", () => {
    const result = evaluate(
      {
        ...opportunity,
        debtorHistory: { ...history, averageDelayDays: 15 },
        supplierHistory: null,
      },
      {
        portfolio: {
          ...portfolio,
          exposureByParty: { "DEUDOR SAC": Number.NaN },
        },
      },
    );
    expect(result.score).toBe(77);
    expect(result.decision).toBe("REVIEW");
  });

  it("ignores a non-finite remaining amount at the filter gate", () => {
    const result = evaluate({
      ...opportunity,
      remainingAmountCents: Number.NaN,
    });
    expect(result).toMatchObject({
      decision: "IGNORE",
      score: 0,
      components: {},
    });
  });
});
