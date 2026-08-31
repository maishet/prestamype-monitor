import { SendMessageCommand } from "@aws-sdk/client-sqs";
import { describe, expect, it, vi } from "vitest";

import {
  SqsSchedulerError,
  createSqsScheduler,
  type SqsClientLike,
} from "../../src/adapters/sqs-scheduler.js";

function setup(sendResult: unknown = { MessageId: "message-1" }) {
  const send = vi.fn<SqsClientLike["send"]>(async () => sendResult);
  const loadConfig = vi.fn(async () => ({ enabled: true, untouched: "yes" }));
  const saveConfig = vi.fn(async (config: object) => {
    void config;
  });
  const scheduleNextScan = createSqsScheduler({
    client: { send },
    queueUrl: "https://sqs.sa-east-1.amazonaws.com/123/scan",
    configStore: {
      loadConfig: async <T extends object>() =>
        (await loadConfig()) as unknown as T,
      saveConfig: async <T extends object>(config: T) => saveConfig(config),
    },
    clock: () => new Date("2026-08-30T12:00:00.000Z"),
  });
  return { send, loadConfig, saveConfig, scheduleNextScan };
}

describe("SQS scan scheduler", () => {
  it.each([
    [0, 75],
    [0.5, 90],
    [0.999_999, 105],
  ])(
    "maps random %s to the inclusive integer delay %s",
    async (random, delay) => {
      const { send, saveConfig, scheduleNextScan } = setup();

      await expect(scheduleNextScan(() => random)).resolves.toEqual({
        delaySeconds: delay,
      });

      expect(send).toHaveBeenCalledOnce();
      const command = send.mock.calls[0]![0];
      expect(command).toBeInstanceOf(SendMessageCommand);
      expect((command as SendMessageCommand).input).toEqual({
        QueueUrl: "https://sqs.sa-east-1.amazonaws.com/123/scan",
        DelaySeconds: delay,
        MessageBody: '{"kind":"scan","schemaVersion":1}',
      });
      expect(saveConfig).toHaveBeenCalledWith({
        enabled: true,
        untouched: "yes",
        next_scan_at: new Date(
          Date.parse("2026-08-30T12:00:00.000Z") + delay * 1_000,
        ).toISOString(),
      });
      expect(JSON.stringify((command as SendMessageCommand).input)).not.toMatch(
        /token|session|secret|cookie/i,
      );
    },
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -0.001, 1])(
    "rejects invalid random output %s before sending",
    async (random) => {
      const { send, saveConfig, scheduleNextScan } = setup();
      await expect(scheduleNextScan(() => random)).rejects.toBeInstanceOf(
        SqsSchedulerError,
      );
      expect(send).not.toHaveBeenCalled();
      expect(saveConfig).not.toHaveBeenCalled();
    },
  );

  it("persists only after SQS acceptance and never leaks hostile AWS errors", async () => {
    const hostile = new Error("token=VERY_SECRET session=COOKIE");
    const { send, loadConfig, saveConfig, scheduleNextScan } = setup();
    send.mockRejectedValueOnce(hostile);

    const failure = await scheduleNextScan(() => 0.5).catch(
      (error: unknown) => error,
    );
    expect(loadConfig).not.toHaveBeenCalled();
    expect(saveConfig).not.toHaveBeenCalled();
    expect(failure).toBeInstanceOf(SqsSchedulerError);
    expect(String(failure)).not.toContain("VERY_SECRET");
    expect((failure as Error).cause).toBeUndefined();
  });

  it("does not persist when SQS omits its acceptance identifier", async () => {
    const { loadConfig, saveConfig, scheduleNextScan } = setup({});
    await expect(scheduleNextScan(() => 0.5)).rejects.toBeInstanceOf(
      SqsSchedulerError,
    );
    expect(loadConfig).not.toHaveBeenCalled();
    expect(saveConfig).not.toHaveBeenCalled();
  });

  it("measures next_scan_at from SQS acceptance rather than invocation start", async () => {
    let accept!: (value: { MessageId: string }) => void;
    const accepted = new Promise<{ MessageId: string }>((resolve) => {
      accept = resolve;
    });
    let currentTime = new Date("2026-08-30T12:00:00.000Z");
    const clock = vi.fn(() => currentTime);
    const send = vi.fn<SqsClientLike["send"]>(async () => accepted);
    const saveConfig = vi.fn(async (config: object) => {
      void config;
    });
    const scheduleNextScan = createSqsScheduler({
      client: { send },
      queueUrl: "https://sqs.sa-east-1.amazonaws.com/123/scan",
      configStore: {
        loadConfig: async <T extends object>() => ({}) as T,
        saveConfig: async <T extends object>(config: T) => saveConfig(config),
      },
      clock,
    });

    const scheduled = scheduleNextScan(() => 0);
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    expect(clock).not.toHaveBeenCalled();
    currentTime = new Date("2026-08-30T12:00:20.000Z");
    accept({ MessageId: "accepted-later" });
    await scheduled;

    expect(saveConfig).toHaveBeenCalledWith({
      next_scan_at: "2026-08-30T12:01:35.000Z",
    });
  });

  it("forwards cancellation during send but persists after acceptance", async () => {
    const controller = new AbortController();
    const { send, saveConfig, scheduleNextScan } = setup();
    send.mockImplementationOnce(async (_command, options) => {
      expect(options).toEqual({ abortSignal: controller.signal });
      controller.abort();
      return { MessageId: "accepted-but-cancelled" };
    });

    await expect(
      scheduleNextScan(() => 0.5, { signal: controller.signal }),
    ).resolves.toEqual({ delaySeconds: 90 });
    expect(saveConfig).toHaveBeenCalledOnce();
  });
});
