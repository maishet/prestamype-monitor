import type {
  Opportunity,
  PaymentHistory,
  PortfolioSnapshot,
  RiskGrade,
} from "./types.js";
import { resultingConcentrationRatio } from "./investment-projection.js";

const EXPERIENCE_AUCTION_CALIBRATION_COUNT = 100;
const EXPERIENCE_AMOUNT_CALIBRATION_CENTS = 10_000_000;

export interface ScoreComponents {
  readonly [component: string]: number;
  readonly return: number;
  readonly risk: number;
  readonly term: number;
  readonly debtorHistory: number;
  readonly supplierHistory: number;
  readonly experience: number;
  readonly concentration: number;
}

export interface ScoreBreakdown {
  readonly components: ScoreComponents;
  readonly total: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
}

function validNonNegative(value: number | null): number {
  return value !== null && Number.isFinite(value) && value >= 0 ? value : 0;
}

export function scoreReturn(annualPct: number): number {
  return clamp(5 + ((annualPct - 15) / 5) * 10, 0, 15);
}

export function scoreRisk(risk: RiskGrade): number {
  if (risk === "A+" || risk === "A") return 10;
  if (risk === "B") return 8;
  if (risk === "C") return 6;
  return 0;
}

export function scoreTerm(
  closesAt: string | null,
  dueAt: string | null,
): number {
  if (closesAt === null || dueAt === null) return 0;

  const closeTime = Date.parse(closesAt);
  const dueTime = Date.parse(dueAt);
  if (!Number.isFinite(closeTime) || !Number.isFinite(dueTime)) return 0;

  const days = (dueTime - closeTime) / 86_400_000;
  if (days <= 0) return 0;
  if (days <= 90) return 5;
  if (days <= 120) return 4;
  if (days <= 180) return 2;
  return 0;
}

function onTimeRatio(history: PaymentHistory): number {
  const total = validNonNegative(history.totalAuctions);
  const paidOnTime = validNonNegative(history.paidOnTime);
  return total > 0 ? clamp(paidOnTime / total, 0, 1) : 0;
}

function inverseLinear(
  value: number | null,
  maximumInput: number,
  points: number,
): number {
  if (value === null || !Number.isFinite(value) || value < 0) return 0;
  return clamp(points * (1 - value / maximumInput), 0, points);
}

export function scoreDebtorHistory(history: PaymentHistory | null): number {
  if (history === null) return 4;

  const onTime = onTimeRatio(history) * 18;
  const delinquency = inverseLinear(history.delinquencyPct, 100, 6);
  const delay = inverseLinear(history.averageDelayDays, 30, 6);
  return clamp(onTime + delinquency + delay, 0, 30);
}

export function scoreSupplierHistory(history: PaymentHistory | null): number {
  if (history === null) return 3;

  const onTime = onTimeRatio(history) * 14;
  const delay = inverseLinear(history.averageDelayDays, 30, 6);
  return clamp(onTime + delay, 0, 20);
}

export function scoreExperience(
  debtorHistory: PaymentHistory | null,
  supplierHistory: PaymentHistory | null,
): number {
  const histories = [debtorHistory, supplierHistory];
  const count = histories.reduce(
    (total, history) =>
      total + validNonNegative(history?.totalAuctions ?? null),
    0,
  );
  const historicalAmountCents = histories.reduce(
    (total, history) =>
      total + validNonNegative(history?.historicalAmountCents ?? null),
    0,
  );
  const auctionPoints = clamp(
    (10 * Math.log10(1 + count)) /
      Math.log10(1 + EXPERIENCE_AUCTION_CALIBRATION_COUNT),
    0,
    10,
  );
  const amountPoints = clamp(
    (historicalAmountCents / EXPERIENCE_AMOUNT_CALIBRATION_CENTS) * 5,
    0,
    5,
  );
  return clamp(auctionPoints + amountPoints, 0, 15);
}

export function scoreConcentration(
  opportunity: Opportunity,
  portfolio: PortfolioSnapshot,
): number {
  const ratio = resultingConcentrationRatio(opportunity, portfolio);
  if (ratio === null) return 2;
  if (ratio < 0.4) return 5;
  if (ratio < 0.65) return 3;
  if (ratio < 0.85) return 1;
  return 0;
}

function roundOneDecimal(value: number): number {
  return Math.round((value + Number.EPSILON) * 10) / 10;
}

export function scoreOpportunity(
  opportunity: Opportunity,
  portfolio: PortfolioSnapshot,
): ScoreBreakdown {
  const components: ScoreComponents = {
    return: scoreReturn(opportunity.annualReturnPct),
    risk: scoreRisk(opportunity.risk),
    term: scoreTerm(opportunity.closesAt, opportunity.dueAt),
    debtorHistory: scoreDebtorHistory(opportunity.debtorHistory),
    supplierHistory: scoreSupplierHistory(opportunity.supplierHistory),
    experience: scoreExperience(
      opportunity.debtorHistory,
      opportunity.supplierHistory,
    ),
    concentration: scoreConcentration(opportunity, portfolio),
  };
  const total = Object.values(components).reduce(
    (sum, component) => sum + component,
    0,
  );

  return { components, total: roundOneDecimal(total) };
}
