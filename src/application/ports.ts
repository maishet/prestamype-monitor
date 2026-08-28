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
  hasAlert(alertKey: string): Promise<boolean>;
  saveOpportunity(
    opportunity: Opportunity,
    evaluation: Evaluation,
  ): Promise<void>;
  markAlerted(alertKey: string): Promise<void>;
}

export interface Notifier {
  send(message: string): Promise<void>;
}

export interface SessionStore {
  saveEncryptedSession(payload: EncryptedSession): Promise<void>;
}
