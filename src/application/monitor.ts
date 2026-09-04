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

/**
 * What makes an alert a different alert: nothing but the auction itself.
 *
 * Every number on a live auction moves while it is open — each investor who
 * puts money in changes the funded and remaining amounts — so keying the alert
 * on the auction state resent the same card every time the detail cache
 * expired, differing only in the cents already taken. One auction now earns
 * exactly one message, for good: a changed verdict, a new conflict or a
 * worsened payment history will not reopen one that already went out.
 */
export function alertIdentityKeys(opportunity: Opportunity): readonly string[] {
  return [JSON.stringify([opportunity.id])];
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
  const detail =
    error instanceof AggregateError
      ? error.errors.map((item) =>
          item instanceof Error
            ? `${item.name}: ${item.message}`
            : String(item),
        )
      : error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
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
      const party = conflict.party;
      if (
        hasBlacklistIdentity(party, [...persistedBlacklist, ...detectedEntries])
      )
        continue;
      detectedEntries.push({
        taxId: party.taxId,
        normalizedName: normalizeLegalName(party.legalName),
        reason: `Cobranza en curso: ${safeCollectionText(conflict.stage)}`,
        source: "portfolio-collection",
        createdAt: now.toISOString(),
        status: safeCollectionText(conflict.state),
        evidence: safeCollectionText(conflict.stage),
      });
    }
    if (detectedEntries.length > 0)
      await dependencies.repository.addBlacklistEntries(detectedEntries);
    const blacklistEntries = [...persistedBlacklist, ...detectedEntries];
    const candidates = await source.listEligibleOpportunities(
      dependencies.config,
      fingerprints,
    );
    const observedBalance = source.availableBalanceCents?.() ?? null;
    const effectivePortfolio: PortfolioSnapshot =
      observedBalance === null
        ? portfolio
        : { ...portfolio, availableBalanceCents: observedBalance };
    // Phase one deliberately has no persistence or notification side effects. A
    // structural failure in any candidate therefore cannot leak a recommendation.
    const records = candidates.map((opportunity) => ({
      opportunity,
      evaluation: (dependencies.evaluate ?? evaluateOpportunity)({
        opportunity,
        portfolio: effectivePortfolio,
        blacklistEntries,
        config: dependencies.config,
      }),
    }));
    for (const { opportunity, evaluation } of records) {
      evaluated += 1;
      const detailCheckedAt = now.toISOString();
      // Sticky: an auction that has ever alerted has alerted for good, and a
      // later scan finding it below the threshold does not undo that.
      const alreadyAlerted = fingerprints[opportunity.id]?.alerted === true;
      const save = (alerted = alreadyAlerted) =>
        dependencies.repository.saveOpportunity(opportunity, evaluation, {
          visibleFingerprint: opportunityFingerprint(opportunity),
          detailCheckedAt,
          alerted,
        });
      if (evaluation.decision === "IGNORE") {
        await save();
        continue;
      }

      let detectedAt: Date | undefined;
      const claimedKeys: string[] = [];
      try {
        for (const alertKey of alertIdentityKeys(opportunity)) {
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
          // Every key was already taken, so the message went out on an earlier
          // scan: record that, and the panel need never open for it again.
          await save(true);
          continue;
        }
        const message = (dependencies.formatAlert ?? formatOpportunityAlert)(
          opportunity,
          evaluation,
          effectivePortfolio,
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
      await save(true);
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
