import { load, type Cheerio, type CheerioAPI } from "cheerio";
import type { AnyNode } from "domhandler";

import type {
  Currency,
  InvestmentType,
  PaymentHistory,
  RiskGrade,
} from "../domain/types.js";
import { PageStructureError } from "./errors.js";

export const PRESTAMYPE_ORIGIN = "https://www.prestamype.com";
export const OPPORTUNITIES_URL = `${PRESTAMYPE_ORIGIN}/app/inversionista/oportunidades`;
export const PORTFOLIO_URL = `${PRESTAMYPE_ORIGIN}/app/inversionista/mis-inversiones`;

export const LIVE_SELECTORS = {
  opportunitiesTable: "table.table",
  dataRow: "tr.row_table--clickable",
  loadingRow: "tr.row_table--loading",
  clientCell: ".cell-content.client",
  clientName: ".label",
  clientLegalName: ".sublabel",
  riskShield: 'neo-icon[name="shield-solid"]',
  amountLabel: ".amount-label",
  fundedBar: ".bar",
  fundedPercentage: ".percentage-number",
  investmentType: "p.tir-column",
  unmissableTooltip: "neo-tooltip",
  pager: ".pager",
  panel: ".container-panel .panel-main",
  panelTitle: "h3.panel-title",
  panelTab: ".tabs-container .tab-item",
  panelTabLabel: ".tab-label",
  panelCompanyName: ".company_logo .text-content .title",
  panelCompanyLegalName: ".company_logo .text-content .sub-title",
  riskCard: ".risk-box .risk-card",
  riskCardProtected: ".risk-card--protected",
  riskCardValue: ".risk-card-value",
  field: ".info_opportunity .field",
  fieldTitle: ".field__title",
  fieldSubtitle: ".field__subtitle",
  returnBadge: ".return-badges",
  progressCircle: ".progress-circle",
  collectedAmount: ".amount-circle",
  remainingAmount: ".amount-circle.rest",
  availableBalance: ".balance-card__amount",
  minimumText: ".minimum-text",
  overviewCard: "section.overview .card-overview",
  overviewLabel: ".subtitle-card",
  overviewValue: ".value-card, .text-scale",
  pendingSection: "section.pending",
  completedSection: "section.completed",
  profile: "section.profile",
  profileName: ".profile__titles h4",
  profileTaxId: "p.ruc",
  portfolioCell: "[data-name]",
  portfolioRiskLabel: ".risk-badge-label",
  portfolioStateLabel: ".state-badge-label",
  portfolioCollectionStage: ".collection-stage-badge-label",
  portfolioAmount: ".amount-value",
} as const;

const RISK_GRADES: readonly RiskGrade[] = ["A+", "A", "B", "C", "D", "E"];

const SPANISH_MONTHS: Readonly<Record<string, string>> = {
  ene: "01",
  feb: "02",
  mar: "03",
  abr: "04",
  may: "05",
  jun: "06",
  jul: "07",
  ago: "08",
  sep: "09",
  set: "09",
  oct: "10",
  nov: "11",
  dic: "12",
};

export interface OpportunityRow {
  readonly commercialName: string;
  readonly legalName: string;
  /** Null when the row shows the "Protegida" shield instead of a letter. */
  readonly risk: RiskGrade | null;
  readonly protectedCapital: boolean;
  readonly currency: Currency;
  readonly totalAmountCents: number;
  readonly fundedPct: number;
  readonly investmentType: InvestmentType;
  readonly annualReturnPct: number;
  readonly unmissable: boolean;
  readonly estimatedPaymentAt: string | null;
  readonly daysToPayment: number | null;
}

export interface OpportunityPanel {
  readonly auctionCode: string;
  readonly commercialName: string;
  readonly legalName: string;
  readonly risk: RiskGrade | null;
  readonly protectedCapital: boolean;
  readonly currency: Currency;
  readonly totalAmountCents: number;
  readonly fundedAmountCents: number;
  readonly remainingAmountCents: number;
  readonly fundedPct: number;
  readonly annualReturnPct: number;
  readonly monthlyReturnPct: number | null;
  readonly closesAt: string | null;
  readonly closesInText: string | null;
  readonly dueAt: string | null;
  readonly availableBalanceCents: number | null;
  readonly minimumInvestmentCents: number | null;
}

export interface PartyProfile {
  readonly legalName: string;
  readonly taxId: string | null;
  readonly risk: RiskGrade | null;
}

export interface PortfolioRow {
  readonly commercialName: string;
  readonly legalName: string;
  readonly risk: RiskGrade | null;
  readonly investedAmountCents: number;
  readonly currency: Currency;
  readonly annualReturnPct: number | null;
  readonly state: string;
  readonly collectionStage: string | null;
}

export interface PagerInfo {
  readonly from: number;
  readonly to: number;
  readonly total: number;
}

// ---------------------------------------------------------------- primitives

function text(node: Cheerio<AnyNode>): string {
  return node.text().replace(/\s+/gu, " ").trim();
}

function requireText(node: Cheerio<AnyNode>, field: string): string {
  const value = text(node);
  if (value === "") throw new PageStructureError("MISSING_FIELD", field);
  return value;
}

function parseDecimal(raw: string, field: string): number {
  // Amounts arrive with non-breaking and narrow no-break spaces around them.
  const compact = raw.replace(/[\u00a0\u202f]/gu, " ").replace(/\s/gu, "");
  if (!/^\d[\d.,]*$/u.test(compact))
    throw new PageStructureError("INVALID_FIELD", field);

  let normalized: string;
  const hasDot = compact.includes(".");
  const hasComma = compact.includes(",");
  if (hasDot && hasComma) {
    normalized =
      compact.lastIndexOf(",") > compact.lastIndexOf(".")
        ? compact.replace(/\./gu, "").replace(",", ".")
        : compact.replace(/,/gu, "");
  } else if (hasComma) {
    normalized = /^\d{1,3}(?:,\d{3})+$/u.test(compact)
      ? compact.replace(/,/gu, "")
      : compact.replace(",", ".");
  } else {
    normalized = compact;
  }

  const value = Number(normalized);
  if (!Number.isFinite(value) || value < 0)
    throw new PageStructureError("INVALID_FIELD", field);
  return value;
}

export function parseMoney(
  raw: string,
  field: string,
): { currency: Currency; cents: number } {
  const compact = raw
    .replace(/[\u00a0\u202f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const isPen = /S\/|\bPEN\b/u.test(compact);
  const isUsd = /US\$|\bUSD\b|\$/u.test(compact) && !/S\//u.test(compact);
  if (isPen === isUsd) throw new PageStructureError("INVALID_FIELD", field);
  // Labels wrap the amount ("Mínimo S/100"), so take the number that follows
  // the symbol rather than assuming the string holds nothing else.
  const digits = /(?:S\/|US\$|\$|\bUSD\b|\bPEN\b)\s*(\d[\d.,]*)/u.exec(compact);
  if (digits === null) throw new PageStructureError("INVALID_FIELD", field);
  const cents = Math.round(parseDecimal(digits[1]!, field) * 100);
  if (!Number.isSafeInteger(cents))
    throw new PageStructureError("INVALID_FIELD", field);
  return { currency: isPen ? "PEN" : "USD", cents };
}

export function parsePercentage(raw: string, field: string): number {
  const match = /(\d[\d.,]*)\s*%/u.exec(raw);
  if (match === null) throw new PageStructureError("MISSING_FIELD", field);
  return parseDecimal(match[1]!, field);
}

/** "03 oct. 2026" / "03 sep 2026" → "2026-10-03". */
export function parseSpanishDate(raw: string, field: string): string {
  const match = /(\d{1,2})\s+([a-záéíóú]{3,10})\.?\s+(\d{4})/iu.exec(raw);
  if (match === null) throw new PageStructureError("INVALID_FIELD", field);
  const month = SPANISH_MONTHS[match[2]!.slice(0, 3).toLowerCase()];
  if (month === undefined)
    throw new PageStructureError("UNSUPPORTED_VALUE", field);
  const day = match[1]!.padStart(2, "0");
  const iso = `${match[3]}-${month}-${day}`;
  if (Number.isNaN(Date.parse(`${iso}T00:00:00.000Z`)))
    throw new PageStructureError("INVALID_FIELD", field);
  return iso;
}

function optionalDate(raw: string, field: string): string | null {
  try {
    return parseSpanishDate(raw, field);
  } catch {
    return null;
  }
}

function parseRiskLetter(raw: string): RiskGrade | null {
  const value = raw.trim().toUpperCase();
  return (RISK_GRADES as readonly string[]).includes(value)
    ? (value as RiskGrade)
    : null;
}

// ------------------------------------------------------------ opportunities

export function parsePager($: CheerioAPI): PagerInfo | null {
  const pager = $(LIVE_SELECTORS.pager).first();
  if (pager.length === 0) return null;
  const read = (name: string): number => Number(pager.attr(name));
  const info = { from: read("from"), to: read("to"), total: read("total") };
  return Object.values(info).every((value) => Number.isSafeInteger(value))
    ? info
    : null;
}

/** True while the Vue table still shows its "Buscando las mejores…" row. */
export function isOpportunityTableLoading(html: string): boolean {
  const $ = load(html);
  return (
    $(LIVE_SELECTORS.loadingRow).length > 0 ||
    $(LIVE_SELECTORS.dataRow).length === 0
  );
}

export function parseOpportunityRows(html: string): OpportunityRow[] {
  const $ = load(html);
  const table = $(LIVE_SELECTORS.opportunitiesTable).first();
  if (table.length === 0)
    throw new PageStructureError("MISSING_FIELD", "opportunitiesTable");
  return table
    .find(LIVE_SELECTORS.dataRow)
    .toArray()
    .map((element, index) => parseOpportunityRow($, $(element), index));
}

function parseOpportunityRow(
  $: CheerioAPI,
  row: Cheerio<AnyNode>,
  index: number,
): OpportunityRow {
  const at = (position: number): Cheerio<AnyNode> =>
    row.find("td").eq(position);
  const where = (field: string): string => `row[${index}].${field}`;

  const client = at(0).find(LIVE_SELECTORS.clientCell).first();
  const commercialName = requireText(
    client.find(LIVE_SELECTORS.clientName).first(),
    where("commercialName"),
  );
  const legalName =
    text(client.find(LIVE_SELECTORS.clientLegalName).first()) || commercialName;

  const riskCell = at(1);
  const protectedCapital =
    riskCell.find(LIVE_SELECTORS.riskShield).length > 0 &&
    text(riskCell) === "";
  const risk = protectedCapital ? null : parseRiskLetter(text(riskCell));
  if (!protectedCapital && risk === null)
    throw new PageStructureError("UNSUPPORTED_VALUE", where("risk"));

  const amountCell = at(2);
  const money = parseMoney(
    requireText(
      amountCell.find(LIVE_SELECTORS.amountLabel).first(),
      where("totalAmount"),
    ),
    where("totalAmount"),
  );

  return {
    commercialName,
    legalName,
    risk,
    protectedCapital,
    currency: money.currency,
    totalAmountCents: money.cents,
    fundedPct: parseFundedPercentage(amountCell, where("fundedPct")),
    investmentType: parseInvestmentType(
      requireText(
        at(3).find(LIVE_SELECTORS.investmentType).first(),
        where("investmentType"),
      ),
      where("investmentType"),
    ),
    annualReturnPct: parsePercentage(
      requireText(at(4), where("annualReturnPct")),
      where("annualReturnPct"),
    ),
    unmissable: /imperdible/iu.test(
      at(4).find(LIVE_SELECTORS.unmissableTooltip).attr("description") ?? "",
    ),
    estimatedPaymentAt: optionalDate(
      text(at(5).find(LIVE_SELECTORS.clientName).first()),
      where("estimatedPaymentAt"),
    ),
    daysToPayment: parseRemainingDays(
      text(at(5).find(LIVE_SELECTORS.clientLegalName).first()),
    ),
  };
}

function parseFundedPercentage(cell: Cheerio<AnyNode>, field: string): number {
  const width = /width:\s*([\d.]+)%/u.exec(
    cell.find(LIVE_SELECTORS.fundedBar).first().attr("style") ?? "",
  );
  if (width !== null) return parseDecimal(width[1]!, field);
  const rounded = text(cell.find(LIVE_SELECTORS.fundedPercentage).first());
  return rounded === "" ? 0 : parsePercentage(rounded, field);
}

function parseInvestmentType(raw: string, field: string): InvestmentType {
  const value = raw.trim().toLowerCase();
  if (value === "factoring") return "Factoring";
  if (value === "confirming") return "Confirming";
  throw new PageStructureError("UNSUPPORTED_VALUE", field);
}

function parseRemainingDays(raw: string): number | null {
  const match = /faltan?\s+(\d+)\s+d[ií]as?/iu.exec(raw);
  return match === null ? null : Number(match[1]);
}

// ------------------------------------------------------------------- panel

export function isPanelOpen(html: string): boolean {
  return load(html)(LIVE_SELECTORS.panel).length > 0;
}

export function parseOpportunityPanel(html: string): OpportunityPanel {
  const $ = load(html);
  const panel = $(LIVE_SELECTORS.panel).first();
  if (panel.length === 0)
    throw new PageStructureError("MISSING_FIELD", "panel");

  const fields = new Map<string, Cheerio<AnyNode>>();
  for (const element of panel.find(LIVE_SELECTORS.field).toArray()) {
    const field = $(element);
    const title = text(field.find(LIVE_SELECTORS.fieldTitle).first());
    if (title !== "") fields.set(title.toLowerCase(), field);
  }
  const field = (name: string): Cheerio<AnyNode> => {
    for (const [title, node] of fields) {
      if (title.startsWith(name.toLowerCase())) return node;
    }
    throw new PageStructureError("MISSING_FIELD", `panel.${name}`);
  };
  const fieldValue = (name: string): string =>
    requireText(
      field(name).find(LIVE_SELECTORS.fieldSubtitle).first(),
      `panel.${name}`,
    );

  const riskCard = panel.find(LIVE_SELECTORS.riskCard).first();
  const protectedCapital =
    riskCard.is(LIVE_SELECTORS.riskCardProtected) ||
    /protegida/iu.test(text(riskCard));
  const risk = protectedCapital
    ? null
    : parseRiskLetter(
        text(riskCard.find(LIVE_SELECTORS.riskCardValue).first()),
      );
  if (!protectedCapital && risk === null)
    throw new PageStructureError("UNSUPPORTED_VALUE", "panel.risk");

  const total = parseMoney(
    fieldValue("monto de la subasta"),
    "panel.totalAmount",
  );
  const returns = text(field("retorno").find(LIVE_SELECTORS.returnBadge));
  const monthly = /([\d.,]+)\s*%\s*mensual/iu.exec(returns);
  const closes = field("cierre de subasta");

  const amounts = panel
    .find(LIVE_SELECTORS.collectedAmount)
    .toArray()
    .map((element) => $(element));
  const collected = amounts[0];
  const remaining = panel.find(LIVE_SELECTORS.remainingAmount).first();
  if (collected === undefined || remaining.length === 0)
    throw new PageStructureError("MISSING_FIELD", "panel.progress");

  const percentage = panel
    .find(LIVE_SELECTORS.progressCircle)
    .first()
    .attr("data-percentage");
  const balance = text(panel.find(LIVE_SELECTORS.availableBalance).first());
  const minimum = text(panel.find(LIVE_SELECTORS.minimumText).first());

  return {
    auctionCode: parseAuctionCode(fieldValue("código de subasta")),
    commercialName: requireText(
      panel.find(LIVE_SELECTORS.panelCompanyName).first(),
      "panel.commercialName",
    ),
    legalName:
      text(panel.find(LIVE_SELECTORS.panelCompanyLegalName).first()) ||
      requireText(
        panel.find(LIVE_SELECTORS.panelCompanyName).first(),
        "panel.legalName",
      ),
    risk,
    protectedCapital,
    currency: total.currency,
    totalAmountCents: total.cents,
    fundedAmountCents: parseMoney(text(collected), "panel.fundedAmount").cents,
    remainingAmountCents: parseMoney(text(remaining), "panel.remainingAmount")
      .cents,
    fundedPct:
      percentage === undefined
        ? parsePercentage(text(panel.find(".porcentage").first()), "panel.pct")
        : parseDecimal(percentage, "panel.fundedPct"),
    annualReturnPct: parsePercentage(returns, "panel.annualReturnPct"),
    monthlyReturnPct:
      monthly === null
        ? null
        : parseDecimal(monthly[1]!, "panel.monthlyReturnPct"),
    closesAt: optionalDate(
      text(closes.find(LIVE_SELECTORS.fieldSubtitle).first()),
      "panel.closesAt",
    ),
    closesInText: text(closes.find(".badge").first()) || null,
    dueAt: optionalDate(fieldValue("fecha de pago estimada"), "panel.dueAt"),
    availableBalanceCents:
      balance === "" ? null : parseMoney(balance, "panel.balance").cents,
    minimumInvestmentCents:
      minimum === "" ? null : parseMoney(minimum, "panel.minimum").cents,
  };
}

function parseAuctionCode(raw: string): string {
  const code = raw.trim();
  if (!/^[A-Za-z0-9_-]{4,32}$/u.test(code))
    throw new PageStructureError("INVALID_FIELD", "panel.auctionCode");
  return code;
}

// ------------------------------------------------------- party history tabs

export function parsePartyHistory(html: string): PaymentHistory | null {
  const $ = load(html);
  const pending = countsFrom($, /subastas\s+por\s+pagar/iu);
  const completed = countsFrom($, /subastas\s+pagadas/iu);
  if (pending === null && completed === null) return null;

  const overview = overviewValues($);
  return {
    totalAuctions:
      overview.get("total de subastas") ??
      (pending?.total ?? 0) + (completed?.total ?? 0),
    paidOnTime: completed?.onTime ?? 0,
    paidLate: completed?.late ?? 0,
    currentOnTime: pending?.onTime ?? 0,
    overdue: pending?.late ?? 0,
    averageDelayDays: overview.get("días promedio de retraso") ?? null,
    delinquencyPct: overview.get("porcentaje de morosidad") ?? null,
    historicalAmountCents: overview.get("monto total de subastas") ?? null,
  };
}

function overviewValues($: CheerioAPI): Map<string, number> {
  const values = new Map<string, number>();
  for (const element of $(LIVE_SELECTORS.overviewCard).toArray()) {
    const card = $(element);
    // The label carries an inline tooltip; drop it before reading the name.
    const label = card.clone();
    label.find(".new-tooltip, .popper, .tooltip-text").remove();
    const name = text(label.find(LIVE_SELECTORS.overviewLabel).first())
      .replace(/\s+/gu, " ")
      .toLowerCase();
    const raw = text(card.find(LIVE_SELECTORS.overviewValue).first());
    if (name === "" || raw === "") continue;
    try {
      if (raw.includes("%")) values.set(name, parsePercentage(raw, name));
      else if (/S\/|\$/u.test(raw))
        values.set(name, parseMoney(raw, name).cents);
      else values.set(name, parseDecimal(raw, name));
    } catch {
      // A single unreadable metric must not discard the whole history.
    }
  }
  return values;
}

function countsFrom(
  $: CheerioAPI,
  cardTitle: RegExp,
): { onTime: number; late: number; total: number } | null {
  const card = $("article.base-card")
    .toArray()
    .map((element) => $(element))
    .find((element) =>
      cardTitle.test(text(element.find(".base-card__title").first())),
    );
  const table = card?.find("table").first();
  if (table === undefined || table.length === 0) return null;
  const rows = new Map<string, number>();
  for (const element of table.find("tbody tr").toArray()) {
    const cells = $(element)
      .find("td")
      .toArray()
      .map((cell) => text($(cell)));
    const label = (cells[0] ?? "").toLowerCase();
    const count = cells[1];
    if (label === "" || count === undefined) continue;
    try {
      rows.set(label, parseDecimal(count, label));
    } catch {
      continue;
    }
  }
  const onTime = rows.get("sin retraso") ?? 0;
  const late = rows.get("con retraso") ?? 0;
  return { onTime, late, total: onTime + late };
}

export function parsePartyProfile(html: string): PartyProfile | null {
  const $ = load(html);
  const titles = $(`${LIVE_SELECTORS.profile} .profile__titles`).first();
  if (titles.length === 0) return null;
  const legalName = text(titles.find("h4").first());
  if (legalName === "") return null;
  const profile = titles.closest(LIVE_SELECTORS.profile);
  const taxId = /(\d{11})/u.exec(
    text(profile.find(LIVE_SELECTORS.profileTaxId).first()),
  );
  return {
    legalName,
    taxId: taxId === null ? null : taxId[1]!,
    risk: parseRiskLetter(
      text(profile.find(LIVE_SELECTORS.riskCardValue).first()),
    ),
  };
}

// --------------------------------------------------------------- portfolio

export function parsePortfolioRows(html: string): PortfolioRow[] {
  const $ = load(html);
  return $(LIVE_SELECTORS.dataRow)
    .toArray()
    .flatMap((element, index) => {
      const row = $(element);
      const cell = (name: string): Cheerio<AnyNode> =>
        row.find(`[data-name="${name}"]`).first();
      const client = cell("Cliente");
      if (client.length === 0) return [];
      const commercialName = requireText(
        client.find(".title").first(),
        `portfolio[${index}].commercialName`,
      );
      const amount = parseMoney(
        requireText(
          cell("Monto de inversión")
            .find(LIVE_SELECTORS.portfolioAmount)
            .first(),
          `portfolio[${index}].amount`,
        ),
        `portfolio[${index}].amount`,
      );
      const stage = text(
        cell("Estado").find(LIVE_SELECTORS.portfolioCollectionStage).first(),
      );
      let annualReturnPct: number | null;
      try {
        annualReturnPct = parsePercentage(
          text(cell("Retorno anualizado")),
          `portfolio[${index}].annualReturnPct`,
        );
      } catch {
        annualReturnPct = null;
      }
      return [
        {
          commercialName,
          legalName: text(client.find(".subtitle").first()) || commercialName,
          risk: parseRiskLetter(
            text(
              cell("Riesgo").find(LIVE_SELECTORS.portfolioRiskLabel).first(),
            ),
          ),
          investedAmountCents: amount.cents,
          currency: amount.currency,
          annualReturnPct,
          state: requireText(
            cell("Estado").find(LIVE_SELECTORS.portfolioStateLabel).first(),
            `portfolio[${index}].state`,
          ),
          collectionStage: stage === "" ? null : stage,
        },
      ];
    });
}
