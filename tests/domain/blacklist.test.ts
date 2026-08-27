import { describe, expect, it } from "vitest";
import {
  findOpportunityBlacklistMatch,
  matchesBlacklist,
} from "../../src/domain/blacklist.js";
import type { Opportunity } from "../../src/domain/types.js";

const entries = [
  {
    taxId: "20517854523",
    normalizedName: "CORPORACION LERIBE SAC",
    reason: "Cobranza administrativa I",
  },
];

const opportunity: Opportunity = {
  id: "opportunity-1",
  url: "https://example.test/opportunities/1",
  supplier: { taxId: "20517854523", legalName: "Otro proveedor" },
  debtor: { taxId: null, legalName: "Otro pagador" },
  risk: "A",
  currency: "PEN",
  annualReturnPct: 16,
  monthlyReturnPct: null,
  totalAmountCents: 100_000,
  fundedAmountCents: 0,
  remainingAmountCents: 100_000,
  closesAt: null,
  dueAt: null,
  debtorHistory: null,
  supplierHistory: null,
  collectionProblem: false,
};

describe("matchesBlacklist", () => {
  it("matches LERIBE by RUC", () => {
    expect(
      matchesBlacklist(
        { taxId: "20517854523", legalName: "Otro texto" },
        entries,
      )?.reason,
    ).toBe("Cobranza administrativa I");
  });

  it("matches LERIBE by normalized legal name", () => {
    expect(
      matchesBlacklist(
        { taxId: null, legalName: "Corporación Leribe S.A.C." },
        entries,
      ),
    ).not.toBeNull();
  });
});

describe("findOpportunityBlacklistMatch", () => {
  it("reports a supplier match", () => {
    expect(findOpportunityBlacklistMatch(opportunity, entries)).toEqual({
      role: "supplier",
      entry: entries[0],
    });
  });

  it("checks the debtor and reports its role", () => {
    const debtorMatch = {
      ...opportunity,
      supplier: { taxId: null, legalName: "Proveedor permitido" },
      debtor: { taxId: null, legalName: "Corporación Leribe S.A.C." },
    };

    expect(findOpportunityBlacklistMatch(debtorMatch, entries)).toEqual({
      role: "debtor",
      entry: entries[0],
    });
  });
});
