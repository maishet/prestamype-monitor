export type RiskGrade = "A+" | "A" | "B" | "C" | "D" | "E";
export type Currency = "PEN" | "USD";

export interface PaymentHistory {
  totalAuctions: number;
  paidOnTime: number;
  paidLate: number;
  currentOnTime: number;
  overdue: number;
  averageDelayDays: number | null;
  delinquencyPct: number | null;
  historicalAmountCents: number | null;
}

export interface PartyIdentity {
  legalName: string;
  taxId: string | null;
}

export interface BlacklistEntry {
  taxId: string | null;
  normalizedName: string;
  reason: string;
  source: string;
  createdAt: string;
  status?: string;
  evidence?: string | null;
}

export interface CollectionConflict {
  supplier: PartyIdentity;
  debtor: PartyIdentity;
  status: string;
  evidence: string | null;
}

export interface OpportunityFingerprintRecord {
  visibleFingerprint: string;
  detailCheckedAt: string;
}

export type OpportunityPersistenceMetadata = OpportunityFingerprintRecord;

export interface Opportunity {
  id: string;
  url: string;
  supplier: PartyIdentity;
  debtor: PartyIdentity;
  risk: RiskGrade;
  currency: Currency;
  annualReturnPct: number;
  monthlyReturnPct: number | null;
  totalAmountCents: number;
  fundedAmountCents: number;
  remainingAmountCents: number;
  closesAt: string | null;
  dueAt: string | null;
  debtorHistory: PaymentHistory | null;
  supplierHistory: PaymentHistory | null;
  collectionProblem: boolean;
}

export interface PortfolioSnapshot {
  availableBalanceCents: number | null;
  activeTotalCents: number | null;
  exposureByTaxId: Readonly<Record<string, number>>;
  collectionConflicts?: readonly CollectionConflict[];
}

export interface MonitorConfig {
  allowedRisks: readonly RiskGrade[];
  minimumAnnualReturnPct: number;
  currency: Currency;
  allowedCurrencies?: readonly Currency[];
  minimumInvestmentCents: number;
  highPriorityScore: number;
  reviewScore: number;
  detailRefreshIntervalMs?: number;
}

export interface Evaluation {
  decision: "INVEST" | "REVIEW" | "IGNORE" | "DO_NOT_INVEST";
  score: number;
  components: Readonly<Record<string, number>>;
  reasons: readonly string[];
  warnings: readonly string[];
}

export interface EncryptedSession {
  schemaVersion: 1;
  iv: string;
  ciphertext: string;
  authTag: string;
}
