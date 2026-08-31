import { SendMessageCommand } from "@aws-sdk/client-sqs";

const MIN_DELAY_SECONDS = 75;
const DELAY_RANGE_SIZE = 31;
const MESSAGE_BODY = '{"kind":"scan","schemaVersion":1}';

export interface SqsClientLike {
  send(
    command: SendMessageCommand,
    options?: { abortSignal?: AbortSignal },
  ): Promise<unknown>;
}

export interface ScanConfigStore {
  loadConfig<T extends object>(): Promise<T | null>;
  saveConfig<T extends object>(config: T): Promise<void>;
}

export interface SqsSchedulerOptions {
  readonly client: SqsClientLike;
  readonly queueUrl: string;
  readonly configStore: ScanConfigStore;
  readonly clock?: () => Date;
}

export interface ScheduleOptions {
  readonly signal?: AbortSignal;
}

export interface ScheduleResult {
  readonly delaySeconds: number;
}

export type ScheduleNextScan = (
  random?: () => number,
  options?: ScheduleOptions,
) => Promise<ScheduleResult>;

export class SqsSchedulerError extends Error {
  constructor() {
    super("Unable to schedule the next scan");
    this.name = "SqsSchedulerError";
  }
}

function fail(): never {
  throw new SqsSchedulerError();
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function delayFrom(random: () => number): number {
  const value = random();
  if (!Number.isFinite(value) || value < 0 || value >= 1) fail();
  return MIN_DELAY_SECONDS + Math.floor(value * DELAY_RANGE_SIZE);
}

function assertQueueUrl(queueUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(queueUrl);
  } catch {
    fail();
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    !parsed.hostname.endsWith(".amazonaws.com") ||
    parsed.search !== "" ||
    parsed.hash !== ""
  )
    fail();
}

export function createSqsScheduler(
  options: SqsSchedulerOptions,
): ScheduleNextScan {
  assertQueueUrl(options.queueUrl);
  const clock = options.clock ?? (() => new Date());

  return async function scheduleNextScan(
    random = Math.random,
    scheduleOptions,
  ): Promise<ScheduleResult> {
    try {
      scheduleOptions?.signal?.throwIfAborted();
      const delaySeconds = delayFrom(random);

      const output = record(
        await options.client.send(
          new SendMessageCommand({
            QueueUrl: options.queueUrl,
            DelaySeconds: delaySeconds,
            MessageBody: MESSAGE_BODY,
          }),
          scheduleOptions?.signal === undefined
            ? undefined
            : { abortSignal: scheduleOptions.signal },
        ),
      );
      if (
        typeof output?.MessageId !== "string" ||
        output.MessageId.trim() === ""
      )
        fail();
      const acceptedAt = clock();
      if (!Number.isFinite(acceptedAt.getTime())) fail();

      const currentConfig =
        await options.configStore.loadConfig<Record<string, unknown>>();
      await options.configStore.saveConfig({
        ...(currentConfig ?? {}),
        next_scan_at: new Date(
          acceptedAt.getTime() + delaySeconds * 1_000,
        ).toISOString(),
      });
      return Object.freeze({ delaySeconds });
    } catch (error) {
      if (error instanceof SqsSchedulerError) throw error;
      throw new SqsSchedulerError();
    }
  };
}
