import type { Opportunity, PortfolioSnapshot } from "./types.js";

export function possibleInvestmentCents(
  opportunity: Pick<Opportunity, "remainingAmountCents">,
  portfolio: Pick<PortfolioSnapshot, "availableBalanceCents">,
): number | null {
  const balance = portfolio.availableBalanceCents;
  const remaining = opportunity.remainingAmountCents;
  if (
    balance === null ||
    !Number.isFinite(balance) ||
    balance < 0 ||
    !Number.isFinite(remaining)
  ) {
    return null;
  }
  return Math.min(balance, Math.max(remaining, 0));
}

export function resultingConcentrationRatio(
  opportunity: Pick<Opportunity, "debtor" | "remainingAmountCents">,
  portfolio: Pick<
    PortfolioSnapshot,
    "activeTotalCents" | "availableBalanceCents" | "exposureByTaxId"
  >,
): number | null {
  const taxId = opportunity.debtor.taxId;
  const active = portfolio.activeTotalCents;
  const possible = possibleInvestmentCents(opportunity, portfolio);
  if (
    taxId === null ||
    active === null ||
    !Number.isFinite(active) ||
    active < 0 ||
    possible === null
  ) {
    return null;
  }
  const recordedExposure = portfolio.exposureByTaxId[taxId];
  if (
    recordedExposure !== undefined &&
    (!Number.isFinite(recordedExposure) || recordedExposure < 0)
  ) {
    return null;
  }
  const exposure = recordedExposure ?? 0;
  const denominator = active + possible;
  if (!Number.isFinite(denominator) || denominator <= 0) return null;
  return (exposure + possible) / denominator;
}
