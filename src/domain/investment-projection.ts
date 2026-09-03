import type { Opportunity, PortfolioSnapshot } from "./types.js";
import { normalizeLegalName } from "./normalization.js";

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
    "activeTotalCents" | "availableBalanceCents" | "exposureByParty"
  >,
): number | null {
  const active = portfolio.activeTotalCents;
  const possible = possibleInvestmentCents(opportunity, portfolio);
  if (
    active === null ||
    !Number.isFinite(active) ||
    active < 0 ||
    possible === null
  ) {
    return null;
  }
  const party = normalizeLegalName(opportunity.debtor.legalName);
  if (party === "") return null;
  const recordedExposure = portfolio.exposureByParty[party];
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
