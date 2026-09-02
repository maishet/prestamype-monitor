import type { Context, ScheduledEvent } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { LambdaRuntimeError } from "../runtime/errors.js";

const BODY = '{"kind":"scan","schemaVersion":1}';
const CONFIG_KEY = { PK: "CONFIG", SK: "MONITOR" } as const;
const LOCK_KEY = { PK: "LOCK#SCANNER", SK: "LOCK#SCANNER" } as const;
export interface SupervisorConfig {
  readonly enabled: boolean;
  readonly paused_until?: string | null;
  readonly next_scan_at?: string;
  readonly [key: string]: unknown;
}
export interface SupervisorDependencies {
  readonly loadConfig: (options?: {
    signal: AbortSignal;
  }) => Promise<SupervisorConfig | null>;
  readonly hasActiveLock: (
    nowEpochSeconds: number,
    options?: { signal: AbortSignal },
  ) => Promise<boolean>;
  readonly claimSupervisorMarker: (
    marker: string,
    expiresAtEpochSeconds: number,
    options?: { signal: AbortSignal },
  ) => Promise<boolean>;
  readonly releaseSupervisorMarker: (
    marker: string,
    options?: { signal: AbortSignal },
  ) => Promise<void>;
  readonly scheduleImmediateScan: (options?: {
    signal: AbortSignal;
  }) => Promise<void>;
}
export interface SupervisorResult {
  readonly scheduled: boolean;
  readonly reason:
    | "SCHEDULED"
    | "DISABLED"
    | "PAUSED"
    | "NOT_STALE"
    | "LOCKED"
    | "DUPLICATE"
    | "INVALID";
}

function paused(config: SupervisorConfig, nowMs: number): boolean {
  try {
    if (config.paused_until === "manual") return true;
    const value =
      typeof config.paused_until === "string"
        ? Date.parse(config.paused_until)
        : Number.NaN;
    return Number.isFinite(value) && value > nowMs;
  } catch {
    throw new LambdaRuntimeError("Invalid supervisor configuration");
  }
}

function enabled(config: SupervisorConfig | null): config is SupervisorConfig {
  try {
    return (
      config !== null && typeof config === "object" && config.enabled === true
    );
  } catch {
    throw new LambdaRuntimeError("Invalid supervisor configuration");
  }
}

function nextScanEpoch(config: SupervisorConfig): number {
  try {
    return typeof config.next_scan_at === "string"
      ? Date.parse(config.next_scan_at)
      : Number.NaN;
  } catch {
    throw new LambdaRuntimeError("Invalid supervisor configuration");
  }
}

export async function runSupervisor(
  dependencies: SupervisorDependencies,
  now: Date,
  options?: { signal: AbortSignal },
): Promise<SupervisorResult> {
  let nowMs: number;
  try {
    nowMs = now instanceof Date ? now.getTime() : Number.NaN;
  } catch {
    nowMs = Number.NaN;
  }
  if (!Number.isFinite(nowMs)) return { scheduled: false, reason: "INVALID" };
  options?.signal.throwIfAborted();
  const config = await dependencies.loadConfig(options);
  if (!enabled(config)) return { scheduled: false, reason: "DISABLED" };
  if (paused(config, nowMs)) return { scheduled: false, reason: "PAUSED" };
  const next = nextScanEpoch(config);
  if (Number.isFinite(next) && next >= nowMs - 180_000)
    return { scheduled: false, reason: "NOT_STALE" };
  options?.signal.throwIfAborted();
  if (await dependencies.hasActiveLock(Math.floor(nowMs / 1_000), options))
    return { scheduled: false, reason: "LOCKED" };
  const marker = new Date(Math.floor(nowMs / 600_000) * 600_000).toISOString();
  const claimed = await dependencies.claimSupervisorMarker(
    marker,
    Math.floor(nowMs / 1_000) + 660,
    options,
  );
  if (!claimed) return { scheduled: false, reason: "DUPLICATE" };
  try {
    options?.signal.throwIfAborted();
    await dependencies.scheduleImmediateScan(options);
  } catch (error) {
    try {
      await dependencies.releaseSupervisorMarker(marker, options);
    } catch {
      /* expiry permits later recovery */
    }
    throw error;
  }
  return { scheduled: true, reason: "SCHEDULED" };
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim() === "")
    throw new LambdaRuntimeError("Supervisor runtime is not configured");
  return value;
}
function isConditional(error: unknown): boolean {
  try {
    return (
      typeof error === "object" &&
      error !== null &&
      "name" in error &&
      error.name === "ConditionalCheckFailedException"
    );
  } catch {
    return false;
  }
}

export function createProductionSupervisorDependencies(): SupervisorDependencies {
  const tableName = requiredEnvironment("TABLE_NAME");
  const queueUrl = requiredEnvironment("QUEUE_URL");
  const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const sqs = new SQSClient({});
  return {
    loadConfig: async (options) => {
      try {
        const output = await documentClient.send(
          new GetCommand({ TableName: tableName, Key: CONFIG_KEY }),
          options === undefined ? undefined : { abortSignal: options.signal },
        );
        return (output.Item as SupervisorConfig | undefined) ?? null;
      } catch {
        throw new LambdaRuntimeError("Supervisor configuration read failed");
      }
    },
    hasActiveLock: async (nowEpochSeconds, options) => {
      try {
        const output = await documentClient.send(
          new GetCommand({
            TableName: tableName,
            Key: LOCK_KEY,
            ConsistentRead: true,
            ProjectionExpression: "expiresAt",
          }),
          options === undefined ? undefined : { abortSignal: options.signal },
        );
        return (
          typeof output.Item?.expiresAt === "number" &&
          output.Item.expiresAt > nowEpochSeconds
        );
      } catch {
        throw new LambdaRuntimeError("Supervisor lock read failed");
      }
    },
    claimSupervisorMarker: async (marker, expiresAt, options) => {
      try {
        await documentClient.send(
          new UpdateCommand({
            TableName: tableName,
            Key: CONFIG_KEY,
            UpdateExpression:
              "SET supervisorMarker = :marker, supervisorMarkerExpiresAt = :expires",
            ConditionExpression:
              "attribute_not_exists(supervisorMarker) OR supervisorMarker <> :marker OR supervisorMarkerExpiresAt <= :now",
            ExpressionAttributeValues: {
              ":marker": marker,
              ":expires": expiresAt,
              ":now": expiresAt - 660,
            },
          }),
          options === undefined ? undefined : { abortSignal: options.signal },
        );
        return true;
      } catch (error) {
        if (isConditional(error)) return false;
        throw new LambdaRuntimeError("Supervisor marker claim failed");
      }
    },
    releaseSupervisorMarker: async (marker, options) => {
      try {
        await documentClient.send(
          new UpdateCommand({
            TableName: tableName,
            Key: CONFIG_KEY,
            UpdateExpression:
              "REMOVE supervisorMarker, supervisorMarkerExpiresAt",
            ConditionExpression: "supervisorMarker = :marker",
            ExpressionAttributeValues: { ":marker": marker },
          }),
          options === undefined ? undefined : { abortSignal: options.signal },
        );
      } catch (error) {
        if (!isConditional(error))
          throw new LambdaRuntimeError("Supervisor marker release failed");
      }
    },
    scheduleImmediateScan: async (options) => {
      try {
        const output = await sqs.send(
          new SendMessageCommand({
            QueueUrl: queueUrl,
            DelaySeconds: 0,
            MessageBody: BODY,
          }),
          options === undefined ? undefined : { abortSignal: options.signal },
        );
        if (typeof output.MessageId !== "string" || output.MessageId === "")
          throw new Error();
      } catch {
        throw new LambdaRuntimeError("Supervisor scheduling failed");
      }
    },
  };
}

let productionDependencies: SupervisorDependencies | undefined;

function validSupervisorEvent(event: unknown): event is ScheduledEvent {
  try {
    if (typeof event !== "object" || event === null) return false;
    const candidate = event as Record<string, unknown>;
    return (
      candidate.source === "aws.events" &&
      candidate["detail-type"] === "Scheduled Event" &&
      typeof candidate.detail === "object" &&
      candidate.detail !== null &&
      !Array.isArray(candidate.detail) &&
      Object.keys(candidate.detail).length === 0
    );
  } catch {
    return false;
  }
}

function supervisorRemaining(context: Context): number {
  try {
    const remaining = context.getRemainingTimeInMillis();
    if (!Number.isFinite(remaining) || remaining < 0) throw new Error();
    return remaining;
  } catch {
    throw new LambdaRuntimeError("Invalid supervisor invocation");
  }
}

export async function supervisorHandler(
  event: ScheduledEvent,
  context: Context,
): Promise<SupervisorResult> {
  if (
    !validSupervisorEvent(event) ||
    typeof context !== "object" ||
    context === null
  )
    throw new LambdaRuntimeError("Invalid supervisor invocation");
  const remaining = supervisorRemaining(context);
  if (remaining < 3_000) return { scheduled: false, reason: "INVALID" };
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Math.max(0, remaining - 2_500),
  );
  productionDependencies ??= createProductionSupervisorDependencies();
  try {
    return await runSupervisor(productionDependencies, new Date(), {
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}
