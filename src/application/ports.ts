import type {
  BlacklistEntry,
  EncryptedSession,
  Evaluation,
  MonitorConfig,
  Opportunity,
  PortfolioSnapshot,
} from "../domain/types.js";

export interface OpportunitySource {
  getPortfolio(): Promise<PortfolioSnapshot>;
  listEligibleOpportunities(
    config: MonitorConfig,
    knownFingerprints: Readonly<Record<string, string>>,
  ): Promise<Opportunity[]>;
  close(): Promise<void>;
}

export interface MonitorRepository {
  acquireLock(owner: string, ttlEpochSeconds: number): Promise<boolean>;
  releaseLock(owner: string): Promise<void>;
  getBlacklist(): Promise<readonly BlacklistEntry[]>;
  getOpportunityFingerprints(): Promise<Readonly<Record<string, string>>>;
  saveOpportunity(
    opportunity: Opportunity,
    evaluation: Evaluation,
  ): Promise<void>;
  claimAlert(
    alertKey: string,
    owner: string,
    leaseUntilEpochSeconds: number,
  ): Promise<boolean>;
  /** Marks a successfully delivered alert. Telegram delivery remains at-most-once
   * during the lease, not provably exactly-once: a successful send followed by a
   * persistence failure is inherently ambiguous. */
  completeAlert(alertKey: string, owner: string): Promise<void>;
  /** Releases only a claim whose notification definitely failed before delivery. */
  releaseAlertClaim(alertKey: string, owner: string): Promise<void>;
}

export interface Notifier {
  send(message: string): Promise<void>;
}

export interface SessionStore {
  saveEncryptedSession(payload: EncryptedSession): Promise<void>;
}
