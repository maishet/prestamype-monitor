import { timingSafeEqual } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { SSMClient, GetParametersCommand } from "@aws-sdk/client-ssm";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { z } from "zod";
import type {
  MonitorConfig,
  Opportunity,
  Evaluation,
} from "../domain/types.js";
import { formatElapsed, formatLimaDateTime } from "../notifications/lima-time.js";

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
        : "Comando no disponible. Usa /ayuda.";
    } catch {
      console.warn("Telegram command failed", JSON.stringify({ command }));
      text =
        "No pude completar la solicitud. Consulta /estado antes de repetir una acción.";
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
const SPANISH_MONTHS = [
  "ene", "feb", "mar", "abr", "may", "jun",
  "jul", "ago", "sep", "oct", "nov", "dic",
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
function brief(item: StoredOpportunity, now: Date, position?: number): string {
  const o = item.opportunity;
  const e = item.evaluation;
  const funded =
    o.totalAmountCents > 0
      ? Math.min(100, Math.round((o.fundedAmountCents / o.totalAmountCents) * 100))
      : 0;
  const monthly =
    o.monthlyReturnPct === null ? "" : ` (${o.monthlyReturnPct.toFixed(2)}% mensual)`;
  const term = daysUntil(o.dueAt, now) !== null && daysUntil(o.closesAt, now) !== null
    ? daysUntil(o.dueAt, now)! - daysUntil(o.closesAt, now)!
    : null;
  const due = calendarDate(o.dueAt);
  const timing = [
    closingLabel(o.closesAt, now),
    due ? `Pago ${due}${term !== null && term > 0 ? ` · plazo de ${term} días` : ""}` : null,
  ].filter(Boolean);
  const warnings = e.warnings.map((warning) => warningLabels[warning] ?? warning);
  return [
    `${position ? `${position}. ` : ""}${decisionLabels[e.decision]} · ${o.commercialName}`,
    `📈 ${o.annualReturnPct.toFixed(2)}% anual${monthly} · ${o.risk === "PROTEGIDA" ? "Protegida 🛡" : `Riesgo ${o.risk}`}`,
    `💰 Disponible ${money(o.remainingAmountCents, o.currency)} de ${money(o.totalAmountCents, o.currency)} (${funded}% financiado)`,
    ...(timing.length ? [`⏱ ${timing.join(" · ")}`] : []),
    `👥 ${historyLine("Deudor", o.debtorHistory)}`,
    `     ${historyLine("Proveedor", o.supplierHistory)}`,
    ...warnings.map((warning) => `⚠️ ${warning}`),
    `⭐ Score ${e.score.toFixed(1)}/100`,
    `🔎 Datos de ${item.detailCheckedAt ? `${formatLimaDateTime(item.detailCheckedAt)} (Lima)` : "fecha desconocida"}`,
    `ID: ${o.id}`,
    `Más info: /detalle ${o.id}`,
  ].join("\n");
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
  return [
    `Última oportunidad alertada (${state}):`,
    brief(item, now),
  ].join("\n");
}

export function formatOpportunityList(
  items: StoredOpportunity[],
  now = new Date(),
  lastAlerted?: StoredOpportunity,
): string {
  if (!items.length)
    return [
      "No hay oportunidades abiertas que cumplan tus criterios en este momento.",
      "No se ejecutó un escaneo: el monitor revisa solo en horario hábil y te avisa por aquí apenas aparece una. Usa /criterios para ver qué busca.",
      lastAlerted
        ? lastAlertedSection(lastAlerted, now)
        : "Aún no se ha enviado ninguna alerta.",
    ].join("\n\n");
  return [
    `Oportunidades abiertas que cumplen los criterios (${items.length}), de mayor a menor score:`,
    ...items.map((item, index) => brief(item, now, index + 1)),
    "Datos guardados por el monitor: confirma la disponibilidad real en Prestamype antes de decidir. Usa /criterios para entender el score.",
  ].join("\n\n");
}

/** Most recently alerted opportunity, open or not; detailCheckedAt is set when the alert goes out. */
async function findLastAlerted(): Promise<StoredOpportunity | undefined> {
  let cursor: Record<string, unknown> | undefined;
  let latest: (StoredOpportunity & { detailCheckedAt?: string }) | undefined;
  for (let page = 0; page < 10; page += 1) {
    const result = await db.send(
      new QueryCommand({
        TableName: required("TABLE_NAME"),
        IndexName: "EntityTypeIndex",
        KeyConditionExpression: "GSI1PK = :type",
        FilterExpression: "alerted = :yes",
        ExpressionAttributeValues: { ":type": "OPPORTUNITY", ":yes": true },
        ProjectionExpression: "opportunity,evaluation,detailCheckedAt",
        ExclusiveStartKey: cursor,
        Limit: 100,
      }),
    );
    for (const item of (result.Items ?? []) as StoredOpportunity[]) {
      if (!item.opportunity || !item.evaluation) continue;
      if ((item.detailCheckedAt ?? "") >= (latest?.detailCheckedAt ?? ""))
        latest = item;
    }
    cursor = result.LastEvaluatedKey;
    if (!cursor) break;
  }
  return latest;
}

export function formatCriteria(monitor: MonitorConfig): string {
  const currencyNames: Record<string, string> = { PEN: "soles (PEN)", USD: "dólares (USD)" };
  const protectedMinimum =
    monitor.minimumProtectedAnnualReturnPct !== undefined
      ? `\n   (las protegidas piden mínimo ${monitor.minimumProtectedAnnualReturnPct}%)`
      : "";
  return [
    "Qué busca el monitor",
    "",
    "Filtros obligatorios (si falla uno, la oportunidad se descarta):",
    `• Moneda: ${monitor.allowedCurrencies.map((c) => currencyNames[c] ?? c).join(" o ")}`,
    `• Riesgo: ${monitor.allowedRisks.join(", ")}`,
    `• Retorno anual mínimo: ${monitor.minimumAnnualReturnPct}%${protectedMinimum}`,
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

export function formatOpportunityAnalysis(item: {
  opportunity: Opportunity;
  evaluation: Evaluation;
  alerted?: boolean;
}, config: MonitorConfig): string {
  const { opportunity: o, evaluation: e } = item;
  const threshold = e.decision === "INVEST" ? config.highPriorityScore : config.reviewScore;
  const gap = Math.max(0, config.reviewScore - e.score);
  const passed = [
    config.allowedCurrencies.includes(o.currency) ? `Moneda ${o.currency} permitida` : null,
    config.allowedRisks.includes(o.risk) ? `Riesgo ${o.risk} permitido` : null,
    o.annualReturnPct >= config.minimumAnnualReturnPct
      ? `Retorno ${o.annualReturnPct.toFixed(2)}% supera el mínimo de ${config.minimumAnnualReturnPct}%`
      : null,
    o.remainingAmountCents >= config.minimumInvestmentCents
      ? `Disponible ${o.currency} ${(o.remainingAmountCents / 100).toFixed(2)} supera el mínimo`
      : null,
  ].filter((value): value is string => value !== null);
  const causes = [
    ...e.reasons,
    ...e.warnings,
    ...(e.decision === "IGNORE" && e.score > 0
      ? [`El score quedó ${gap.toFixed(1)} puntos por debajo del mínimo de ${config.reviewScore}`]
      : []),
  ];
  const components = Object.entries(e.components)
    .map(([name, points]) => `${componentLabels[name] ?? name}: ${points.toFixed(2)}`)
    .join("\n");
  return [
    `Análisis: ${o.commercialName}`,
    `Código: ${o.auctionCode}`,
    `Monto: ${o.currency} ${(o.totalAmountCents / 100).toFixed(2)}`,
    `Disponible: ${o.currency} ${(o.remainingAmountCents / 100).toFixed(2)}`,
    `Retorno: ${o.annualReturnPct.toFixed(2)}% anual · Riesgo ${o.risk}`,
    `Resultado: ${e.decision} · Score ${e.score.toFixed(1)}/100`,
    `Umbral aplicable: ${threshold}/100 · Alertada: ${item.alerted ? "sí" : "no"}`,
    passed.length ? `\nReglas cumplidas:\n• ${passed.join("\n• ")}` : "",
    causes.length ? `\nPor qué no alertó / advertencias:\n• ${causes.join("\n• ")}` : "",
    components ? `\nDesglose:\n${components}` : "",
    "\nAnálisis basado en los datos guardados; la disponibilidad puede haber cambiado.",
  ].filter(Boolean).join("\n");
}

const errorLabels: Record<string, string> = {
  SessionExpiredError: "sesión expirada",
  SessionChallengeError: "verificación adicional (captcha)",
  RateLimitError: "límite de solicitudes",
  PageStructureError: "cambio de estructura de la página",
  RuntimeError: "error inesperado",
};

const SESSION_PAUSES = new Set(["SessionExpiredError", "SessionChallengeError"]);

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

function lastErrorLines(cfg: StatusConfig, now: Date): string[] {
  const error = cfg.last_error;
  if (!error?.class) return ["Último error: ninguno registrado"];
  const at = error.timestamp ? ` · ${when(error.timestamp, now)}` : "";
  return [
    `Último error: ${reasonLabel(error.class)}${at}`,
    ...(error.message ? [`  ${error.message.slice(0, 200)}`] : []),
  ];
}

export function formatMonitorStatus(
  cfg: StatusConfig,
  usageGbSeconds: number,
  now = new Date(),
): string {
  const pause = activePause(cfg, now);
  const reason = pause && cfg.pause_reason ? reasonLabel(cfg.pause_reason) : null;
  const state = !cfg.enabled
    ? "⛔ desactivado (/reanudar para activarlo)"
    : pause
      ? `⏸️ en pausa${reason ? ` por ${reason}` : ""}`
      : "✅ activo";
  const limit = cfg.costLimits?.monthlyGbSecondsLimit ?? 0;
  const ratio = limit > 0 ? ` (${Math.round((usageGbSeconds / limit) * 100)}%)` : "";
  const action = pause ? pauseAction(cfg.pause_reason) : null;
  return [
    `Monitor: ${state}`,
    ...(pause ? [`Pausa: ${pause}`] : []),
    `Último escaneo: ${cfg.last_scan_at ? when(cfg.last_scan_at, now) : "aún sin registro"}`,
    `Resultado: ${cfg.last_scan_summary ?? "sin registro"}`,
    ...lastErrorLines(cfg, now),
    ...(action ? [action] : []),
    `Consumo del mes: ${usageGbSeconds.toFixed(0)} / ${limit} GB-s${ratio}, incluye la reserva de comandos.`,
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
  closesAt: string,
  now = new Date(),
): boolean {
  const closeDate = closesAt.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(closeDate)) return false;
  const limaDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Lima",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  return closeDate >= limaDate;
}
async function execute(
  command: string,
  argument: string,
  admin: boolean,
): Promise<string> {
  if (command === "ayuda" || command === "start")
    return (
      "Consultas de datos guardados:\n/oportunidades — las 5 mejores abiertas ahora, con retorno, plazo e historial\n/detalle ID — una oportunidad con su desglose de score (el ID sale de /oportunidades)\n/criterios — qué busca el monitor y cómo se calcula el score\n/ayuda — este mensaje" +
      (admin
        ? "\n\nAdministración privada:\n/analizar CODIGO\n/estado\n/sesionestado\n/actualizarportafolio\n/escanear\n/pausar\n/reanudar\n/recuperar\n\nLímites: 1 comando cada 3 s; 2.000/mes entre todos. Escaneos manuales: 1 cada 10 min, máximo 5/día."
        : "")
    );
  if (command === "detalle") {
    if (!/^[a-f0-9]{32}$/.test(argument))
      return "Uso: /detalle ID (copia el ID de /oportunidades).";
    const item = await get(key(`OPPORTUNITY#${argument}`));
    if (!item?.opportunity || !item.evaluation)
      return "Oportunidad no registrada.";
    // Concentration is derived from the owner's portfolio and must never be exposed.
    const components = Object.entries(
      item.evaluation.components as Record<string, number>,
    )
      .filter(([name]) => admin || name !== "concentration")
      .map(
        ([name, points]) =>
          `• ${componentLabels[name] ?? name}: ${points.toFixed(1)}${componentMaximums[name] ? ` / ${componentMaximums[name]}` : ""}`,
      )
      .join("\n");
    return (
      brief(item as StoredOpportunity, new Date()) +
      "\n\nDesglose del score:\n" +
      components +
      "\n\nInformación guardada; la disponibilidad puede haber cambiado."
    );
  }
  const cfg = await get(configKey);
  if (!cfg?.monitor) return "Configuración no disponible.";
  const monitor = cfg.monitor as MonitorConfig;
  if (command === "analizar") {
    if (!/^[A-Za-z0-9]{4,32}$/.test(argument))
      return "Uso: /analizar CODIGO (usa el código de subasta mostrado por Prestamype).";
    let cursor: Record<string, unknown> | undefined;
    for (let page = 0; page < 10; page += 1) {
      const result = await db.send(new QueryCommand({
        TableName: required("TABLE_NAME"),
        IndexName: "EntityTypeIndex",
        KeyConditionExpression: "GSI1PK = :type",
        FilterExpression: "opportunity.auctionCode = :code",
        ExpressionAttributeValues: { ":type": "OPPORTUNITY", ":code": argument },
        ProjectionExpression: "opportunity,evaluation,alerted,detailCheckedAt",
        ExclusiveStartKey: cursor,
        Limit: 100,
      }));
      const found = result.Items?.find((item) => item.opportunity && item.evaluation);
      if (found)
        return formatOpportunityAnalysis(found as {
          opportunity: Opportunity;
          evaluation: Evaluation;
          alerted?: boolean;
        }, monitor);
      cursor = result.LastEvaluatedKey;
      if (!cursor) break;
    }
    return "No encontré ese código entre las oportunidades guardadas. Revisa mayúsculas y minúsculas.";
  }
  if (command === "criterios")
    return formatCriteria(monitor);
  if (command === "oportunidades") {
    const result = await db.send(
      new QueryCommand({
        TableName: required("TABLE_NAME"),
        IndexName: "EntityTypeIndex",
        KeyConditionExpression: "GSI1PK = :type",
        ExpressionAttributeValues: { ":type": "OPPORTUNITY" },
        Limit: 100,
        ProjectionExpression: "opportunity,evaluation,detailCheckedAt",
      }),
    );
    const items = (result.Items ?? [])
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
      items.length ? undefined : await findLastAlerted(),
    );
  }
  if (!admin) return "Comando no autorizado.";
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
    return "Actualización de portafolio solicitada. Se aplicará en el próximo escaneo.";
  }
  if (command === "estado") {
    const usage = await get(
      key(`USAGE#${new Date().toISOString().slice(0, 7)}`),
    );
    const gb =
      ((usage?.durationMs ?? 0) / 1000) * cfg.costLimits.configuredMemoryGb +
      (usage?.commandGbSeconds ?? 0);
    return formatMonitorStatus(cfg as StatusConfig, gb);
  }
  if (command === "sesion-estado" || command === "sesionestado") {
    const session = await get({ PK: "SESSION", SK: "PRESTAMYPE" });
    return formatSessionStatus(cfg as StatusConfig, session !== undefined);
  }
  if (command === "pausar") {
    await db.send(
      new UpdateCommand({
        TableName: required("TABLE_NAME"),
        Key: configKey,
        UpdateExpression: "SET enabled = :no",
        ConditionExpression: "attribute_exists(PK)",
        ExpressionAttributeValues: { ":no": false },
      }),
    );
    return "Monitor desactivado. Una ejecución que ya empezó puede terminar. Usa /reanudar para activarlo.";
  }
  if (command === "reanudar") {
    if (cfg.paused_until)
      return "Existe una pausa de seguridad o presupuesto. Revisa /estado y resuelve su causa; este comando no la elimina.";
    await db.send(
      new UpdateCommand({
        TableName: required("TABLE_NAME"),
        Key: configKey,
        UpdateExpression: "SET enabled = :yes",
        ConditionExpression:
          "attribute_exists(PK) AND (attribute_not_exists(paused_until) OR paused_until = :null)",
        ExpressionAttributeValues: { ":yes": true, ":null": null },
      }),
    );
    return "Monitor activado. Se ejecutará según el horario configurado.";
  }
  if (command === "recuperar") {
    const recoverable = new Set([
      "SessionExpiredError",
      "SessionChallengeError",
      "PageStructureError",
    ]);
    if (
      cfg.paused_until &&
      cfg.pause_reason &&
      !recoverable.has(String(cfg.pause_reason))
    )
      return `No se retiro la pausa ${cfg.pause_reason}. Resuelve primero la causa y usa /reanudar.`;
    await db.send(
      new UpdateCommand({
        TableName: required("TABLE_NAME"),
        Key: configKey,
        UpdateExpression: "SET enabled = :yes REMOVE paused_until, pause_reason",
        ConditionExpression: "attribute_exists(PK)",
        ExpressionAttributeValues: { ":yes": true },
      }),
    );
    await lambda.send(
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
    return "Pausa recuperable retirada y escaneo solicitado. Si la sesión sigue expirada, recaptúrala manualmente; Telegram te avisará y volverá a pausar el monitor.";
  }
  if (command === "escanear") {
    if (!cfg.enabled || cfg.paused_until)
      return "Escaneo no solicitado: monitor desactivado o con pausa. Consulta /estado.";
    await lambda.send(
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
    return "Escaneo solicitado. Recibirás el resultado al finalizar; puede omitirse si ya existe otro escaneo o una pausa.";
  }
  return "Usa /ayuda.";
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
