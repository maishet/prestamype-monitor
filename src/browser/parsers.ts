import { load, type Cheerio, type CheerioAPI } from "cheerio";
import type { AnyNode } from "domhandler";

import type {
  Currency,
  Opportunity,
  PartyIdentity,
  PaymentHistory,
  RiskGrade,
} from "../domain/types.js";
import { PageStructureError } from "./errors.js";

export const PRESTAMYPE_ORIGIN = "https://www.prestamype.com";

export const PRESTAMYPE_SELECTORS = {
  opportunityCard: ["[data-opportunity-card]", "article.opportunity-card"],
  detailPage: ['[data-page="opportunity-detail"]', ".opportunity-detail-page"],
  detailLink: ['[data-field="detail-link"]', "a.opportunity-detail-link"],
  supplierName: ['[data-field="supplier-name"]', ".supplier-name"],
  supplierTaxId: ['[data-field="supplier-tax-id"]', ".supplier-tax-id"],
  debtorName: ['[data-field="debtor-name"]', ".debtor-name"],
  debtorTaxId: ['[data-field="debtor-tax-id"]', ".debtor-tax-id"],
  risk: ['[data-field="risk"]', ".risk-grade"],
  currency: ['[data-field="currency"]', ".currency"],
  annualReturn: ['[data-field="annual-return"]', ".annual-return"],
  monthlyReturn: ['[data-field="monthly-return"]', ".monthly-return"],
  totalAmount: ['[data-field="total-amount"]', ".total-amount"],
  fundedAmount: ['[data-field="funded-amount"]', ".funded-amount"],
  remainingAmount: ['[data-field="remaining-amount"]', ".remaining-amount"],
  closesAt: ['[data-field="closes-at"]', "time.closes-at"],
  dueAt: ['[data-field="due-at"]', "time.due-at"],
  collectionStatus: ['[data-field="collection-status"]', ".collection-status"],
  debtorHistory: ['[data-history="debtor"]', ".debtor-history"],
  supplierHistory: ['[data-history="supplier"]', ".supplier-history"],
  totalAuctions: ['[data-field="total-auctions"]', ".total-auctions"],
  paidOnTime: ['[data-field="paid-on-time"]', ".paid-on-time"],
  paidLate: ['[data-field="paid-late"]', ".paid-late"],
  currentOnTime: ['[data-field="current-on-time"]', ".current-on-time"],
  overdue: ['[data-field="overdue"]', ".overdue"],
  averageDelayDays: [
    '[data-field="average-delay-days"]',
    ".average-delay-days",
  ],
  delinquency: ['[data-field="delinquency"]', ".delinquency"],
  historicalAmount: ['[data-field="historical-amount"]', ".historical-amount"],
} as const;

export interface OpportunitySummary {
  id: string;
  url: string;
  supplier: PartyIdentity;
  debtor: PartyIdentity;
  risk: RiskGrade;
  currency: Currency;
  annualReturnPct: number;
  remainingAmountCents: number;
  /** Index in the live table when the SPA does not expose a detail href. */
  rowIndex?: number;
}

type SelectorAlternatives = readonly string[];

export function parseOpportunityCards(html: string): OpportunitySummary[] {
  const $ = load(html);
  const cards = findAllByPriority($, PRESTAMYPE_SELECTORS.opportunityCard)
    .toArray()
    .map((element) => parseOpportunityCard($(element)));
  if (cards.length > 0) return cards;
  return parseOpportunityTable($);
}

function parseOpportunityTable($: CheerioAPI): OpportunitySummary[] {
  return $("tr.row_table:not(.row_table--loading)")
    .toArray()
    .map((element, rowIndex) => {
      const cells = $(element).find("td").toArray().map((cell) => $(cell).text().replaceAll(/\s+/gu, " ").trim());
      if (cells.length < 5) throw new PageStructureError("MISSING_FIELD", "opportunityTable");
      const client = cells[0] ?? "";
      const risk = parseRisk(cells[1] ?? $(element).find(".badge-risk").first().text());
      const amountRaw = $(element).find(".amount-label").first().text().trim() || cells[2] || "";
      const currency: Currency = /(?:US\$|USD|\$)/i.test(amountRaw) ? "USD" : "PEN";
      const amount = parseCents(amountRaw, "remainingAmountCents", currency);
      const annualReturnPct = parsePercentage(cells[4] ?? "", "annualReturnPct");
      const identity: PartyIdentity = { legalName: client || `Oportunidad ${rowIndex + 1}`, taxId: null };
      return {
        id: `table-row-${rowIndex}`,
        url: `${PRESTAMYPE_ORIGIN}/app/inversionista/oportunidades/table-row-${rowIndex}`,
        supplier: identity,
        debtor: identity,
        risk,
        currency,
        annualReturnPct,
        remainingAmountCents: amount,
        rowIndex,
      };
    });
}

export function parseOpportunityDetail(
  html: string,
  summary: OpportunitySummary,
): Opportunity {
  const $ = load(html);
  const page = findFirst($.root(), PRESTAMYPE_SELECTORS.detailPage);
  if (page.length === 0)
    throw new PageStructureError("MISSING_FIELD", "detailPage");

  const currency = parseOptionalCurrency(page) ?? summary.currency;
  return {
    id: summary.id,
    url: validateOpportunityUrl(summary.url).url,
    supplier: parseIdentity(page, "supplier", summary.supplier),
    debtor: parseIdentity(page, "debtor", summary.debtor),
    risk: parseOptionalRisk(page) ?? summary.risk,
    currency,
    annualReturnPct:
      parseOptionalPercentage(
        page,
        PRESTAMYPE_SELECTORS.annualReturn,
        "annualReturnPct",
      ) ?? summary.annualReturnPct,
    monthlyReturnPct: parseOptionalPercentage(
      page,
      PRESTAMYPE_SELECTORS.monthlyReturn,
      "monthlyReturnPct",
    ),
    totalAmountCents: parseRequiredCents(
      page,
      PRESTAMYPE_SELECTORS.totalAmount,
      "totalAmountCents",
      currency,
    ),
    fundedAmountCents: parseRequiredCents(
      page,
      PRESTAMYPE_SELECTORS.fundedAmount,
      "fundedAmountCents",
      currency,
    ),
    remainingAmountCents: parseRequiredCents(
      page,
      PRESTAMYPE_SELECTORS.remainingAmount,
      "remainingAmountCents",
      currency,
    ),
    closesAt: parseOptionalDate(
      page,
      PRESTAMYPE_SELECTORS.closesAt,
      "closesAt",
    ),
    dueAt: parseOptionalDate(page, PRESTAMYPE_SELECTORS.dueAt, "dueAt"),
    debtorHistory: parseHistory(
      page,
      PRESTAMYPE_SELECTORS.debtorHistory,
      "debtorHistory",
      currency,
    ),
    supplierHistory: parseHistory(
      page,
      PRESTAMYPE_SELECTORS.supplierHistory,
      "supplierHistory",
      currency,
    ),
    collectionProblem: parseCollectionProblem(page),
  };
}

function parseOpportunityCard(card: Cheerio<AnyNode>): OpportunitySummary {
  const link = validateOpportunityUrl(
    requiredAttribute(card, PRESTAMYPE_SELECTORS.detailLink, "href", "url"),
  );
  const currency = parseCurrency(
    requiredText(card, PRESTAMYPE_SELECTORS.currency, "currency"),
  );

  return {
    id: link.id,
    url: link.url,
    supplier: parseIdentity(card, "supplier"),
    debtor: parseIdentity(card, "debtor"),
    risk: parseRisk(requiredText(card, PRESTAMYPE_SELECTORS.risk, "risk")),
    currency,
    annualReturnPct: parsePercentage(
      requiredText(card, PRESTAMYPE_SELECTORS.annualReturn, "annualReturnPct"),
      "annualReturnPct",
    ),
    remainingAmountCents: parseCents(
      requiredText(
        card,
        PRESTAMYPE_SELECTORS.remainingAmount,
        "remainingAmountCents",
      ),
      "remainingAmountCents",
      currency,
    ),
  };
}

function parseIdentity(
  scope: Cheerio<AnyNode>,
  role: "supplier" | "debtor",
  fallback?: PartyIdentity,
): PartyIdentity {
  const nameSelectors =
    role === "supplier"
      ? PRESTAMYPE_SELECTORS.supplierName
      : PRESTAMYPE_SELECTORS.debtorName;
  const taxIdSelectors =
    role === "supplier"
      ? PRESTAMYPE_SELECTORS.supplierTaxId
      : PRESTAMYPE_SELECTORS.debtorTaxId;
  const legalName = optionalText(scope, nameSelectors) ?? fallback?.legalName;
  if (legalName === undefined) {
    throw new PageStructureError("MISSING_FIELD", `${role}.legalName`);
  }

  const rawTaxId = optionalText(scope, taxIdSelectors);
  const taxId =
    rawTaxId === undefined
      ? (fallback?.taxId ?? null)
      : parseTaxId(rawTaxId, role);
  return { legalName, taxId };
}

function parseTaxId(raw: string, role: string): string {
  const compact = raw.replace(/\s/g, "");
  if (!/^\d{11}$/.test(compact)) {
    throw new PageStructureError("INVALID_FIELD", `${role}.taxId`);
  }
  return compact;
}

function parseRisk(raw: string): RiskGrade {
  const value = raw.trim().toUpperCase();
  if (!["A+", "A", "B", "C", "D", "E"].includes(value)) {
    throw new PageStructureError("UNSUPPORTED_VALUE", "risk");
  }
  return value as RiskGrade;
}

function parseOptionalRisk(scope: Cheerio<AnyNode>): RiskGrade | null {
  const raw = optionalText(scope, PRESTAMYPE_SELECTORS.risk);
  return raw === undefined ? null : parseRisk(raw);
}

function parseCurrency(raw: string): Currency {
  const value = raw.trim().toUpperCase().replace(/\s/g, "");
  if (value === "PEN" || value === "S/") return "PEN";
  if (value === "USD" || value === "US$") return "USD";
  throw new PageStructureError("UNSUPPORTED_VALUE", "currency");
}

function parseOptionalCurrency(scope: Cheerio<AnyNode>): Currency | null {
  const raw = optionalText(scope, PRESTAMYPE_SELECTORS.currency);
  return raw === undefined ? null : parseCurrency(raw);
}

function parseHistory(
  page: Cheerio<AnyNode>,
  sectionSelectors: SelectorAlternatives,
  field: string,
  currency: Currency,
): PaymentHistory | null {
  const section = findFirst(page, sectionSelectors);
  if (section.length === 0) return null;

  return {
    totalAuctions: parseRequiredInteger(
      section,
      PRESTAMYPE_SELECTORS.totalAuctions,
      `${field}.totalAuctions`,
    ),
    paidOnTime: parseRequiredInteger(
      section,
      PRESTAMYPE_SELECTORS.paidOnTime,
      `${field}.paidOnTime`,
    ),
    paidLate: parseRequiredInteger(
      section,
      PRESTAMYPE_SELECTORS.paidLate,
      `${field}.paidLate`,
    ),
    currentOnTime: parseRequiredInteger(
      section,
      PRESTAMYPE_SELECTORS.currentOnTime,
      `${field}.currentOnTime`,
    ),
    overdue: parseRequiredInteger(
      section,
      PRESTAMYPE_SELECTORS.overdue,
      `${field}.overdue`,
    ),
    averageDelayDays: parseOptionalDays(
      section,
      PRESTAMYPE_SELECTORS.averageDelayDays,
      `${field}.averageDelayDays`,
    ),
    delinquencyPct: parseOptionalPercentage(
      section,
      PRESTAMYPE_SELECTORS.delinquency,
      `${field}.delinquencyPct`,
    ),
    historicalAmountCents: parseOptionalCents(
      section,
      PRESTAMYPE_SELECTORS.historicalAmount,
      `${field}.historicalAmountCents`,
      currency,
    ),
  };
}

function parseCollectionProblem(scope: Cheerio<AnyNode>): boolean {
  const raw = optionalText(scope, PRESTAMYPE_SELECTORS.collectionStatus);
  return raw === undefined ? false : isProblematicCollectionStatus(raw);
}

export function isProblematicCollectionStatus(raw: string): boolean {
  const tokens = raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[,;.:!?/\\|—–-]+/g, " | ")
    .replace(/[^a-z0-9|]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const indicators = findCollectionIndicators(tokens);
  const negatedIndicators = new Set<number>();

  for (const [index, token] of tokens.entries()) {
    if (token !== "no" && token !== "sin") continue;

    const firstIndicator =
      matchDirectNegation(tokens, indicators, index) ??
      (token === "no"
        ? matchAbsentVerbNegation(tokens, indicators, index)
        : matchEvidenceNegation(tokens, indicators, index));
    if (firstIndicator === null) continue;

    negatedIndicators.add(firstIndicator);
    propagateNeitherNegation(
      tokens,
      indicators,
      firstIndicator,
      negatedIndicators,
    );
  }

  return indicators.some((indicator) => !negatedIndicators.has(indicator));
}

export function parseVisibleMoneyCents(
  raw: string,
  currency: Currency,
  field = "money",
): number {
  return parseCents(raw, field, currency);
}

function matchDirectNegation(
  tokens: readonly string[],
  indicators: readonly number[],
  negator: number,
): number | null {
  let cursor = negator + 1;
  if (tokens[cursor] === "en") cursor += 1;
  if (tokens[cursor] === "estado" && tokens[cursor + 1] === "de") cursor += 2;
  return indicatorAt(indicators, cursor);
}

function matchAbsentVerbNegation(
  tokens: readonly string[],
  indicators: readonly number[],
  negator: number,
): number | null {
  const first = tokens[negator + 1];
  let cursor: number;
  if (
    ["hay", "existe", "presenta", "registra", "tiene"].includes(first ?? "")
  ) {
    cursor = negator + 2;
  } else if (
    first === "se" &&
    ["encuentra", "detecta"].includes(tokens[negator + 2] ?? "")
  ) {
    cursor = negator + 3;
  } else {
    return null;
  }

  const firstIndicator = indicators.find((indicator) => indicator >= cursor);
  if (firstIndicator === undefined) return null;
  const intervening = tokens.slice(cursor, firstIndicator);
  return intervening.some((token) =>
    ["|", "y", "o", "pero", "aunque", "no", "sin", "ni"].includes(token),
  )
    ? null
    : firstIndicator;
}

function matchEvidenceNegation(
  tokens: readonly string[],
  indicators: readonly number[],
  negator: number,
): number | null {
  if (
    !/^(?:evidencias?|senal(?:es)?|indicios?|constancias?)$/.test(
      tokens[negator + 1] ?? "",
    )
  ) {
    return null;
  }

  for (let cursor = negator + 2; cursor < tokens.length; cursor += 1) {
    const token = tokens[cursor];
    if (
      ["|", "y", "o", "pero", "aunque", "no", "sin", "ni"].includes(token ?? "")
    ) {
      return null;
    }
    if (token === "de") return indicatorAt(indicators, cursor + 1);
  }
  return null;
}

function propagateNeitherNegation(
  tokens: readonly string[],
  indicators: readonly number[],
  firstIndicator: number,
  negatedIndicators: Set<number>,
): void {
  let cursor = indicatorEnd(tokens, firstIndicator);
  while (tokens[cursor] === "ni") {
    cursor += 1;
    if (tokens[cursor] === "en") cursor += 1;
    const coordinated = indicatorAt(indicators, cursor);
    if (coordinated === null) return;
    negatedIndicators.add(coordinated);
    cursor = indicatorEnd(tokens, coordinated);
  }
}

function indicatorAt(
  indicators: readonly number[],
  position: number,
): number | null {
  return indicators.includes(position) ? position : null;
}

function indicatorEnd(tokens: readonly string[], start: number): number {
  return /^vencimientos?$/.test(tokens[start] ?? "") ? start + 2 : start + 1;
}

function findCollectionIndicators(tokens: readonly string[]): number[] {
  const starts: number[] = [];
  for (const [index, token] of tokens.entries()) {
    const singleWordIndicator =
      /^cobranzas?$/.test(token) ||
      /^vencid[oa]s?$/.test(token) ||
      /^moras?$/.test(token) ||
      /^morosidad(?:es)?$/.test(token) ||
      /^moros[oa]s?$/.test(token) ||
      /^incumplid[oa]s?$/.test(token) ||
      /^incumplimientos?$/.test(token);
    const problematicDueDate =
      /^vencimientos?$/.test(token) &&
      /^problematic[oa]s?$/.test(tokens[index + 1] ?? "");

    if (singleWordIndicator || problematicDueDate) starts.push(index);
  }
  return starts;
}

function parseRequiredInteger(
  scope: Cheerio<AnyNode>,
  selectors: SelectorAlternatives,
  field: string,
): number {
  const value = parseUnitless(requiredText(scope, selectors, field), field);
  if (!Number.isSafeInteger(value))
    throw new PageStructureError("INVALID_FIELD", field);
  return value;
}

function parseRequiredCents(
  scope: Cheerio<AnyNode>,
  selectors: SelectorAlternatives,
  field: string,
  currency: Currency,
): number {
  return parseCents(requiredText(scope, selectors, field), field, currency);
}

function parseOptionalCents(
  scope: Cheerio<AnyNode>,
  selectors: SelectorAlternatives,
  field: string,
  currency: Currency,
): number | null {
  const raw = optionalText(scope, selectors);
  return raw === undefined ? null : parseCents(raw, field, currency);
}

function parseCents(raw: string, field: string, currency: Currency): number {
  if (raw.includes("%")) throw new PageStructureError("INVALID_FIELD", field);
  const hasPen = /(?:S\/|\bPEN\b)/i.test(raw);
  const hasUsd = /(?:US\$|\bUSD\b)/i.test(raw);
  if (
    (currency === "PEN" && (!hasPen || hasUsd)) ||
    (currency === "USD" && (!hasUsd || hasPen))
  ) {
    throw new PageStructureError("INVALID_FIELD", field);
  }
  const value = parseNumber(
    raw.replace(/\bPEN\b|\bUSD\b|US\$|S\//gi, ""),
    field,
  );
  const cents = Math.round(value * 100);
  if (!Number.isSafeInteger(cents))
    throw new PageStructureError("INVALID_FIELD", field);
  return cents;
}

function parseOptionalPercentage(
  scope: Cheerio<AnyNode>,
  selectors: SelectorAlternatives,
  field: string,
): number | null {
  const raw = optionalText(scope, selectors);
  return raw === undefined ? null : parsePercentage(raw, field);
}

function parsePercentage(raw: string, field: string): number {
  if (
    (raw.match(/%/g)?.length ?? 0) !== 1 ||
    /(?:S\/|\bPEN\b|US\$|\bUSD\b)/i.test(raw)
  ) {
    throw new PageStructureError("INVALID_FIELD", field);
  }
  return parseNumber(raw.replace("%", ""), field);
}

function parseOptionalDays(
  scope: Cheerio<AnyNode>,
  selectors: SelectorAlternatives,
  field: string,
): number | null {
  const raw = optionalText(scope, selectors);
  if (raw === undefined) return null;
  if (/%|(?:S\/|\bPEN\b|US\$|\bUSD\b)/i.test(raw)) {
    throw new PageStructureError("INVALID_FIELD", field);
  }
  return parseNumber(raw.replace(/\bd[ií]as?\b/gi, ""), field);
}

function parseUnitless(raw: string, field: string): number {
  if (/%|(?:S\/|\bPEN\b|US\$|\bUSD\b)|[A-Za-z]/i.test(raw)) {
    throw new PageStructureError("INVALID_FIELD", field);
  }
  return parseNumber(raw, field);
}

function parseNumber(raw: string, field: string): number {
  const compact = raw.replace(/\u00a0/g, " ").replace(/\s/g, "");
  if (!/^\d[\d.,]*$/.test(compact))
    throw new PageStructureError("INVALID_FIELD", field);

  let normalized: string;
  if (compact.includes(".") && compact.includes(",")) {
    if (/^\d{1,3}(?:\.\d{3})+,\d{1,2}$/.test(compact)) {
      normalized = compact.replace(/\./g, "").replace(",", ".");
    } else if (/^\d{1,3}(?:,\d{3})+\.\d{1,2}$/.test(compact)) {
      normalized = compact.replace(/,/g, "");
    } else {
      throw new PageStructureError("INVALID_FIELD", field);
    }
  } else if (compact.includes(",")) {
    if (/^\d{1,3}(?:,\d{3})+$/.test(compact))
      normalized = compact.replace(/,/g, "");
    else if (/^\d+,\d{1,2}$/.test(compact))
      normalized = compact.replace(",", ".");
    else throw new PageStructureError("INVALID_FIELD", field);
  } else if (compact.includes(".")) {
    if (/^\d{1,3}(?:\.\d{3})+$/.test(compact))
      normalized = compact.replace(/\./g, "");
    else if (/^\d+\.\d{1,2}$/.test(compact)) normalized = compact;
    else throw new PageStructureError("INVALID_FIELD", field);
  } else normalized = compact;

  const value = Number(normalized);
  if (!Number.isFinite(value) || value < 0)
    throw new PageStructureError("INVALID_FIELD", field);
  return value;
}

function parseOptionalDate(
  scope: Cheerio<AnyNode>,
  selectors: SelectorAlternatives,
  field: string,
): string | null {
  const element = findFirst(scope, selectors);
  if (element.length === 0) return null;
  const value = element.attr("datetime")?.trim();
  if (value === undefined || !isIsoDate(value)) {
    throw new PageStructureError("INVALID_FIELD", field);
  }
  return value;
}

function isIsoDate(value: string): boolean {
  const calendar = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(calendar)) return false;
  const calendarDate = new Date(`${calendar}T00:00:00.000Z`);
  if (
    Number.isNaN(calendarDate.valueOf()) ||
    calendarDate.toISOString().slice(0, 10) !== calendar
  ) {
    return false;
  }
  if (value === calendar) return true;
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    ) && !Number.isNaN(Date.parse(value))
  );
}

function validateOpportunityUrl(raw: string): { id: string; url: string } {
  let parsed: URL;
  try {
    parsed = new URL(raw, PRESTAMYPE_ORIGIN);
  } catch {
    throw new PageStructureError("INVALID_URL", "url");
  }
  if (
    parsed.origin !== PRESTAMYPE_ORIGIN ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new PageStructureError("INVALID_URL", "url");
  }
  const match = /^\/app\/inversionista\/oportunidades\/([A-Za-z0-9_-]+)$/.exec(
    parsed.pathname,
  );
  if (match === null) throw new PageStructureError("INVALID_URL", "url");
  return { id: match[1]!, url: parsed.href };
}

function requiredText(
  scope: Cheerio<AnyNode>,
  selectors: SelectorAlternatives,
  field: string,
): string {
  const value = optionalText(scope, selectors);
  if (value === undefined) throw new PageStructureError("MISSING_FIELD", field);
  return value;
}

function optionalText(
  scope: Cheerio<AnyNode>,
  selectors: SelectorAlternatives,
): string | undefined {
  const element = findFirst(scope, selectors);
  if (element.length === 0) return undefined;
  const value = element.text().trim();
  return value === "" ? undefined : value;
}

function requiredAttribute(
  scope: Cheerio<AnyNode>,
  selectors: SelectorAlternatives,
  attribute: string,
  field: string,
): string {
  const value = findFirst(scope, selectors).attr(attribute)?.trim();
  if (value === undefined || value === "")
    throw new PageStructureError("MISSING_FIELD", field);
  return value;
}

function findFirst(
  scope: Cheerio<AnyNode>,
  selectors: SelectorAlternatives,
): Cheerio<AnyNode> {
  for (const selector of selectors) {
    const match = scope.find(selector).first();
    if (match.length > 0) return match;
  }
  return scope.find("__prestamype_no_match__");
}

function findAllByPriority(
  $: CheerioAPI,
  selectors: SelectorAlternatives,
): Cheerio<AnyNode> {
  for (const selector of selectors) {
    const matches = $(selector);
    if (matches.length > 0) return matches;
  }
  return $("__prestamype_no_match__");
}
