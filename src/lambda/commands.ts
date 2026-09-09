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

const PUBLIC = new Set([
  "ayuda",
  "start",
  "oportunidades",
  "detalle",
  "criterios",
]);
const PRIVATE = new Set(["estado", "escanear", "pausar", "reanudar"]);
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
    const match = /^\/([a-z]+)(?:@([a-zA-Z0-9_]+))?(?:\s+(.*))?$/.exec(
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
function brief(item: {
  opportunity: Opportunity;
  evaluation: Evaluation;
  detailCheckedAt?: string;
}): string {
  const o = item.opportunity;
  return `${o.commercialName}\nID: ${o.id}\n${o.currency} ${(o.totalAmountCents / 100).toFixed(2)} · ${o.annualReturnPct}% anual · Riesgo ${o.risk}\nScore ${item.evaluation.score}/100 · ${item.evaluation.decision}\nDatos: ${item.detailCheckedAt ?? "fecha desconocida"}`;
}
async function execute(
  command: string,
  argument: string,
  admin: boolean,
): Promise<string> {
  if (command === "ayuda" || command === "start")
    return (
      "Consultas de datos guardados:\n/oportunidades\n/detalle ID\n/criterios\n/ayuda" +
      (admin
        ? "\n\nAdministración privada:\n/estado\n/escanear\n/pausar\n/reanudar\n\nLímites: 1 comando cada 3 s; 2.000/mes entre todos. Escaneos manuales: 1 cada 10 min, máximo 5/día."
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
      .map(([name, points]) => `${name}: ${points.toFixed(1)}`)
      .join("\n");
    return (
      brief(item as { opportunity: Opportunity; evaluation: Evaluation }) +
      "\n" +
      components +
      "\nInformación guardada; la disponibilidad puede haber cambiado."
    );
  }
  const cfg = await get(configKey);
  if (!cfg?.monitor) return "Configuración no disponible.";
  const monitor = cfg.monitor as MonitorConfig;
  if (command === "criterios")
    return `Monedas: ${monitor.allowedCurrencies.join(", ")}\nRiesgos: ${monitor.allowedRisks.join(", ")}\nRetorno mínimo evaluado: ${monitor.minimumAnnualReturnPct}% anual\nREVISAR desde ${monitor.reviewScore}; INVERTIR desde ${monitor.highPriorityScore}.\nEl score es una regla del monitor, no una probabilidad de cobro. No se realizan inversiones.`;
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
          Date.parse(item.opportunity.closesAt) > Date.now(),
      )
      .sort((a, b) => b.evaluation.score - a.evaluation.score)
      .slice(0, 5);
    return items.length
      ? "Hasta 5 oportunidades guardadas, por score:\n\n" +
          items
            .map((item) =>
              brief(
                item as { opportunity: Opportunity; evaluation: Evaluation },
              ),
            )
            .join("\n\n") +
          "\n\nConfirma disponibilidad en Prestamype."
      : "No hay oportunidades vigentes alertables en los registros consultados. No se ejecutó un escaneo.";
  }
  if (!admin) return "Comando no autorizado.";
  if (command === "estado") {
    const usage = await get(
      key(`USAGE#${new Date().toISOString().slice(0, 7)}`),
    );
    const gb =
      ((usage?.durationMs ?? 0) / 1000) * cfg.costLimits.configuredMemoryGb +
      (usage?.commandGbSeconds ?? 0);
    return `Monitor: ${cfg.enabled ? "activo" : "desactivado"}\nPausa: ${cfg.paused_until ?? "ninguna"}\nÚltimo escaneo: ${cfg.last_scan_at ?? "aún sin registro"}\nResultado: ${cfg.last_scan_summary ?? "sin registro"}\nConsumo registrado + reserva comandos: ${gb.toFixed(0)} GB-s / ${cfg.costLimits.monthlyGbSecondsLimit}\nNo incluye otros proyectos ni solicitudes rechazadas.\nÚltimo error: ${cfg.last_error?.name ?? cfg.last_error?.kind ?? "ninguno registrado"}`;
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
