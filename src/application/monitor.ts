import { evaluateOpportunity } from "../domain/evaluate.js";
import type {
  BlacklistEntry,
  Evaluation,
  MonitorConfig,
  Opportunity,
  PortfolioSnapshot,
} from "../domain/types.js";
import { formatOpportunityAlert } from "../notifications/telegram-message.js";
import type {
  MonitorRepository,
  Notifier,
  OpportunitySource,
} from "./ports.js";

export interface MonitorDependencies {
  readonly repository: MonitorRepository;
  readonly notifier: Notifier;
  readonly createSource: () => Promise<OpportunitySource>;
  readonly config: MonitorConfig;
  readonly clock?: () => Date;
  readonly evaluate?: (input: {
    opportunity: Opportunity;
    portfolio: PortfolioSnapshot;
    blacklistEntries: readonly BlacklistEntry[];
    config: MonitorConfig;
  }) => Evaluation;
  readonly formatAlert?: typeof formatOpportunityAlert;
}

export interface MonitorRunInput {
  readonly owner: string;
  readonly lockTtlSeconds: number;
  readonly alertLeaseSeconds: number;
}

export interface MonitorRunResult {
  readonly acquired: boolean;
  readonly evaluated: number;
  readonly alertsSent: number;
}

function materialAlertKeys(
  opportunity: Opportunity,
  evaluation: Evaluation,
): readonly string[] {
  if (evaluation.decision === "DO_NOT_INVEST") {
    const conflicts = evaluation.warnings
      .map((warning) =>
        warning.trim().replaceAll(/\s+/gu, " ").toLocaleLowerCase("es-PE"),
      )
      .sort();
    return [...new Set(conflicts)].map((conflict) =>
      JSON.stringify([opportunity.id, "DO_NOT_INVEST", conflict]),
    );
  }
  return [
    JSON.stringify([
      opportunity.id,
      opportunity.risk,
      opportunity.annualReturnPct.toFixed(6),
      opportunity.remainingAmountCents,
      opportunity.dueAt,
      evaluation.decision,
    ]),
  ];
}

function collectError(errors: unknown[], error: unknown): void {
  errors.push(error);
}

function errorWithCause(error: unknown, fallback: string): Error {
  return new Error(error instanceof Error ? error.message : fallback, {
    cause: error,
  });
}

export async function runMonitor(
  dependencies: MonitorDependencies,
  input: MonitorRunInput,
): Promise<MonitorRunResult> {
  const now = dependencies.clock?.() ?? new Date();
  const acquired = await dependencies.repository.acquireLock(
    input.owner,
    Math.floor(now.getTime() / 1_000) + input.lockTtlSeconds,
  );
  if (!acquired) return { acquired: false, evaluated: 0, alertsSent: 0 };

  let source: OpportunitySource | undefined;
  let evaluated = 0;
  let alertsSent = 0;
  const errors: unknown[] = [];
  let result: MonitorRunResult | undefined;
  try {
    const blacklistEntries = await dependencies.repository.getBlacklist();
    const fingerprints =
      await dependencies.repository.getOpportunityFingerprints();
    source = await dependencies.createSource();
    const portfolio = await source.getPortfolio();
    const candidates = await source.listEligibleOpportunities(
      dependencies.config,
      fingerprints,
    );
    // Phase one deliberately has no persistence or notification side effects. A
    // structural failure in any candidate therefore cannot leak a recommendation.
    const records = candidates.map((opportunity) => ({
      opportunity,
      evaluation: (dependencies.evaluate ?? evaluateOpportunity)({
        opportunity,
        portfolio,
        blacklistEntries,
        config: dependencies.config,
      }),
    }));
    for (const { opportunity, evaluation } of records) {
      await dependencies.repository.saveOpportunity(opportunity, evaluation);
      evaluated += 1;
      if (evaluation.decision === "IGNORE") continue;

      let detectedAt: Date | undefined;
      const claimedKeys: string[] = [];
      try {
        for (const alertKey of materialAlertKeys(opportunity, evaluation)) {
          const claimAt = dependencies.clock?.() ?? new Date();
          detectedAt ??= claimAt;
          const claimed = await dependencies.repository.claimAlert(
            alertKey,
            input.owner,
            Math.floor(claimAt.getTime() / 1_000) + input.alertLeaseSeconds,
          );
          if (claimed) claimedKeys.push(alertKey);
        }
        if (claimedKeys.length === 0) continue;
        const message = (dependencies.formatAlert ?? formatOpportunityAlert)(
          opportunity,
          evaluation,
          portfolio,
          detectedAt ?? new Date(),
        );
        await dependencies.notifier.send(message);
        alertsSent += 1;
      } catch (preDeliveryError) {
        const releaseErrors: unknown[] = [];
        for (const alertKey of claimedKeys) {
          try {
            await dependencies.repository.releaseAlertClaim(
              alertKey,
              input.owner,
            );
          } catch (releaseClaimError) {
            releaseErrors.push(releaseClaimError);
          }
        }
        if (releaseErrors.length > 0) {
          throw new AggregateError(
            [preDeliveryError, ...releaseErrors],
            "Alert preparation and claim release failed",
            { cause: preDeliveryError },
          );
        }
        throw errorWithCause(preDeliveryError, "Alert delivery failed");
      }
      // Once send resolves, failure of completeAlert is ambiguous. Keep the lease
      // instead of releasing it and risking an immediate duplicate Telegram alert.
      const completionErrors: unknown[] = [];
      for (const alertKey of claimedKeys) {
        try {
          await dependencies.repository.completeAlert(alertKey, input.owner);
        } catch (completionError) {
          completionErrors.push(completionError);
        }
      }
      if (completionErrors.length === 1) {
        throw errorWithCause(completionErrors[0], "Alert completion failed");
      }
      if (completionErrors.length > 1) {
        throw new AggregateError(
          completionErrors,
          "Multiple alert claims could not be completed",
          { cause: completionErrors[0] },
        );
      }
    }
    result = { acquired: true, evaluated, alertsSent };
  } catch (error) {
    collectError(errors, error);
  }
  if (source !== undefined) {
    try {
      await source.close();
    } catch (error) {
      collectError(errors, error);
    }
  }
  try {
    await dependencies.repository.releaseLock(input.owner);
  } catch (error) {
    collectError(errors, error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, "Monitor run and cleanup failed", {
      cause: errors[0],
    });
  }
  return result as MonitorRunResult;
}
