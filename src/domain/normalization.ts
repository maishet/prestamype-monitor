export function normalizeLegalName(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toUpperCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\bS\s+A\s+C\b/gu, "SAC")
    .replace(/\s+/gu, " ")
    .trim();
}
