import type {
  Evaluation,
  Opportunity,
  PaymentHistory,
  PortfolioSnapshot,
} from "../domain/types.js";
import {
  possibleInvestmentCents,
  resultingConcentrationRatio,
} from "../domain/investment-projection.js";
import { redactSensitiveText } from "../security/redaction.js";

const TELEGRAM_MESSAGE_LIMIT = 4_000;
const MAX_TEXT_FIELD_RENDERED_LENGTH = 400;
const MAX_DETAIL_RENDERED_LENGTH = 480;
const MAX_LINK_RENDERED_LENGTH = 600;
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

function formatOptionalDate(value: string | null): string {
  return value === null ? "no disponible" : formatLimaDateTime(value);
}

function formatHistory(history: PaymentHistory | null): string {
  if (history === null) return "no disponible";
  return `${history.paidOnTime}/${history.totalAuctions} pagadas a tiempo; ${history.overdue} vencidas`;
}

function boundedItems(
  values: readonly string[],
  totalRenderedBudget: number,
  maximumItems: number,
  omittedLabel: string,
): readonly string[] {
  if (values.length === 0) return ["Ninguna"];

  const selected =
    values.length <= maximumItems
      ? values
      : [
          ...values.slice(0, Math.ceil(maximumItems / 2)),
          ...values.slice(-Math.floor(maximumItems / 2)),
        ];
  const omitted = values.length - selected.length;
  const counter = omitted > 0 ? `${omitted} ${omittedLabel}` : null;
  const structuralLength =
    selected.length * 2 + Math.max(0, selected.length - 1);
  const counterLength = counter === null ? 0 : counter.length + 1;
  const perItemBudget = Math.max(
    16,
    Math.floor(
      (totalRenderedBudget - structuralLength - counterLength) /
        selected.length,
    ),
  );
  const rendered = selected.map((item) => `• ${safeText(item, perItemBudget)}`);
  if (counter !== null) rendered.push(counter);
  return rendered;
}

function decisionPresentation(decision: Evaluation["decision"]): {
  title: string;
  label: string;
} {
  switch (decision) {
    case "INVEST":
      return { title: "🔴 OPORTUNIDAD ALTA", label: "INVERTIR" };
    case "REVIEW":
      return { title: "🟡 OPORTUNIDAD PARA REVISAR", label: "REVISAR" };
    case "DO_NOT_INVEST":
      return { title: "⛔ NO INVERTIR", label: "NO INVERTIR" };
    case "IGNORE":
      return { title: "ℹ️ OPORTUNIDAD REGISTRADA", label: "IGNORAR" };
  }
}

function safeHttpsUrl(value: string): string | null {
  try {
    const url = new URL(value);
    const isPrestamypeHost = url.hostname === "www.prestamype.com";
    if (
      url.protocol !== "https:" ||
      !isPrestamypeHost ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      !/^\/app\/inversionista\/oportunidades\/[A-Za-z0-9_-]+$/.test(
        url.pathname,
      ) ||
      `<a href="${escapeHtml(url.href)}">Abrir oportunidad</a>`.length >
        MAX_LINK_RENDERED_LENGTH
    ) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
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
  const presentation = decisionPresentation(evaluation.decision);
  const url = safeHttpsUrl(opportunity.url);
  const warnings = boundedItems(
    evaluation.warnings,
    1_100,
    MAX_WARNINGS,
    "advertencias omitidas",
  );
  const reasons = boundedItems(
    evaluation.reasons.slice(0, 3),
    850,
    3,
    "razones omitidas",
  );
  const sameParty =
    opportunity.supplier.legalName.trim().toLocaleLowerCase("es-PE") ===
    opportunity.debtor.legalName.trim().toLocaleLowerCase("es-PE");
  const possibleAmount = possibleInvestmentCents(opportunity, portfolio);

  const lines: MessageLine[] = [
    { html: `<b>${presentation.title}</b>`, priority: "essential" },
    {
      html: `Decisión: <b>${presentation.label}</b>`,
      priority: "essential",
    },
    {
      html: `Empresa: ${safeText(opportunity.supplier.legalName)}`,
      priority: "essential",
    },
  ];

  if (!sameParty) {
    lines.push({
      html: `Pagador: ${safeText(opportunity.debtor.legalName)}`,
      priority: "essential",
    });
  }

  lines.push(
    {
      html: `Score: ${Number.isFinite(evaluation.score) ? evaluation.score.toFixed(1) : "no disponible"}/100`,
      priority: "essential",
    },
    { html: "⚠️ Advertencias:", priority: "essential" },
    ...warnings.map((html): MessageLine => ({ html, priority: "essential" })),
    { html: "✅ Razones:", priority: "essential" },
    ...reasons.map((html): MessageLine => ({ html, priority: "essential" })),
    ...(evaluation.reasons.length > 3
      ? [
          {
            html: `${evaluation.reasons.length - 3} razones adicionales`,
            priority: "essential" as const,
          },
        ]
      : []),
    url === null
      ? {
          html: "Enlace: no disponible (URL inválida)",
          priority: "essential",
        }
      : {
          html: `<a href="${escapeHtml(url)}">Abrir oportunidad</a>`,
          priority: "essential",
        },
    {
      html: `Riesgo: ${safeText(opportunity.risk)}`,
      priority: "normal",
    },
    {
      html: `Retorno anual: ${formatPercentage(opportunity.annualReturnPct)}`,
      priority: "normal",
    },
  );

  if (opportunity.monthlyReturnPct !== null) {
    lines.push({
      html: `Retorno mensual: ${formatPercentage(opportunity.monthlyReturnPct)}`,
      priority: "normal",
    });
  }

  lines.push(
    {
      html: `Restante: ${formatMoney(opportunity.remainingAmountCents)}`,
      priority: "normal",
    },
    {
      html: `Saldo disponible: ${portfolio.availableBalanceCents === null ? "no disponible" : formatMoney(portfolio.availableBalanceCents)}`,
      priority: "normal",
    },
    {
      html: `Monto posible: ${possibleAmount === null ? "no disponible" : formatMoney(possibleAmount)}`,
      priority: "normal",
    },
    {
      html: `Concentración resultante: ${formatResultingConcentration(opportunity, portfolio)}`,
      priority: "normal",
    },
  );

  if (portfolio.availableBalanceCents === 0) {
    lines.push({
      html: "Sin liquidez disponible; no ejecutar inversión",
      priority: "normal",
    });
  }

  lines.push(
    {
      html: `Detectada: ${formatLimaDateTime(detectedAt)}`,
      priority: "normal",
    },
    {
      html: `ID: ${safeText(opportunity.id)}`,
      priority: "detail",
    },
    {
      html: `Monto total: ${formatMoney(opportunity.totalAmountCents)}`,
      priority: "detail",
    },
    {
      html: `Financiado: ${formatMoney(opportunity.fundedAmountCents)}`,
      priority: "detail",
    },
    {
      html: `Cierre: ${formatOptionalDate(opportunity.closesAt)}`,
      priority: "detail",
    },
    {
      html: `Vencimiento: ${formatOptionalDate(opportunity.dueAt)}`,
      priority: "detail",
    },
    {
      html: `Historial pagador: ${formatHistory(opportunity.debtorHistory)}`,
      priority: "detail",
    },
    {
      html: `Historial proveedor: ${formatHistory(opportunity.supplierHistory)}`,
      priority: "detail",
    },
    {
      html: `Desglose: ${safeText(
        Object.entries(evaluation.components)
          .map(([name, score]) => `${name} ${score}`)
          .join(" · "),
        MAX_DETAIL_RENDERED_LENGTH,
      )}`,
      priority: "detail",
    },
  );

  return renderWithinTelegramLimit(lines);
}

function formatResultingConcentration(
  opportunity: Opportunity,
  portfolio: PortfolioSnapshot,
): string {
  const ratio = resultingConcentrationRatio(opportunity, portfolio);
  return ratio === null ? "no disponible" : `${(ratio * 100).toFixed(1)}%`;
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
