export type CostAction = "CONTINUE" | "WARN" | "PAUSE";
export type CostReason = "USAGE" | "GB_SECONDS" | "SCAN_LIMIT";

export interface MonthlyCostUsage {
  readonly invocations: number;
  readonly scans: number;
  readonly averageDurationSeconds: number;
}

export interface MonthlyCostLimits {
  readonly configuredMemoryGb: number;
  readonly monthlyGbSecondsLimit: number;
}

export interface CostDecision {
  readonly action: CostAction;
  readonly projectedGbSeconds: number;
  readonly utilizationRatio: number;
  readonly reason: CostReason;
}

export class CostGuardInputError extends Error {
  constructor() {
    super("Invalid monthly usage or cost limits");
    this.name = "CostGuardInputError";
  }
}

const WARNING_RATIO = 0.7;
const PAUSE_RATIO = 0.875;
const MAX_MONTHLY_SCANS = 31_000;

function finiteNonnegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function assertInputs(
  usage: MonthlyCostUsage,
  limits: MonthlyCostLimits,
): void {
  if (
    typeof usage !== "object" ||
    usage === null ||
    typeof limits !== "object" ||
    limits === null ||
    !Number.isSafeInteger(usage.invocations) ||
    usage.invocations < 0 ||
    !Number.isSafeInteger(usage.scans) ||
    usage.scans < 0 ||
    !finiteNonnegative(usage.averageDurationSeconds) ||
    !Number.isFinite(limits.configuredMemoryGb) ||
    limits.configuredMemoryGb <= 0 ||
    !Number.isFinite(limits.monthlyGbSecondsLimit) ||
    limits.monthlyGbSecondsLimit <= 0
  )
    throw new CostGuardInputError();
}

export function assessMonthlyUsage(
  usage: MonthlyCostUsage,
  limits: MonthlyCostLimits,
): CostDecision {
  try {
    assertInputs(usage, limits);
    const projectedGbSeconds =
      usage.invocations *
      limits.configuredMemoryGb *
      usage.averageDurationSeconds;
    if (!Number.isFinite(projectedGbSeconds)) throw new CostGuardInputError();
    const utilizationRatio = projectedGbSeconds / limits.monthlyGbSecondsLimit;

    if (usage.scans >= MAX_MONTHLY_SCANS) {
      return Object.freeze({
        action: "PAUSE",
        projectedGbSeconds,
        utilizationRatio,
        reason: "SCAN_LIMIT",
      });
    }
    const action: CostAction =
      utilizationRatio >= PAUSE_RATIO
        ? "PAUSE"
        : utilizationRatio >= WARNING_RATIO
          ? "WARN"
          : "CONTINUE";
    return Object.freeze({
      action,
      projectedGbSeconds,
      utilizationRatio,
      reason: action === "PAUSE" ? "GB_SECONDS" : "USAGE",
    });
  } catch (error) {
    if (error instanceof CostGuardInputError) throw error;
    throw new CostGuardInputError();
  }
}
