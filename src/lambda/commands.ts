import { timingSafeEqual } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type QueryCommandOutput,
} from "@aws-sdk/lib-dynamodb";
import { SSMClient, GetParametersCommand } from "@aws-sdk/client-ssm";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { z } from "zod";
import type {
  MonitorConfig,
  Opportunity,
  Evaluation,
} from "../domain/types.js";
import {
  formatElapsed,
  formatLimaDateTime,
} from "../notifications/lima-time.js";

const PUBLIC = new Set([
  "ayuda",
  "start",
  "oportunidades",
  "detalle",
  "criterios",
]);
const PRIVATE = new Set([
  "analizar",
  "estado",
  "escanear",
  "pausar",
  "reanudar",
  "recuperar",
  "sesionestado",
  "sesion-estado",
  "actualizarportafolio",
]);
const MONTHLY_COMMAND_LIMIT = 2_000;
// 128 MiB for the full 10-second timeout, reserved before executing each command.
const COMMAND_GB_SECONDS = 1.25;
const updateSchema = z.object({
  update_id: z.number().int().nonnegative(),
  message: z.object({
    text: z.string().max(256),
    from: z.object({
      id: z.number().int().positive(),
      is_bot: z.literal(false),
    }),
    chat: z.object({
      id: z.number().int(),
      type: z.enum(["private", "group", "supergroup"]),
    }),
    sender_chat: z.unknown().optional(),
  }),
});
interface WebhookEvent {
  requestContext?: { http?: { method?: string } };
  headers?: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
}
export interface CommandDependencies {
  ownerId: string;
  botUsername?: string;
  secret(): Promise<string>;
  chats(): Promise<string[]>;
  claim(update: number, user: string, scan: boolean): Promise<boolean>;
  execute(command: string, argument: string, admin: boolean): Promise<string>;
}
const response = (statusCode = 200, body = "") => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body,
});
function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y);
}
export function createCommandHandler(deps: CommandDependencies) {
  return async (event: WebhookEvent) => {
    if (event.requestContext?.http?.method !== "POST") return response(405);
    if (!event.body || event.body.length > 12_000) return response(413);
    const supplied =
      Object.entries(event.headers ?? {}).find(
        ([key]) => key.toLowerCase() === "x-telegram-bot-api-secret-token",
      )?.[1] ?? "";
    if (!supplied || !sameSecret(supplied, await deps.secret()))
      return response(403);
    let raw: unknown;
    try {
      raw = JSON.parse(
        event.isBase64Encoded
          ? Buffer.from(event.body, "base64").toString("utf8")
          : event.body,
      );
    } catch {
      return response();
    }
    const parsed = updateSchema.safeParse(raw);
    if (!parsed.success || parsed.data.message.sender_chat !== undefined)
      return response();
    const { message, update_id } = parsed.data;
    const user = String(message.from.id),
      chat = String(message.chat.id);
    const admin =
      user === deps.ownerId &&
      chat === deps.ownerId &&
      message.chat.type === "private";
    if (!admin && !(await deps.chats()).includes(chat)) return response();
    const match = /^\/([a-z-]+)(?:@([a-zA-Z0-9_]+))?(?:\s+(.*))?$/.exec(
      message.text.trim(),
    );
    if (!match) return response();
    if (match[2] && match[2].toLowerCase() !== deps.botUsername?.toLowerCase())
      return response();
    const command = match[1]!,
      argument = match[3]?.trim() ?? "";
    // Reject administrative commands before any action/scan quota is consumed.
    if (PRIVATE.has(command) && !admin) return response();
    const recognized = PUBLIC.has(command) || PRIVATE.has(command);
    if (!(await deps.claim(update_id, user, admin && command === "escanear")))
      return response();
    let text: string;
    try {
      text = recognized
        ? await deps.execute(command, argument, admin)
        : "No reconozco ese comando. Usa /ayuda para ver la lista.";
    } catch (error) {
      // Only the error class name: messages may carry AWS or account details.
      const errorName = error instanceof Error ? error.name : typeof error;
      console.warn(
        "Telegram command failed",
        JSON.stringify({ command, error: errorName }),
      );
      // /estado exists only for the admin; others just get a retry hint.
      text = admin
        ? "No pude completar la solicitud. Revisa /estado antes de repetirla, por si la acción ya se aplicó."
        : "No pude completar la solicitud. Intenta de nuevo en un momento.";
    }
    // Telegram executes this method as the webhook response: no polling or extra sendMessage call.
    return response(
      200,
      JSON.stringify({
        method: "sendMessage",
        chat_id: chat,
        text: text.slice(0, 3900),
      }),
    );
  };
}

const db = DynamoDBDocumentClient.from(new DynamoDBClient({ maxAttempts: 2 }));
const ssm = new SSMClient({ maxAttempts: 2 });
const lambda = new LambdaClient({ maxAttempts: 1 });
let cached: { until: number; values: Record<string, string> } | undefined;
async function parameters(): Promise<Record<string, string>> {
  if (cached && cached.until > Date.now()) return cached.values;
  const result = await ssm.send(
    new GetParametersCommand({
      Names: [
        required("WEBHOOK_SECRET_PARAMETER"),
        required("TELEGRAM_CHAT_ID_PARAMETER"),
      ],
      WithDecryption: true,
    }),
  );
  const values: Record<string, string> = {};
  for (const item of result.Parameters ?? [])
    if (item.Name && item.Value) values[item.Name] = item.Value;
  if (result.InvalidParameters?.length || Object.keys(values).length !== 2)
    throw new Error("Command configuration unavailable");
  cached = { until: Date.now() + 60_000, values };
  return values;
}
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error("Missing command configuration");
  return value;
}
const key = (value: string) => ({ PK: value, SK: value });
const configKey = { PK: "CONFIG", SK: "MONITOR" };
async function get(Key: Record<string, string>) {
  return (
    await db.send(
      new GetCommand({
        TableName: required("TABLE_NAME"),
        Key,
        ConsistentRead: true,
      }),
    )
  ).Item;
}
async function claim(
  update: number,
  user: string,
  scan: boolean,
): Promise<boolean> {
  const TableName = required("TABLE_NAME"),
    now = Math.floor(Date.now() / 1000);
  const month = new Date().toISOString().slice(0, 7);
  const day = new Date().toISOString().slice(0, 10);
  const expiresAt = now + 7 * 86400;
  const cooldown = (id: string, seconds: number) => ({
    Update: {
      TableName,
      Key: key(id),
      UpdateExpression: "SET nextAllowed = :next, expiresAt = :ttl",
      ConditionExpression:
        "attribute_not_exists(nextAllowed) OR nextAllowed <= :now",
      ExpressionAttributeValues: {
        ":next": now + seconds,
        ":ttl": expiresAt,
        ":now": now,
      },
    },
  });
  const quota = (id: string, max: number) => ({
    Update: {
      TableName,
      Key: key(id),
      UpdateExpression: "SET expiresAt = :ttl ADD requests :one",
      ConditionExpression: "attribute_not_exists(requests) OR requests < :max",
      ExpressionAttributeValues: {
        ":ttl": now + 40 * 86400,
        ":one": 1,
        ":max": max,
      },
    },
  });
  try {
    await db.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName,
              Item: { ...key(`CMD#UPDATE#${update}`), expiresAt },
              ConditionExpression: "attribute_not_exists(PK)",
            },
          },
          cooldown(`CMD#USER#${user}`, 3),
          quota(`CMD#MONTH#${month}`, MONTHLY_COMMAND_LIMIT),
          {
            Update: {
              TableName,
              Key: key(`USAGE#${month}`),
              UpdateExpression: "ADD commandGbSeconds :amount",
              ExpressionAttributeValues: { ":amount": COMMAND_GB_SECONDS },
            },
          },
          ...(scan
            ? [cooldown("CMD#SCAN", 600), quota(`CMD#SCAN#${day}`, 5)]
            : []),
        ],
      }),
    );
    return true;
  } catch (error) {
    if (error instanceof Error && error.name === "TransactionCanceledException")
      return false;
    throw error;
  }
}
type StoredOpportunity = {
  opportunity: Opportunity;
  evaluation: Evaluation;
  detailCheckedAt?: string;
};

const moneyFormatter = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const integerFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
});
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
];

function money(cents: number, currency: Opportunity["currency"]): string {
  return `${currency === "USD" ? "US$" : "S/"} ${moneyFormatter.format(cents / 100)}`;
}

function calendarDate(value: string | null): string | null {
  const parts = /^(\d{4})-(\d{2})-(\d{2})/.exec(value ?? "");
  const month = parts ? SPANISH_MONTHS[Number(parts[2]) - 1] : undefined;
  return parts && month ? `${parts[3]} ${month} ${parts[1]}` : null;
}

function limaToday(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Lima",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function daysUntil(value: string | null, now: Date): number | null {
  const date = /^\d{4}-\d{2}-\d{2}/.exec(value ?? "")?.[0];
  if (!date) return null;
  return Math.round(
    (Date.parse(`${date}T00:00:00Z`) -
      Date.parse(`${limaToday(now)}T00:00:00Z`)) /
      86_400_000,
  );
}

function closingLabel(closesAt: string | null, now: Date): string | null {
  const days = daysUntil(closesAt, now);
  const date = calendarDate(closesAt);
  if (days === null || date === null) return null;
  if (days < 0) return `Cerró el ${date}`;
  if (days === 0) return "Cierra HOY";
  if (days === 1) return `Cierra mañana (${date})`;
  return `Cierra en ${days} días (${date})`;
}

const decisionLabels: Record<Evaluation["decision"], string> = {
  INVEST: "🔴 INVERTIR",
  REVIEW: "🟡 REVISAR",
  DO_NOT_INVEST: "⛔ NO INVERTIR",
  IGNORE: "ℹ️ REGISTRADA",
};

const warningLabels: Record<string, string> = {
  "Debtor history is unavailable": "Sin historial del deudor",
  "Supplier history is unavailable": "Sin historial del proveedor",
};
const roleLabels: Record<string, string> = {
  debtor: "deudor",
  supplier: "proveedor",
};

/** The evaluator stores some reasons in English; show them in Spanish. */
export function evaluationText(text: string): string {
  const known = warningLabels[text];
  if (known) return known;
  let match = /^Risk (.+) is not allowed$/.exec(text);
  if (match) return `Riesgo ${match[1]} fuera de los permitidos`;
  match = /^Annual return is below ([\d.]+)%$/.exec(text);
  if (match) return `Retorno anual menor al mínimo de ${match[1]}%`;
  match = /^Currency (.+) is not allowed$/.exec(text);
  if (match) return `Moneda ${match[1]} no permitida`;
  match = /^Remaining amount is below (\d+) cents$/.exec(text);
  if (match)
    return `Monto disponible menor al mínimo de ${moneyFormatter.format(Number(match[1]) / 100)}`;
  match = /^Blacklist match for (\w+): (.*)$/s.exec(text);
  if (match)
    return `En lista negra (${roleLabels[match[1]!] ?? match[1]}): ${match[2]}`;
  return text;
}

/** Filtered-out opportunities are stored with score 0 and no components. */
function wasScored(e: Evaluation): boolean {
  return e.score > 0 || Object.keys(e.components).length > 0;
}

function riskLabel(risk: string): string {
  return risk === "PROTEGIDA" ? "Protegida 🛡" : `Riesgo ${risk}`;
}

function historyLine(
  label: string,
  history: Opportunity["debtorHistory"],
): string {
  if (!history || history.totalAuctions <= 0)
    return `${label}: sin historial disponible`;
  const late = history.paidLate > 0 ? ` · ${history.paidLate} tarde` : "";
  const overdue = history.overdue > 0 ? ` · ${history.overdue} vencidas` : "";
  return `${label}: ${history.paidOnTime}/${history.totalAuctions} pagadas a tiempo${late}${overdue}`;
}

/** One entry of /oportunidades: what it is, how much it pays, until when, and why it ranks. */
function brief(
  item: StoredOpportunity,
  now: Date,
  position?: number,
  detailLink = true,
): string {
  const o = item.opportunity;
  const e = item.evaluation;
  const funded =
    o.totalAmountCents > 0
      ? Math.min(
          100,
          Math.round((o.fundedAmountCents / o.totalAmountCents) * 100),
        )
      : 0;
  const monthly =
    o.monthlyReturnPct === null
      ? ""
      : ` (${o.monthlyReturnPct.toFixed(2)}% mensual)`;
  const term =
    daysUntil(o.dueAt, now) !== null && daysUntil(o.closesAt, now) !== null
      ? daysUntil(o.dueAt, now)! - daysUntil(o.closesAt, now)!
      : null;
  const due = calendarDate(o.dueAt);
  const timing = [
    closingLabel(o.closesAt, now),
    due
      ? `Pago ${due}${term !== null && term > 0 ? ` · plazo de ${term} días` : ""}`
      : null,
  ].filter(Boolean);
  const warnings = e.warnings.map(evaluationText);
  return [
    `${position ? `${position}. ` : ""}${decisionLabels[e.decision]} · ${o.commercialName}`,
    `📈 ${o.annualReturnPct.toFixed(2)}% anual${monthly} · ${riskLabel(o.risk)}`,
    `💰 Disponible ${money(o.remainingAmountCents, o.currency)} de ${money(o.totalAmountCents, o.currency)} (${funded}% financiado)`,
    ...(timing.length ? [`⏱ ${timing.join(" · ")}`] : []),
    `👥 ${historyLine("Deudor", o.debtorHistory)}`,
    `     ${historyLine("Proveedor", o.supplierHistory)}`,
    ...warnings.map((warning) => `⚠️ ${warning}`),
    wasScored(e)
      ? `⭐ Score ${e.score.toFixed(1)}/100`
      : "⭐ Sin score: no pasó los filtros obligatorios",
    `🔎 Datos de ${item.detailCheckedAt ? `${formatLimaDateTime(item.detailCheckedAt)} (Lima)` : "fecha desconocida"}`,
    ...(detailLink ? [`ID: ${o.id}`, `Más info: /detalle ${o.id}`] : []),
  ].join("\n");
}

/** Score points per factor; concentration comes from the owner's portfolio. */
function scoreBreakdown(
  components: Readonly<Record<string, number>>,
  includeConcentration: boolean,
): string {
  return Object.entries(components)
    .filter(([name]) => includeConcentration || name !== "concentration")
    .map(
      ([name, points]) =>
        `• ${componentLabels[name] ?? name}: ${points.toFixed(1)}${componentMaximums[name] ? ` / ${componentMaximums[name]}` : ""}`,
    )
    .join("\n");
}

function lastAlertFrom(
  cfg: Record<string, unknown>,
): StoredOpportunity | undefined {
  const alert = cfg.last_alert as
    | { opportunity?: Opportunity; evaluation?: Evaluation; alertedAt?: string }
    | undefined;
  return alert?.opportunity && alert.evaluation
    ? {
        opportunity: alert.opportunity,
        evaluation: alert.evaluation,
        ...(alert.alertedAt ? { detailCheckedAt: alert.alertedAt } : {}),
      }
    : undefined;
}

function lastAlertedSection(item: StoredOpportunity, now: Date): string {
  const o = item.opportunity;
  const closed = daysUntil(o.closesAt, now);
  const state =
    closed !== null && closed < 0
      ? "ya cerró"
      : o.remainingAmountCents <= 0
        ? "ya se financió por completo"
        : "ya no cumple los criterios con los datos más recientes";
  return [`Última oportunidad alertada (${state}):`, brief(item, now)].join(
    "\n",
  );
}

export function formatOpportunityList(
  items: StoredOpportunity[],
  now = new Date(),
  lastAlerted?: StoredOpportunity,
): string {
  if (!items.length)
    return [
      "No hay oportunidades abiertas que cumplan tus criterios en este momento.",
      "Esta consulta usa los datos del último escaneo; no lanza uno nuevo. El monitor revisa Prestamype automáticamente en horario hábil y avisa aquí apenas aparece una. Usa /criterios para ver qué busca.",
      lastAlerted
        ? lastAlertedSection(lastAlerted, now)
        : "Aún no tengo registro de una alerta reciente: apenas se envíe la próxima, la verás aquí.",
    ].join("\n\n");
  return [
    `Oportunidades abiertas que cumplen los criterios (${items.length}), de mayor a menor score:`,
    ...items.map((item, index) => brief(item, now, index + 1)),
    "Datos guardados por el monitor: confirma la disponibilidad real en Prestamype antes de decidir. Usa /criterios para entender el score.",
  ].join("\n\n");
}

export function formatCriteria(monitor: MonitorConfig): string {
  const currencyNames: Record<string, string> = {
    PEN: "soles (PEN)",
    USD: "dólares (USD)",
  };
  // No separate minimum for protected auctions here: the evaluator applies
  // minimumAnnualReturnPct to every risk, protected included.
  return [
    "Qué busca el monitor",
    "",
    "Filtros obligatorios (si falla uno, la oportunidad se descarta):",
    `• Moneda: ${monitor.allowedCurrencies.map((c) => currencyNames[c] ?? c).join(" o ")}`,
    `• Riesgo: ${monitor.allowedRisks.map((risk) => (risk === "PROTEGIDA" ? "Protegida" : risk)).join(", ")}`,
    `• Retorno anual mínimo: ${monitor.minimumAnnualReturnPct}%`,
    `• Monto disponible mínimo: ${moneyFormatter.format(monitor.minimumInvestmentCents / 100)} (en la moneda de la oportunidad)`,
    "• Sin coincidencias con lista negra ni señales de cobranza problemática",
    "",
    "Score de 0 a 100 (suma de 7 factores):",
    "• Historial del deudor: hasta 30 (pagos a tiempo, morosidad, atraso)",
    "• Historial del proveedor: hasta 20",
    "• Retorno anual: hasta 15 (más puntos desde 15% hacia arriba)",
    "• Experiencia: hasta 15 (cuántas subastas y monto se han financiado)",
    "• Riesgo: hasta 10 (A+/A/Protegida suman más que B o C)",
    "• Plazo: hasta 5 (mejor mientras más corto, ideal ≤ 90 días)",
    "• Concentración: hasta 5 (no depender de un solo deudor)",
    "",
    "Qué significa cada resultado:",
    `🟡 REVISAR: score desde ${monitor.reviewScore}. Merece que lo mires.`,
    `🔴 INVERTIR: score desde ${monitor.highPriorityScore}. Máxima prioridad.`,
    "ℹ️ REGISTRADA: pasa los filtros pero no llega al score mínimo; no se avisa.",
    "",
    "El score es una regla del monitor, no una probabilidad de cobro ni una recomendación financiera. El monitor no invierte por ti.",
    "Ver ejemplos reales: /oportunidades",
  ].join("\n");
}

const componentLabels: Record<string, string> = {
  return: "Retorno anual",
  risk: "Riesgo",
  debtorHistory: "Historial del deudor",
  supplierHistory: "Historial del proveedor",
  experience: "Experiencia",
  term: "Plazo",
  concentration: "Concentración",
};
const componentMaximums: Record<string, number> = {
  return: 15,
  risk: 10,
  debtorHistory: 30,
  supplierHistory: 20,
  experience: 15,
  term: 5,
  concentration: 5,
};

export function formatOpportunityAnalysis(
  item: StoredOpportunity & { alerted?: boolean },
  config: MonitorConfig,
  now = new Date(),
): string {
  const { opportunity: o, evaluation: e } = item;
  const scored = wasScored(e);
  const recommended = e.decision === "INVEST" || e.decision === "REVIEW";
  const bullets = (lines: readonly string[]) =>
    lines.map((line) => `• ${evaluationText(line)}`).join("\n");

  // Explain the outcome from what the evaluator actually stored, not by
  // re-checking today's config (which may have changed since).
  let why: string;
  if (e.decision === "DO_NOT_INVEST")
    why = `Por qué se descartó:\n${bullets([...e.warnings, ...e.reasons])}`;
  else if (!scored)
    why = `Por qué no se avisó (no pasó los filtros obligatorios, así que no recibió score):\n${bullets(e.reasons)}`;
  else if (!recommended)
    why = `Por qué no se avisó:\n• Pasó los filtros, pero su score de ${e.score.toFixed(1)} quedó ${Math.max(0, config.reviewScore - e.score).toFixed(1)} puntos por debajo del mínimo de ${config.reviewScore} para avisar.`;
  else
    why = `Puntos a favor:\n${bullets(e.reasons)}${
      e.warnings.length ? `\n\n⚠️ Advertencias:\n${bullets(e.warnings)}` : ""
    }`;
  const breakdown = scoreBreakdown(e.components, true);
  const alerted = item.alerted
    ? "✅ Se envió alerta"
    : recommended
      ? "No se registró alerta enviada"
      : "No se envió alerta";

  return [
    `🔍 Análisis de la subasta ${o.auctionCode}`,
    brief(item, now, undefined, true),
    `${alerted} · avisa desde 🟡 ${config.reviewScore} (REVISAR) y 🔴 ${config.highPriorityScore} (INVERTIR)`,
    why,
    ...(breakdown ? [`Desglose del score:\n${breakdown}`] : []),
    "Basado en los datos guardados por el monitor; la disponibilidad real puede haber cambiado.",
  ].join("\n\n");
}

const errorLabels: Record<string, string> = {
  SessionExpiredError: "sesión expirada",
  SessionChallengeError: "verificación adicional (captcha)",
  RateLimitError: "límite de solicitudes",
  PageStructureError: "cambio de estructura de la página",
  RuntimeError: "error inesperado",
};

const SESSION_PAUSES = new Set([
  "SessionExpiredError",
  "SessionChallengeError",
]);

interface StatusConfig {
  enabled?: boolean;
  paused_until?: string | null;
  pause_reason?: string | null;
  last_scan_at?: string;
  last_scan_summary?: string;
  last_error?: { class?: string; message?: string; timestamp?: string };
  costLimits?: { configuredMemoryGb: number; monthlyGbSecondsLimit: number };
}

function reasonLabel(reason: string): string {
  if (reason.startsWith("cost:"))
    return `presupuesto mensual (${reason.slice(5)})`;
  return errorLabels[reason] ?? reason;
}

function when(value: string, now: Date): string {
  return `${formatLimaDateTime(value)} (${formatElapsed(value, now)})`;
}

/** null when the monitor may run now; otherwise how long the pause lasts. */
function activePause(cfg: StatusConfig, now: Date): string | null {
  if (!cfg.paused_until) return null;
  if (cfg.paused_until === "manual") return "hasta revisión manual";
  const until = Date.parse(cfg.paused_until);
  if (!Number.isFinite(until) || until <= now.getTime()) return null;
  return `hasta ${formatLimaDateTime(until)}`;
}

function pauseAction(reason: string | null | undefined): string | null {
  if (!reason) return null;
  if (SESSION_PAUSES.has(reason))
    return "Acción: ejecuta npm run auth:capture en un equipo con navegador y luego /recuperar.";
  if (reason === "PageStructureError")
    return "Acción: corrige el parser y luego usa /recuperar.";
  if (reason === "RateLimitError")
    return "Acción: espera a que venza la pausa (o usa scripts/resume-monitor.ps1 si es manual).";
  if (reason.startsWith("cost:"))
    return "Acción: revisa el consumo; la pausa por presupuesto se retira con scripts/resume-monitor.ps1 a partir del mes siguiente.";
  return null;
}

/** Raw technical error text, shortened to what the owner can act on. */
function errorDetail(message: string): string {
  if (/Timeout \d+ms exceeded/.test(message))
    return "Prestamype tardó demasiado en responder (tiempo de espera agotado).";
  const firstLine = message.split(/\s+Call log:|\n/)[0]!.trim();
  return firstLine.length > 160 ? `${firstLine.slice(0, 157)}...` : firstLine;
}

function lastErrorLines(cfg: StatusConfig, now: Date): string[] {
  const error = cfg.last_error;
  if (!error?.class) return ["Último error: ninguno registrado"];
  const at = error.timestamp ? ` · ${when(error.timestamp, now)}` : "";
  // last_scan_at is written only when a scan finishes, so a later one means
  // the error no longer applies.
  const resolved =
    error.timestamp !== undefined &&
    cfg.last_scan_at !== undefined &&
    Date.parse(cfg.last_scan_at) > Date.parse(error.timestamp);
  if (resolved)
    return [
      `Último error: ${reasonLabel(error.class)}${at} · ya resuelto: el escaneo siguiente terminó bien`,
    ];
  // Known classes already read clearly in Spanish; their raw English message
  // adds nothing. Unknown ones keep a short version of it.
  const known = error.class in errorLabels && error.class !== "RuntimeError";
  return [
    `Último error: ${reasonLabel(error.class)}${at}`,
    ...(error.message && !known ? [`  ${errorDetail(error.message)}`] : []),
  ];
}

export function formatMonitorStatus(
  cfg: StatusConfig,
  usageGbSeconds: number,
  now = new Date(),
): string {
  const pause = activePause(cfg, now);
  const reason =
    pause && cfg.pause_reason ? reasonLabel(cfg.pause_reason) : null;
  const state = !cfg.enabled
    ? "⛔ desactivado (/reanudar para activarlo)"
    : pause
      ? `⏸️ en pausa${reason ? ` por ${reason}` : ""}`
      : "✅ activo";
  const limit = cfg.costLimits?.monthlyGbSecondsLimit ?? 0;
  const ratio =
    limit > 0 ? ` (${Math.round((usageGbSeconds / limit) * 100)}%)` : "";
  const action = pause ? pauseAction(cfg.pause_reason) : null;
  return [
    `Monitor: ${state}`,
    ...(pause ? [`Pausa: ${pause}`] : []),
    `Último escaneo: ${cfg.last_scan_at ? when(cfg.last_scan_at, now) : "aún sin registro"}`,
    `Resultado: ${cfg.last_scan_summary ?? "sin registro"}`,
    ...lastErrorLines(cfg, now),
    ...(action ? [action] : []),
    `Consumo del mes: ${integerFormatter.format(usageGbSeconds)} / ${integerFormatter.format(limit)} GB-s${ratio}, incluido lo reservado para comandos`,
    "Horas en zona Lima (24 h).",
  ].join("\n");
}

export function formatSessionStatus(
  cfg: StatusConfig,
  hasSession: boolean,
  now = new Date(),
): string {
  const reason = activePause(cfg, now) ? cfg.pause_reason : null;
  const rejected =
    reason && SESSION_PAUSES.has(reason) && cfg.last_error?.timestamp
      ? ` el ${formatLimaDateTime(cfg.last_error.timestamp)}`
      : "";
  const state = !hasSession
    ? "❌ ausente (no hay sesión guardada)"
    : reason === "SessionExpiredError"
      ? `❌ expirada: Prestamype la rechazó${rejected}`
      : reason === "SessionChallengeError"
        ? `❌ bloqueada: Prestamype pidió verificación${rejected}`
        : "✅ guardada (cifrada)";
  const action =
    !hasSession && !(reason && SESSION_PAUSES.has(reason))
      ? pauseAction("SessionExpiredError")
      : pauseAction(reason);
  return [
    `Sesión Prestamype: ${state}`,
    `Pausa activa: ${reason ? reasonLabel(reason) : "ninguna"}`,
    `Último escaneo: ${cfg.last_scan_at ? when(cfg.last_scan_at, now) : "aún sin registro"}`,
    ...lastErrorLines(cfg, now),
    action ?? "No se detecta una pausa por sesión.",
    "Horas en zona Lima (24 h).",
  ].join("\n");
}

export function isOpportunityOpenInLima(
  closesAt: string | null | undefined,
  now = new Date(),
): boolean {
  const closeDate = (closesAt ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(closeDate)) return false;
  const limaDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Lima",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  return closeDate >= limaDate;
}
export function formatHelp(admin: boolean): string {
  const lines = [
    "Comandos disponibles:",
    "/oportunidades — las 5 mejores oportunidades abiertas ahora, con retorno, plazo e historial",
    "/detalle ID — una oportunidad con el desglose de su score (el ID sale de /oportunidades)",
    "/criterios — qué busca el monitor y cómo calcula el score",
    "/ayuda — esta lista",
  ];
  if (admin)
    lines.push(
      "",
      "Administración (solo en este chat privado):",
      "/estado — estado del monitor, último escaneo, errores y consumo del mes",
      "/sesionestado — si la sesión de Prestamype sigue siendo válida",
      "/analizar CODIGO — por qué una subasta alertó o no (código de subasta de Prestamype)",
      "/escanear — pide un escaneo ahora",
      "/pausar — desactiva los escaneos automáticos",
      "/reanudar — reactiva el monitor (no retira pausas de seguridad ni de presupuesto)",
      "/recuperar — retira una pausa por sesión o por cambio en la página y escanea",
      "/actualizarportafolio — vuelve a leer tu portafolio en el próximo escaneo",
      "",
      "Límites: 1 comando cada 3 s y 2.000 al mes entre todos. Escaneos manuales: 1 cada 10 min, máximo 5 al día.",
    );
  return lines.join("\n");
}

async function execute(
  command: string,
  argument: string,
  admin: boolean,
): Promise<string> {
  if (command === "ayuda" || command === "start") return formatHelp(admin);
  if (command === "detalle") {
    if (!/^[a-f0-9]{32}$/.test(argument))
      return "Uso: /detalle ID\nEl ID aparece debajo de cada oportunidad en /oportunidades.";
    const item = await get(key(`OPPORTUNITY#${argument}`));
    if (!item?.opportunity || !item.evaluation)
      return "No encontré una oportunidad con ese ID. Cópialo tal cual desde /oportunidades.";
    // Concentration is derived from the owner's portfolio and must never be exposed.
    const breakdown = scoreBreakdown(
      item.evaluation.components as Record<string, number>,
      admin,
    );
    return [
      brief(item as StoredOpportunity, new Date(), undefined, false),
      breakdown
        ? `Desglose del score:\n${breakdown}`
        : "Sin desglose: no pasó los filtros obligatorios, así que no recibió score.",
      "Datos guardados por el monitor: confirma la disponibilidad real en Prestamype antes de decidir.",
    ].join("\n\n");
  }
  const cfg = await get(configKey);
  if (!cfg?.monitor)
    return "El monitor todavía no tiene configuración guardada.";
  const monitor = cfg.monitor as MonitorConfig;
  if (command === "analizar") {
    if (!/^[A-Za-z0-9]{4,32}$/.test(argument))
      return "Uso: /analizar CODIGO\nUsa el código de subasta que muestra Prestamype (por ejemplo, /analizar XGI0Hlf2).";
    const analysis = (found: Record<string, unknown>) =>
      formatOpportunityAnalysis(
        found as StoredOpportunity & { alerted?: boolean },
        monitor,
      );
    // AUCTION#<code> pointer written with every save (and backfilled for older
    // records): two key reads instead of filtering the whole 1-RCU index,
    // which the scan keeps busy and which throttled this command.
    const pointer = await get(key(`AUCTION#${argument}`));
    if (typeof pointer?.id === "string") {
      const item = await get(key(`OPPORTUNITY#${pointer.id}`));
      if (item?.opportunity && item.evaluation) return analysis(item);
    }
    return "No encontré ese código entre las oportunidades guardadas. Revisa mayúsculas y minúsculas: el código distingue entre ellas.";
  }
  if (command === "criterios") return formatCriteria(monitor);
  if (command === "oportunidades") {
    // Index sort key "C#<close date>#<id>": read only auctions closing today
    // or later instead of the whole history (see opportunityIndexSortKey).
    const rows: NonNullable<QueryCommandOutput["Items"]> = [];
    let cursor: Record<string, unknown> | undefined;
    for (let page = 0; page < 10; page += 1) {
      const result = await db.send(
        new QueryCommand({
          TableName: required("TABLE_NAME"),
          IndexName: "EntityTypeIndex",
          KeyConditionExpression:
            "GSI1PK = :type AND GSI1SK BETWEEN :from AND :to",
          ExpressionAttributeValues: {
            ":type": "OPPORTUNITY",
            ":from": `C#${limaToday(new Date())}`,
            ":to": "C#9999",
          },
          ProjectionExpression: "opportunity,evaluation,detailCheckedAt",
          ExclusiveStartKey: cursor,
        }),
      );
      rows.push(...(result.Items ?? []));
      cursor = result.LastEvaluatedKey;
      if (!cursor) break;
    }
    const items = rows
      .filter(
        (item) =>
          item.opportunity &&
          item.evaluation &&
          ["INVEST", "REVIEW"].includes(item.evaluation.decision) &&
          item.opportunity.remainingAmountCents > 0 &&
          isOpportunityOpenInLima(item.opportunity.closesAt),
      )
      .sort((a, b) => b.evaluation.score - a.evaluation.score)
      .slice(0, 5);
    return formatOpportunityList(
      items as StoredOpportunity[],
      new Date(),
      items.length ? undefined : lastAlertFrom(cfg),
    );
  }
  if (!admin)
    return "Ese comando solo está disponible en el chat privado del administrador.";
  const status = cfg as StatusConfig;
  const now = new Date();
  const pause = activePause(status, now);
  const pauseLabel = status.pause_reason
    ? reasonLabel(status.pause_reason)
    : "motivo no registrado";
  // A timed pause that already ended is not a pause: clear it while turning
  // the monitor on, but only if nobody replaced it in the meantime.
  const enableClearingExpiredPause = () =>
    db.send(
      new UpdateCommand({
        TableName: required("TABLE_NAME"),
        Key: configKey,
        UpdateExpression: status.paused_until
          ? "SET enabled = :yes REMOVE paused_until, pause_reason"
          : "SET enabled = :yes",
        ConditionExpression: status.paused_until
          ? "attribute_exists(PK) AND paused_until = :seen"
          : "attribute_exists(PK) AND (attribute_not_exists(paused_until) OR paused_until = :null)",
        ExpressionAttributeValues: status.paused_until
          ? { ":yes": true, ":seen": status.paused_until }
          : { ":yes": true, ":null": null },
      }),
    );
  const requestScan = () =>
    lambda.send(
      new InvokeCommand({
        FunctionName: required("SCAN_FUNCTION_NAME"),
        InvocationType: "Event",
        Payload: Buffer.from(
          JSON.stringify({
            kind: "telegram-scan",
            schemaVersion: 1,
            replyChatId: required("TELEGRAM_OWNER_ID"),
          }),
        ),
      }),
    );
  if (command === "actualizarportafolio") {
    await db.send(
      new UpdateCommand({
        TableName: required("TABLE_NAME"),
        Key: configKey,
        UpdateExpression: "SET monitor = :monitor",
        ConditionExpression: "attribute_exists(PK)",
        ExpressionAttributeValues: {
          ":monitor": { ...monitor, portfolioRefreshRequested: true },
        },
      }),
    );
    const blocked = !status.enabled
      ? "\nEl monitor está desactivado: se hará cuando lo reactives con /reanudar."
      : pause
        ? `\nEl monitor está en pausa por ${pauseLabel}: se hará cuando se retire la pausa.`
        : "";
    return `Listo: tu portafolio se volverá a leer en el próximo escaneo.${blocked}`;
  }
  if (command === "estado") {
    const usage = await get(key(`USAGE#${now.toISOString().slice(0, 7)}`));
    const gb =
      ((usage?.durationMs ?? 0) / 1000) *
        (status.costLimits?.configuredMemoryGb ?? 0) +
      (usage?.commandGbSeconds ?? 0);
    return formatMonitorStatus(status, gb, now);
  }
  if (command === "sesion-estado" || command === "sesionestado") {
    const session = await get({ PK: "SESSION", SK: "PRESTAMYPE" });
    return formatSessionStatus(status, session !== undefined, now);
  }
  if (command === "pausar") {
    if (!status.enabled)
      return "El monitor ya estaba desactivado. Usa /reanudar para reactivarlo.";
    await db.send(
      new UpdateCommand({
        TableName: required("TABLE_NAME"),
        Key: configKey,
        UpdateExpression: "SET enabled = :no",
        ConditionExpression: "attribute_exists(PK)",
        ExpressionAttributeValues: { ":no": false },
      }),
    );
    return "Monitor desactivado: no habrá escaneos automáticos. Si había uno en curso, terminará normalmente. Usa /reanudar para reactivarlo.";
  }
  if (command === "reanudar") {
    if (pause)
      return `No lo reactivé: hay una pausa por ${pauseLabel} (${pause}). /reanudar no retira pausas de seguridad ni de presupuesto.\n${pauseAction(status.pause_reason) ?? "Revisa /estado para ver qué hacer."}`;
    if (status.enabled && !status.paused_until)
      return "El monitor ya estaba activo. Usa /estado para ver el último escaneo.";
    await enableClearingExpiredPause();
    return "Monitor activado. Escaneará automáticamente según el horario configurado.";
  }
  if (command === "recuperar") {
    if (!pause)
      return "No hay ninguna pausa que retirar. Si quieres un escaneo ahora, usa /escanear.";
    const recoverable = new Set([
      "SessionExpiredError",
      "SessionChallengeError",
      "PageStructureError",
    ]);
    if (!recoverable.has(String(status.pause_reason)))
      return `No retiré la pausa: es por ${pauseLabel} y /recuperar solo retira pausas por sesión o por cambio en la página.\n${pauseAction(status.pause_reason) ?? "Revisa /estado para ver qué hacer."}`;
    await db.send(
      new UpdateCommand({
        TableName: required("TABLE_NAME"),
        Key: configKey,
        UpdateExpression:
          "SET enabled = :yes REMOVE paused_until, pause_reason",
        ConditionExpression: "attribute_exists(PK)",
        ExpressionAttributeValues: { ":yes": true },
      }),
    );
    await requestScan();
    return `Pausa por ${pauseLabel} retirada y escaneo solicitado. Te enviaré el resultado aquí. Si el problema sigue, el monitor volverá a pausarse y te avisaré.`;
  }
  if (command === "escanear") {
    if (!status.enabled)
      return "No pedí el escaneo: el monitor está desactivado. Usa /reanudar primero.";
    if (pause)
      return `No pedí el escaneo: el monitor está en pausa por ${pauseLabel} (${pause}).\n${pauseAction(status.pause_reason) ?? "Revisa /estado para ver qué hacer."}`;
    await requestScan();
    return "Escaneo solicitado. Te enviaré el resultado aquí al terminar (suele tardar hasta 2 minutos). Si ya había otro escaneo en curso, este se omite.";
  }
  return "No reconozco ese comando. Usa /ayuda para ver la lista.";
}
export async function handler(event: WebhookEvent) {
  try {
    return await createCommandHandler({
      ownerId: required("TELEGRAM_OWNER_ID"),
      botUsername: required("TELEGRAM_BOT_USERNAME"),
      secret: async () =>
        (await parameters())[required("WEBHOOK_SECRET_PARAMETER")]!,
      chats: async () => {
        const values = await parameters();
        return values[required("TELEGRAM_CHAT_ID_PARAMETER")]!.split(",").map(
          (x) => x.trim(),
        );
      },
      claim,
      execute,
    })(event);
  } catch {
    console.error("Command webhook unavailable");
    return response(503);
  }
}
