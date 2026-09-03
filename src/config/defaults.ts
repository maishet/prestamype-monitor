import type { MonitorConfig } from "../domain/types.js";

export const DEFAULT_CONFIG: MonitorConfig = {
  allowedRisks: ["A+", "A", "B", "C"],
  minimumAnnualReturnPct: 15,
  currency: "PEN",
  allowedCurrencies: ["PEN"],
  minimumInvestmentCents: 10_000,
  highPriorityScore: 80,
  reviewScore: 70,
  detailRefreshIntervalMs: 15 * 60 * 1_000,
};
