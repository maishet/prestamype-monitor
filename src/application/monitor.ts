import { evaluateOpportunity } from "../domain/evaluate.js";
import type {
  BlacklistEntry,
  Evaluation,
  MonitorConfig,
  Opportunity,
  PortfolioSnapshot,
} from "../domain/types.js";
import { normalizeLegalName } from "../domain/normalization.js";
import { opportunityFingerprint } from "../browser/prestamype-client.js";
import { redactSensitiveText } from "../security/redaction.js";
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

function canonicalNumber(value: number | null): string | null {
  if (value === null) return null;
  return Number.isFinite(value) ? value.toString() : "invalid";
}

function canonicalHistory(
  history: Opportunity["debtorHistory"],
): object | null {
  if (history === null) return null;
  return Object.fromEntries(
    Object.entries(history).map(([key, value]) => [
      key,
      typeof value === "number" ? canonicalNumber(value) : value,
    ]),
  );
}

export function materialAlertKeys(
  opportunity: Opportunity,
  evaluation: Evaluation,
): readonly string[] {
  const material = [
    opportunity.id,
    opportunity.risk,
    canonicalNumber(opportunity.annualReturnPct),
    canonicalNumber(opportunity.monthlyReturnPct),
    opportunity.totalAmountCents,
    opportunity.fundedAmountCents,
    opportunity.remainingAmountCents,
    opportunity.closesAt,
    opportunity.dueAt,
    opportunity.collectionProblem,
    canonicalHistory(opportunity.debtorHistory),
    canonicalHistory(opportunity.supplierHistory),
    evaluation.decision,
    canonicalNumber(evaluation.score),
    Object.fromEntries(
      Object.entries(evaluation.components)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => [key, canonicalNumber(value)]),
    ),
  ];
  if (evaluation.decision === "DO_NOT_INVEST") {
    const conflicts = evaluation.warnings
      .map((warning) =>
        warning.trim().replaceAll(/\s+/gu, " ").toLocaleLowerCase("es-PE"),
      )
      .sort();
    return [...new Set(conflicts)].map((conflict) =>
      JSON.stringify([...material, conflict]),
    );
  }
  return [JSON.stringify(material)];
}

function safeCollectionText(value: string): string {
  return redactSensitiveText(value).replace(/\s+/g, " ").trim().slice(0, 200);
}

function hasBlacklistIdentity(
  party: Opportunity["supplier"],
  entries: readonly BlacklistEntry[],
): boolean {
  if (party.taxId !== null)
    return entries.some((entry) => entry.taxId === party.taxId);
  const name = normalizeLegalName(party.legalName);
  return entries.some(
    (entry) => normalizeLegalName(entry.normalizedName) === name,
  );
}

function collectError(errors: unknown[], error: unknown): void {
  errors.push(error);
  const detail = error instanceof AggregateError
    ? error.errors.map((item) => item instanceof Error ? `${item.name}: ${item.message}` : String(item))
    : error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  console.error("Monitor error", detail);
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
    const persistedBlacklist = await dependencies.repository.getBlacklist();
    const fingerprints =
      await dependencies.repository.getOpportunityFingerprints();
    source = await dependencies.createSource();
    source.beginScan?.();
    const portfolio = await source.getPortfolio();
    const detectedEntries: BlacklistEntry[] = [];
    for (const conflict of portfolio.collectionConflicts ?? []) {
      for (const party of [conflict.supplier, conflict.debtor]) {
        const entry: BlacklistEntry = {
          taxId: party.taxId,
          normalizedName: normalizeLegalName(party.legalName),
          reason: "Problema de cobranza detectado en cartera",
          source: "portfolio-collection",
          createdAt: now.toISOString(),
          status: safeCollectionText(conflict.status),
          evidence:
            conflict.evidence === null
              ? null
              : safeCollectionText(conflict.evidence),
        };
        if (
          hasBlacklistIdentity(party, [
            ...persistedBlacklist,
            ...detectedEntries,
          ])
        )
          continue;
        detectedEntries.push(entry);
      }
    }
    if (detectedEntries.length > 0)
      await dependencies.repository.addBlacklistEntries(detectedEntries);
    const blacklistEntries = [...persistedBlacklist, ...detectedEntries];
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
      evaluated += 1;
      const detailCheckedAt = now.toISOString();
      const save = () =>
        dependencies.repository.saveOpportunity(opportunity, evaluation, {
          visibleFingerprint: opportunityFingerprint(opportunity),
          detailCheckedAt,
        });
      if (evaluation.decision === "IGNORE") {
        await save();
        continue;
      }

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
        if (claimedKeys.length === 0) {
          await save();
          continue;
        }
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
      await save();
    }
    result = { acquired: true, evaluated, alertsSent };
    console.info("Monitor scan completed", JSON.stringify(result));
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
