import type {
  Evaluation,
  Opportunity,
  PaymentHistory,
  PortfolioSnapshot,
} from "../domain/types.js";
import { redactSensitiveText } from "../security/redaction.js";

const TELEGRAM_MESSAGE_LIMIT = 4_000;
const MAX_TEXT_FIELD_RENDERED_LENGTH = 400;
const MAX_WARNINGS = 12;

type TechnicalAlertType =
  | "SESSION_EXPIRED"
  | "CAPTCHA"
  | "RATE_LIMIT"
  | "DOM_CHANGED"
  | "COST_PAUSE"
  | "RECOVERED";

interface TechnicalAlertFields {
  readonly detectedAt?: string;
  readonly safeDetail?: string;
}

export type TechnicalAlertEvent = {
  [Type in TechnicalAlertType]: TechnicalAlertFields & { readonly type: Type };
}[TechnicalAlertType];

interface MessageLine {
  readonly html: string;
  readonly priority: "essential" | "normal" | "detail";
}

const moneyFormatter = new Intl.NumberFormat("es-PE", {
  style: "currency",
  currency: "PEN",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const limaDateTimeFormatter = new Intl.DateTimeFormat("es-PE", {
  timeZone: "America/Lima",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function safeText(
  value: string,
  maximumRenderedLength = MAX_TEXT_FIELD_RENDERED_LENGTH,
): string {
  const escapedCharacters = Array.from(
    redactSensitiveText(value),
    (character) => escapeHtml(character),
  );
  const fullLength = escapedCharacters.reduce(
    (length, character) => length + character.length,
    0,
  );
  if (fullLength <= maximumRenderedLength) return escapedCharacters.join("");

  const output: string[] = [];
  let renderedLength = 0;
  const contentBudget = Math.max(0, maximumRenderedLength - 1);
  for (const escapedCharacter of escapedCharacters) {
    if (renderedLength + escapedCharacter.length > contentBudget) break;
    output.push(escapedCharacter);
    renderedLength += escapedCharacter.length;
  }
  return `${output.join("")}…`;
}

function formatMoney(cents: number): string {
  if (!Number.isFinite(cents)) return "no disponible";
  return moneyFormatter.format(cents / 100).replace(/^S\/\s+/u, "S/");
}

function formatPercentage(value: number): string {
  return Number.isFinite(value) ? `${value.toFixed(2)}%` : "no disponible";
}

function formatLimaDateTime(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime())
    ? "no disponible"
    : limaDateTimeFormatter.format(date);
}

function decisionPresentation(decision: Evaluation["decision"]): string {
  switch (decision) {
    case "INVEST":
      return "🔴 INVERTIR";
    case "REVIEW":
      return "🟡 REVISAR";
    case "DO_NOT_INVEST":
      return "⛔ NO INVERTIR";
    case "IGNORE":
      return "ℹ️ REGISTRADA";
  }
}

const SPANISH_MONTHS = [
  "ene",
  "feb",
  "mar",
  "abr",
  "may",
  "jun",
  "jul",
  "ago",
  "sep",
  "oct",
  "nov",
  "dic",
] as const;

/**
 * Formats a calendar date without moving it.
 *
 * Prestamype publishes closing and payment dates with no time of day. Parsing
 * one as an instant put it at midnight UTC, and rendering that in Lima (UTC-5)
 * showed the day before — "03 sep 2026" arrived as "02/09/2026, 19:00".
 */
function formatCalendarDate(value: string | null): string | null {
  if (value === null) return null;
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (parts === null) {
    const rendered = formatLimaDateTime(value);
    return rendered === "no disponible" ? null : rendered;
  }
  const month = SPANISH_MONTHS[Number(parts[2]) - 1];
  return month === undefined ? null : `${parts[3]} ${month} ${parts[1]}`;
}

/** Drops decimals that carry no information: "0.00%" reads worse than "0%". */
function formatCompactPercentage(value: number): string {
  if (!Number.isFinite(value)) return "no disponible";
  const rounded = Math.round(value * 100) / 100;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(2)}%`;
}

/** Days between two calendar dates, or null when either is unusable. */
function daysBetween(from: Date, to: string | null): number | null {
  if (to === null) return null;
  const target = Date.parse(
    /^\d{4}-\d{2}-\d{2}$/.test(to) ? `${to}T12:00:00Z` : to,
  );
  if (!Number.isFinite(target)) return null;
  return Math.round((target - from.getTime()) / 86_400_000);
}

/**
 * How long is left to act. An auction closing today is worth reading now; a
 * date alone does not convey that.
 */
function formatUrgency(closesAt: string | null, now: Date): string | null {
  const date = formatCalendarDate(closesAt);
  if (date === null) return null;
  const days = daysBetween(now, closesAt);
  if (days === null) return `Cierra ${date}`;
  if (days <= 0) return "Cierra hoy";
  if (days === 1) return "Cierra mañana";
  return `Cierra en ${days} días`;
}

/** "S/11.1M" — magnitude is the point, not the cents. */
function formatMagnitude(cents: number): string {
  const units = cents / 100;
  if (units >= 1_000_000) return `S/${(units / 1_000_000).toFixed(1)}M`;
  if (units >= 1_000) return `S/${Math.round(units / 1_000)}k`;
  return formatMoney(cents);
}

function formatRisk(risk: Opportunity["risk"]): string {
  return risk === "PROTEGIDA" ? "Protegida 🛡" : `Riesgo ${risk}`;
}

/** "51 subastas · 43 a tiempo · mora 0.46% · S/11.1M histórico" */
function formatCompactHistory(history: PaymentHistory | null): string | null {
  if (history === null) return null;
  const parts = [
    `${history.totalAuctions} subastas`,
    `${history.paidOnTime} a tiempo`,
  ];
  if (history.paidLate > 0) parts.push(`${history.paidLate} con retraso`);
  if (history.overdue > 0) parts.push(`${history.overdue} vencidas`);
  if (history.delinquencyPct !== null)
    parts.push(`mora ${formatCompactPercentage(history.delinquencyPct)}`);
  // A large historical volume says the payer is established; a long average
  // delay says the opposite. Both are omitted when the tab does not publish
  // them, which is always the case for the supplier.
  if (
    history.averageDelayDays !== null &&
    history.averageDelayDays > 0 &&
    history.averageDelayDays <= 365
  )
    parts.push(`retraso medio ${Math.round(history.averageDelayDays)} d`);
  if (
    history.historicalAmountCents !== null &&
    history.historicalAmountCents > 0
  )
    parts.push(`${formatMagnitude(history.historicalAmountCents)} histórico`);
  return parts.join(" · ");
}

function renderWithinTelegramLimit(lines: readonly MessageLine[]): string {
  const selected = [...lines];
  for (const priority of ["detail", "normal"] as const) {
    for (let index = selected.length - 1; index >= 0; index -= 1) {
      if (
        selected.map((line) => line.html).join("\n").length <
        TELEGRAM_MESSAGE_LIMIT
      ) {
        return selected.map((line) => line.html).join("\n");
      }
      if (selected[index]?.priority === priority) selected.splice(index, 1);
    }
  }

  const safeLines: string[] = [];
  let renderedLength = 0;
  for (const line of selected) {
    const separatorLength = safeLines.length === 0 ? 0 : 1;
    if (
      renderedLength + separatorLength + line.html.length >=
      TELEGRAM_MESSAGE_LIMIT
    ) {
      continue;
    }
    safeLines.push(line.html);
    renderedLength += separatorLength + line.html.length;
  }
  return safeLines.join("\n");
}

export function formatOpportunityAlert(
  opportunity: Opportunity,
  evaluation: Evaluation,
  portfolio: PortfolioSnapshot,
  detectedAt: Date,
): string {
  void portfolio;
  const lines: MessageLine[] = [];
  const push = (html: string, priority: MessageLine["priority"] = "normal") =>
    lines.push({ html, priority });

  push(
    `<b>${decisionPresentation(evaluation.decision)} · ${safeText(
      opportunity.commercialName || opportunity.debtor.legalName,
    )}</b>`,
    "essential",
  );

  const monthly =
    opportunity.monthlyReturnPct === null
      ? ""
      : ` (${formatPercentage(opportunity.monthlyReturnPct)} mensual)`;
  push(
    `${formatRisk(opportunity.risk)} · ${safeText(opportunity.investmentType)} · ${formatPercentage(
      opportunity.annualReturnPct,
    )} anual${monthly}`,
    "essential",
  );

  const fundedPct =
    opportunity.totalAmountCents > 0
      ? Math.round(
          (opportunity.fundedAmountCents / opportunity.totalAmountCents) * 100,
        )
      : 0;
  push(
    `Restante ${formatMoney(opportunity.remainingAmountCents)} de ${formatMoney(
      opportunity.totalAmountCents,
    )} (${fundedPct}% financiado)`,
    "essential",
  );

  // How long there is to act, and how long the money would be committed. Both
  // are what an annual rate has to be judged against.
  const urgency = formatUrgency(opportunity.closesAt, detectedAt);
  const due = formatCalendarDate(opportunity.dueAt);
  const term = daysBetween(detectedAt, opportunity.dueAt);
  const timing = [
    urgency,
    due === null
      ? null
      : `pago ${due}${term === null || term < 0 ? "" : ` (${term} días)`}`,
  ].filter((part) => part !== null);
  if (timing.length > 0) push(timing.join(" · "), "essential");

  const debtorHistory = formatCompactHistory(opportunity.debtorHistory);
  if (debtorHistory !== null) push(`Deudor ${debtorHistory}`);
  const supplierHistory = formatCompactHistory(opportunity.supplierHistory);
  if (supplierHistory !== null) push(`Proveedor ${supplierHistory}`, "detail");

  for (const warning of evaluation.warnings.slice(0, MAX_WARNINGS))
    push(`⚠️ ${safeText(warning)}`, "essential");

  push(
    `Score ${
      Number.isFinite(evaluation.score) ? evaluation.score.toFixed(1) : "?"
    }/100`,
    "essential",
  );

  return renderWithinTelegramLimit(lines);
}

const technicalTitles: Readonly<Record<TechnicalAlertType, string>> = {
  SESSION_EXPIRED: "🔐 SESIÓN VENCIDA",
  CAPTCHA: "🛑 CAPTCHA DETECTADO",
  RATE_LIMIT: "⏳ LÍMITE DE SOLICITUDES",
  DOM_CHANGED: "🧩 CAMBIO DE ESTRUCTURA",
  COST_PAUSE: "💰 PAUSA POR COSTO",
  RECOVERED: "✅ SERVICIO RECUPERADO",
};

export function formatTechnicalAlert(event: TechnicalAlertEvent): string {
  const lines: MessageLine[] = [
    {
      html: `<b>${technicalTitles[event.type]}</b>`,
      priority: "essential",
    },
  ];
  if (event.safeDetail !== undefined) {
    lines.push({
      html: safeText(event.safeDetail, 2_500),
      priority: "essential",
    });
  }
  if (event.detectedAt !== undefined) {
    lines.push({
      html: `Detectada: ${formatLimaDateTime(event.detectedAt)}`,
      priority: "normal",
    });
  }
  return renderWithinTelegramLimit(lines);
}
