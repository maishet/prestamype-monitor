import type { Context, SQSEvent } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { SQSClient } from "@aws-sdk/client-sqs";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

import {
  runMonitor as runApplicationMonitor,
  type MonitorDependencies,
  type MonitorRunResult,
} from "../application/monitor.js";
import { DynamoRepository } from "../adapters/dynamodb-repository.js";
import {
  createSqsScheduler,
  SqsSchedulerError,
  type ScheduleNextScan,
} from "../adapters/sqs-scheduler.js";
import { loadRuntimeSecrets } from "../adapters/parameter-store.js";
import { PrestamypeClient } from "../browser/prestamype-client.js";
import type { EncryptedSession, MonitorConfig } from "../domain/types.js";
import { TelegramClient } from "../notifications/telegram-client.js";
import { decryptSession as decryptStoredSession } from "../security/session-crypto.js";
import { redactSensitiveText } from "../security/redaction.js";
import {
  LambdaRuntimeError,
  runtimeErrorKind,
  storedRuntimeError,
} from "../runtime/errors.js";
import type {
  CostDecision,
  MonthlyCostLimits,
  MonthlyCostUsage,
} from "../runtime/cost-guard.js";
import { assessMonthlyUsage } from "../runtime/cost-guard.js";

export interface ScanRuntimeConfig {
  readonly enabled: boolean;
  readonly paused_until?: string | null;
  readonly pause_reason?: string | null;
  readonly rate_limit_count?: number;
  readonly monitor: MonitorConfig;
  readonly costLimits: MonthlyCostLimits;
  readonly next_scan_at?: string;
  readonly last_message_id?: string;
  readonly successor_scheduled_for_message_id?: string;
  readonly cost_warning_month?: string;
  readonly pending_runtime_alert?: PendingRuntimeAlert;
  readonly [key: string]: unknown;
}

export interface PendingRuntimeAlert {
  readonly key: string;
  readonly message: string;
  readonly terminal_message_id?: string;
  readonly warning_month?: string;
}

export interface ScanRuntimeStore {
  loadConfig(): Promise<ScanRuntimeConfig | null>;
  saveConfig(config: ScanRuntimeConfig): Promise<void>;
  incrementMonthlyUsage(
    month: string,
    increment: { invocations?: number; durationMs?: number; scans?: number },
  ): Promise<{ invocations: number; durationMs: number; scans: number }>;
  loadEncryptedSession(options?: {
    signal: AbortSignal;
  }): Promise<unknown | null>;
  claimScheduleSlot(
    owner: string,
    expiresAtEpochSeconds: number,
  ): Promise<boolean>;
  releaseScheduleSlot(owner: string): Promise<void>;
}

export interface ScanHandlerDependencies {
  readonly store: ScanRuntimeStore;
  readonly assessCost: (
    usage: MonthlyCostUsage,
    limits: MonthlyCostLimits,
  ) => CostDecision;
  readonly scheduleNextScan: ScheduleNextScan;
  readonly loadSecrets: (options?: {
    signal: AbortSignal;
  }) => Promise<{ sessionKey: Uint8Array }>;
  readonly decryptSession: (
    payload: EncryptedSession,
    key: Uint8Array,
  ) => unknown;
  readonly createMonitorDependencies: (
    storageState: unknown,
    config: MonitorConfig,
    signal: AbortSignal,
    budgetMs: number,
  ) => Promise<MonitorDependencies>;
  readonly runMonitor: (
    dependencies: MonitorDependencies,
    input: { owner: string; lockTtlSeconds: number; alertLeaseSeconds: number },
  ) => Promise<MonitorRunResult>;
  readonly notifyDiagnostic: (
    message: string,
    options?: { signal: AbortSignal },
  ) => Promise<void>;
  readonly clock?: () => Date;
}

export interface LambdaContextLike {
  readonly awsRequestId?: string;
  getRemainingTimeInMillis(): number;
}

type ScanInvocationKind = "scan" | "scan-once";

function invocationKind(event: unknown): ScanInvocationKind | undefined {
  try {
    if (typeof event !== "object" || event === null) return undefined;
    const records = (event as { Records?: unknown }).Records;
    if (!Array.isArray(records) || records.length !== 1) return undefined;
    const record = records[0] as Record<string, unknown>;
    if (
      typeof record !== "object" ||
      record === null ||
      typeof record.messageId !== "string" ||
      !/^[A-Za-z0-9-]{1,128}$/.test(record.messageId) ||
      (record.eventSource !== undefined && record.eventSource !== "aws:sqs") ||
      typeof record.body !== "string" ||
      record.body.length > 1_024
    )
      return undefined;
    const body = JSON.parse(record.body) as unknown;
    if (
      typeof body === "object" &&
      body !== null &&
      ((body as Record<string, unknown>).kind === "scan" ||
        (body as Record<string, unknown>).kind === "scan-once") &&
      (body as Record<string, unknown>).schemaVersion === 1 &&
      Object.keys(body as object).length === 2
    )
      return (body as { kind: ScanInvocationKind }).kind;
    return undefined;
  } catch {
    return undefined;
  }
}

function isPaused(config: ScanRuntimeConfig, now: Date): boolean {
  try {
    if (config.paused_until === "manual") return true;
    if (typeof config.paused_until !== "string" || config.paused_until === "")
      return false;
    const pause = Date.parse(config.paused_until);
    return Number.isFinite(pause) && pause > now.getTime();
  } catch {
    throw new LambdaRuntimeError("Invalid runtime configuration");
  }
}

function enabled(
  config: ScanRuntimeConfig | null,
): config is ScanRuntimeConfig {
  try {
    return (
      config !== null && typeof config === "object" && config.enabled === true
    );
  } catch {
    throw new LambdaRuntimeError("Invalid runtime configuration");
  }
}

function assertRuntimeConfig(config: ScanRuntimeConfig): void {
  try {
    const monitor = config.monitor;
    const limits = config.costLimits;
    if (
      typeof monitor !== "object" ||
      monitor === null ||
      !Array.isArray(monitor.allowedRisks) ||
      !monitor.allowedRisks.every((risk) =>
        ["A+", "A", "B", "C", "D", "E"].includes(risk),
      ) ||
      !Number.isFinite(monitor.minimumAnnualReturnPct) ||
      !Number.isSafeInteger(monitor.minimumInvestmentCents) ||
      monitor.minimumInvestmentCents < 0 ||
      !Number.isFinite(monitor.highPriorityScore) ||
      !Number.isFinite(monitor.reviewScore) ||
      typeof limits !== "object" ||
      limits === null ||
      !Number.isFinite(limits.configuredMemoryGb) ||
      limits.configuredMemoryGb <= 0 ||
      !Number.isFinite(limits.monthlyGbSecondsLimit) ||
      limits.monthlyGbSecondsLimit <= 0
    )
      throw new Error();
  } catch {
    throw new LambdaRuntimeError("Invalid runtime configuration");
  }
}

function monthOf(now: Date): string {
  return now.toISOString().slice(0, 7);
}

function safeNow(clock?: () => Date): Date {
  try {
    const now = clock?.() ?? new Date();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime()))
      throw new Error();
    return now;
  } catch {
    throw new LambdaRuntimeError("Invalid runtime clock");
  }
}

function remainingMillis(context: LambdaContextLike): number {
  try {
    const value = context.getRemainingTimeInMillis();
    if (!Number.isFinite(value) || value < 0) throw new Error();
    return value;
  } catch {
    throw new LambdaRuntimeError("Invalid Lambda context");
  }
}

function requestIdFrom(context: LambdaContextLike): string | undefined {
  try {
    return typeof context.awsRequestId === "string"
      ? context.awsRequestId
      : undefined;
  } catch {
    return undefined;
  }
}

export function createScanHandler(dependencies: ScanHandlerDependencies) {
  const savePatch = async (
    base: ScanRuntimeConfig,
    patch: Record<string, unknown>,
  ): Promise<void> => {
    const latest = await dependencies.store.loadConfig();
    await dependencies.store.saveConfig({
      ...(latest ?? base),
      ...patch,
    } as ScanRuntimeConfig);
  };
  const drainPending = async (
    base: ScanRuntimeConfig,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const pending = base.pending_runtime_alert;
    if (pending === undefined) return true;
    try {
      if (
        typeof pending !== "object" ||
        pending === null ||
        typeof pending.key !== "string" ||
        !/^[A-Za-z0-9:._-]{1,128}$/.test(pending.key) ||
        typeof pending.message !== "string" ||
        pending.message.length === 0 ||
        pending.message.length > 1_000 ||
        (pending.terminal_message_id !== undefined &&
          !/^[A-Za-z0-9-]{1,128}$/.test(pending.terminal_message_id)) ||
        (pending.warning_month !== undefined &&
          !/^\d{4}-(?:0[1-9]|1[0-2])$/.test(pending.warning_month))
      )
        throw new LambdaRuntimeError("Invalid runtime alert outbox");
      signal.throwIfAborted();
      const message = redactSensitiveText(pending.message)
        .replaceAll(/\s+/gu, " ")
        .trim()
        .slice(0, 500);
      if (message === "")
        throw new LambdaRuntimeError("Invalid runtime alert outbox");
      await dependencies.notifyDiagnostic(message, { signal });
      signal.throwIfAborted();
      const latest = (await dependencies.store.loadConfig()) ?? base;
      const { pending_runtime_alert: _pending, ...withoutPending } = latest;
      void _pending;
      await dependencies.store.saveConfig({
        ...withoutPending,
        ...(pending.terminal_message_id === undefined
          ? {}
          : { last_message_id: pending.terminal_message_id }),
        ...(pending.warning_month === undefined
          ? {}
          : { cost_warning_month: pending.warning_month }),
      } as ScanRuntimeConfig);
      return true;
    } catch {
      return false;
    }
  };
  return async function scanHandler(
    event: unknown,
    context: LambdaContextLike,
  ): Promise<void> {
    const kind = invocationKind(event);
    if (kind === undefined || typeof context !== "object" || context === null)
      throw new LambdaRuntimeError("Invalid scan invocation");
    const initialRemaining = remainingMillis(context);
    if (initialRemaining < 3_000) return;
    const controller = new AbortController();
    const now = safeNow(dependencies.clock);
    const timer = setTimeout(
      () => controller.abort(),
      Math.max(0, initialRemaining - 2_500),
    );
    const started = Date.now();
    let metered = false;
    try {
      let config = await dependencies.store.loadConfig();
      if (config?.pending_runtime_alert !== undefined) {
        if (!(await drainPending(config, controller.signal)))
          throw new LambdaRuntimeError("Runtime alert delivery failed");
        config = await dependencies.store.loadConfig();
      }
      if (config === null || typeof config !== "object") return;
      if ((kind === "scan" && !enabled(config)) || isPaused(config, now))
        return;
      assertRuntimeConfig(config);
      const messageId = (event as SQSEvent).Records[0]?.messageId ?? "unknown";
      if (config.last_message_id === messageId) return;
      if (remainingMillis(context) < 3_000) return;
      const usage = await dependencies.store.incrementMonthlyUsage(
        monthOf(now),
        { invocations: 1 },
      );
      metered = true;
      const cost = dependencies.assessCost(
        {
          invocations: usage.invocations,
          averageDurationSeconds:
            usage.invocations === 0
              ? 0
              : usage.durationMs / usage.invocations / 1_000,
          scans: usage.scans,
        },
        config.costLimits,
      );
      if (cost.action === "PAUSE") {
        const pending: PendingRuntimeAlert = {
          key: `cost-pause:${monthOf(now)}`,
          message: `Cost guard paused: ${cost.reason}`,
          terminal_message_id: messageId,
        };
        await savePatch(config, {
          paused_until: "manual",
          pause_reason: `cost:${cost.reason}`,
          pending_runtime_alert: pending,
        });
        if (
          !(await drainPending(
            (await dependencies.store.loadConfig()) ?? {
              ...config,
              pending_runtime_alert: pending,
            },
            controller.signal,
          ))
        )
          throw new LambdaRuntimeError("Runtime alert delivery failed");
        return;
      }
      if (
        cost.action === "WARN" &&
        config.cost_warning_month !== monthOf(now)
      ) {
        const pending: PendingRuntimeAlert = {
          key: `cost-warn:${monthOf(now)}`,
          message: `Cost guard warning: ${cost.reason}`,
          warning_month: monthOf(now),
        };
        await savePatch(config, { pending_runtime_alert: pending });
        if (
          !(await drainPending(
            (await dependencies.store.loadConfig()) ?? {
              ...config,
              pending_runtime_alert: pending,
            },
            controller.signal,
          ))
        )
          throw new LambdaRuntimeError("Runtime alert delivery failed");
        config = (await dependencies.store.loadConfig()) ?? config;
      }
      const successorAccepted =
        kind === "scan-once" ||
        config.successor_scheduled_for_message_id === messageId ||
        (config.successor_scheduled_for_message_id === undefined &&
          typeof config.next_scan_at === "string" &&
          Date.parse(config.next_scan_at) > now.getTime());
      if (!successorAccepted) {
        if (remainingMillis(context) < 3_000) return;
        const claimed = await dependencies.store.claimScheduleSlot(
          messageId,
          Math.floor(now.getTime() / 1_000) + 15 * 24 * 3_600,
        );
        if (claimed) {
          try {
            await dependencies.scheduleNextScan(undefined, {
              signal: controller.signal,
            });
          } catch (error) {
            if (!(error instanceof SqsSchedulerError) || !error.accepted)
              await dependencies.store.releaseScheduleSlot(messageId);
            throw error;
          }
        }
      }
      if (
        kind === "scan" &&
        config.successor_scheduled_for_message_id !== messageId
      )
        await savePatch(config, {
          successor_scheduled_for_message_id: messageId,
        });
      controller.signal.throwIfAborted();
      if (remainingMillis(context) < 5_000) return;
      const encrypted = await dependencies.store.loadEncryptedSession({
        signal: controller.signal,
      });
      if (encrypted === null) {
        const error = new Error("Encrypted session is missing");
        error.name = "SessionExpiredError";
        throw error;
      }
      const secrets = await dependencies.loadSecrets({
        signal: controller.signal,
      });
      controller.signal.throwIfAborted();
      const storageState = dependencies.decryptSession(
        encrypted as EncryptedSession,
        secrets.sessionKey,
      );
      controller.signal.throwIfAborted();
      const monitorDependencies = await dependencies.createMonitorDependencies(
        storageState,
        config.monitor,
        controller.signal,
        Math.max(1, remainingMillis(context) - 2_500),
      );
      controller.signal.throwIfAborted();
      if (remainingMillis(context) < 5_000) return;
      const result = await dependencies.runMonitor(monitorDependencies, {
        owner: messageId,
        lockTtlSeconds: 120,
        alertLeaseSeconds: 300,
      });
      if (result.acquired)
        await dependencies.store.incrementMonthlyUsage(monthOf(now), {
          scans: 1,
        });
      await savePatch(config, {
        last_message_id: messageId,
        ...((config.rate_limit_count ?? 0) !== 0
          ? { rate_limit_count: 0, pause_reason: null }
          : {}),
      });
    } catch (error) {
      const kind = runtimeErrorKind(error);
      const savedError = storedRuntimeError(
        error,
        safeNow(dependencies.clock),
        requestIdFrom(context),
      );
      console.error("Sanitized monitor failure", JSON.stringify(savedError));
      if (error instanceof AggregateError)
        console.error(
          "Sanitized monitor causes",
          JSON.stringify(
            error.errors.map((cause) =>
              storedRuntimeError(
                cause,
                safeNow(dependencies.clock),
                requestIdFrom(context),
              ),
            ),
          ),
        );
      const current = await dependencies.store.loadConfig();
      const messageId = (event as SQSEvent).Records[0]?.messageId ?? "unknown";
      if (current === null) throw error;
      let patch: Record<string, unknown> = { last_error: savedError };
      if (kind === "SessionExpiredError" || kind === "SessionChallengeError")
        patch = {
          ...patch,
          paused_until: "manual",
          pause_reason: kind,
          last_message_id: messageId,
        };
      if (kind === "RateLimitError") {
        const count = (current.rate_limit_count ?? 0) + 1;
        const duration =
          count === 1 ? 6 * 3_600_000 : count === 2 ? 24 * 3_600_000 : null;
        patch = {
          ...patch,
          rate_limit_count: count,
          paused_until:
            duration === null
              ? "manual"
              : new Date(now.getTime() + duration).toISOString(),
          pause_reason: kind,
          last_message_id: messageId,
        };
      }
      if (kind === "PageStructureError") {
        const pending: PendingRuntimeAlert = {
          key: `page-structure:${messageId}`,
          message: `PageStructureError: ${savedError.message}`,
          terminal_message_id: messageId,
        };
        patch = {
          ...patch,
          paused_until: "manual",
          pause_reason: kind,
          pending_runtime_alert: pending,
        };
      }
      await savePatch(current, patch);
      if (kind === "PageStructureError") {
        const latest = await dependencies.store.loadConfig();
        if (latest !== null && !(await drainPending(latest, controller.signal)))
          throw new LambdaRuntimeError("Runtime alert delivery failed");
      }
      if (kind === "RuntimeError") {
        if (error instanceof LambdaRuntimeError) throw error;
        throw new LambdaRuntimeError("Monitor invocation failed");
      }
    } finally {
      clearTimeout(timer);
      const durationMs = Math.max(0, Date.now() - started);
      if (metered) {
        try {
          await dependencies.store.incrementMonthlyUsage(monthOf(now), {
            durationMs,
          });
        } catch {
          /* never mask the primary result */
        }
      }
    }
  };
}

let productionHandler: ReturnType<typeof createScanHandler> | undefined;

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim() === "")
    throw new LambdaRuntimeError("Lambda runtime is not configured");
  return value;
}

function createProductionHandler(): ReturnType<typeof createScanHandler> {
  const repository = new DynamoRepository({
    client: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    tableName: requiredEnvironment("TABLE_NAME"),
  });
  const scheduleNextScan = createSqsScheduler({
    client: new SQSClient({}),
    queueUrl: requiredEnvironment("QUEUE_URL"),
    configStore: repository,
  });
  return createScanHandler({
    store: repository,
    assessCost: assessMonthlyUsage,
    scheduleNextScan,
    loadSecrets: loadRuntimeSecrets,
    decryptSession: decryptStoredSession,
    createMonitorDependencies: async (
      storageState,
      config,
      signal,
      budgetMs,
    ) => {
      signal.throwIfAborted();
      const secrets = await loadRuntimeSecrets({ signal });
      signal.throwIfAborted();
      return {
        repository,
        notifier: new TelegramClient({
          token: secrets.telegramToken,
          chatId: secrets.telegramChatId,
        }),
        createSource: async () =>
          new PrestamypeClient({
            storageState: storageState as object,
            deadlineMs: Math.max(1, Math.min(22_000, budgetMs)),
          }),
        config,
      };
    },
    runMonitor: runApplicationMonitor,
    notifyDiagnostic: async (message, options) => {
      options?.signal.throwIfAborted();
      const secrets = await loadRuntimeSecrets(
        options === undefined ? undefined : { signal: options.signal },
      );
      options?.signal.throwIfAborted();
      await new TelegramClient({
        token: secrets.telegramToken,
        chatId: secrets.telegramChatId,
      }).send(
        message,
        options === undefined ? undefined : { signal: options.signal },
      );
    },
  });
}

export async function handler(
  event: SQSEvent,
  context: Context,
): Promise<void> {
  productionHandler ??= createProductionHandler();
  await productionHandler(event, context);
}
