import type { Opportunity, PartyIdentity } from "./types.js";
import { normalizeLegalName } from "./normalization.js";

export interface BlacklistComparable {
  taxId: string | null;
  normalizedName: string;
  reason: string;
}

export interface BlacklistMatch<T extends BlacklistComparable> {
  role: "supplier" | "debtor";
  entry: T;
}

export function matchesBlacklist<T extends BlacklistComparable>(
  party: PartyIdentity,
  entries: readonly T[],
): T | null {
  if (party.taxId !== null) {
    const taxIdMatch = entries.find((entry) => entry.taxId === party.taxId);

    if (taxIdMatch !== undefined) {
      return taxIdMatch;
    }
  }

  const normalizedName = normalizeLegalName(party.legalName);

  return (
    entries.find(
      (entry) => normalizeLegalName(entry.normalizedName) === normalizedName,
    ) ?? null
  );
}

export function findOpportunityBlacklistMatch<T extends BlacklistComparable>(
  opportunity: Pick<Opportunity, "supplier" | "debtor">,
  entries: readonly T[],
): BlacklistMatch<T> | null {
  const supplierEntry = matchesBlacklist(opportunity.supplier, entries);

  if (supplierEntry !== null) {
    return { role: "supplier", entry: supplierEntry };
  }

  const debtorEntry = matchesBlacklist(opportunity.debtor, entries);

  return debtorEntry === null ? null : { role: "debtor", entry: debtorEntry };
}
