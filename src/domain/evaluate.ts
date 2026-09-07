import { DEFAULT_CONFIG } from "../config/defaults.js";
import { findOpportunityBlacklistMatch } from "./blacklist.js";
import { scoreOpportunity } from "./scoring.js";
import type {
  BlacklistEntry,
  Evaluation,
  MonitorConfig,
  Opportunity,
  PortfolioSnapshot,
} from "./types.js";

export interface EvaluateOpportunityInput {
  readonly opportunity: Opportunity;
  readonly portfolio: PortfolioSnapshot;
  readonly blacklistEntries: readonly BlacklistEntry[];
  readonly config?: MonitorConfig;
}

export function evaluateOpportunity({
  opportunity,
  portfolio,
  blacklistEntries,
  config = DEFAULT_CONFIG,
}: EvaluateOpportunityInput): Evaluation {
  const reasons: string[] = [];
  const warnings: string[] = [];

  const blacklistMatch = findOpportunityBlacklistMatch(
    opportunity,
    blacklistEntries,
  );
  if (blacklistMatch !== null) {
    warnings.push(
      `Blacklist match for ${blacklistMatch.role}: ${blacklistMatch.entry.reason}`,
    );
  }
  if (opportunity.collectionProblem) {
    warnings.push("Señal actual de cobranza problemática");
  }

  if (!config.allowedRisks.includes(opportunity.risk)) {
    reasons.push(`Risk ${opportunity.risk} is not allowed`);
  }
  if (
    !Number.isFinite(opportunity.annualReturnPct) ||
    opportunity.annualReturnPct < config.minimumAnnualReturnPct
  ) {
    reasons.push(`Annual return is below ${config.minimumAnnualReturnPct}%`);
  }
  if (!config.allowedCurrencies.includes(opportunity.currency)) {
    reasons.push(`Currency ${opportunity.currency} is not allowed`);
  }
  if (
    !Number.isFinite(opportunity.remainingAmountCents) ||
    opportunity.remainingAmountCents < config.minimumInvestmentCents
  ) {
    reasons.push(
      `Remaining amount is below ${config.minimumInvestmentCents} cents`,
    );
  }

  if (warnings.length > 0) {
    return {
      decision: "DO_NOT_INVEST",
      score: 0,
      components: {},
      reasons,
      warnings,
    };
  }

  if (reasons.length > 0) {
    return {
      decision: "IGNORE",
      score: 0,
      components: {},
      reasons,
      warnings,
    };
  }

  const score = scoreOpportunity(opportunity, portfolio);
  if (opportunity.debtorHistory === null) {
    warnings.push("Debtor history is unavailable");
  }
  if (opportunity.supplierHistory === null) {
    warnings.push("Supplier history is unavailable");
  }
  const decision =
    score.total >= config.highPriorityScore
      ? "INVEST"
      : score.total >= config.reviewScore
        ? "REVIEW"
        : "IGNORE";

  if (decision === "INVEST" || decision === "REVIEW") {
    reasons.push(
      `Retorno anual ${opportunity.annualReturnPct.toFixed(2)}% cumple el mínimo`,
      `Riesgo ${opportunity.risk} permitido`,
    );
    const history = opportunity.debtorHistory;
    if (history !== null && history.totalAuctions > 0) {
      reasons.push(
        `Historial pagador: ${history.paidOnTime}/${history.totalAuctions} pagos a tiempo`,
      );
    }
  }

  return {
    decision,
    score: score.total,
    components: score.components,
    reasons,
    warnings,
  };
}
