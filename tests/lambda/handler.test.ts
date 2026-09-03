import { describe, expect, it, vi } from "vitest";
import { runMonitor as runApplicationMonitor } from "../../src/application/monitor.js";
import { SqsSchedulerError } from "../../src/adapters/sqs-scheduler.js";
import {
  createScanHandler,
  type ScanHandlerDependencies,
  type ScanRuntimeConfig,
} from "../../src/lambda/handler.js";
import {
  SessionChallengeError,
  SessionExpiredError,
  RateLimitError,
  PageStructureError,
} from "../../src/browser/errors.js";

const NOW = new Date("2026-08-26T12:00:00.000Z");
const EVENT = {
  Records: [
    { messageId: "message-1", body: '{"kind":"scan","schemaVersion":1}' },
  ],
};
const ONE_SHOT_EVENT = {
  Records: [
    { messageId: "one-shot-1", body: '{"kind":"scan-once","schemaVersion":1}' },
  ],
};
const CONFIG: ScanRuntimeConfig = {
  enabled: true,
  monitor: {
    allowedRisks: ["A+", "A", "B"],
    minimumAnnualReturnPct: 12,
    currency: "PEN",
    minimumInvestmentCents: 10_000,
    highPriorityScore: 80,
    reviewScore: 60,
  },
  costLimits: { monthlyGbSecondsLimit: 400_000, configuredMemoryGb: 1 },
};

function fixture(overrides: Partial<ScanHandlerDependencies> = {}) {
  const calls: string[] = [];
  let config: ScanRuntimeConfig = CONFIG;
  const scheduleClaims = new Set<string>();
  const store = {
    loadConfig: vi.fn(async () => {
      calls.push("config");
      return config;
    }),
    saveConfig: vi.fn(async (next: object) => {
      calls.push("save");
      config = next as ScanRuntimeConfig;
    }),
    incrementMonthlyUsage: vi.fn(
      async (
        _month: string,
        increment: {
          invocations?: number;
          durationMs?: number;
          scans?: number;
        },
      ) => {
        calls.push(
          increment.invocations
            ? "usage"
            : increment.scans
              ? "scan-count"
              : "duration",
        );
        return {
          invocations: increment.invocations ?? 1,
          durationMs: increment.durationMs ?? 0,
          scans: increment.scans ?? 0,
        };
      },
    ),
    loadEncryptedSession: vi.fn(async () => {
      calls.push("session");
      return { schemaVersion: 1 };
    }),
    claimScheduleSlot: vi.fn(async (owner: string, expiresAt: number) => {
      void expiresAt;
      if (scheduleClaims.has(owner)) return false;
      scheduleClaims.add(owner);
      return true;
    }),
    releaseScheduleSlot: vi.fn(async (owner: string) => {
      scheduleClaims.delete(owner);
    }),
  };
  const dependencies: ScanHandlerDependencies = {
    store,
    assessCost: () => {
      calls.push("cost");
      return {
        action: "CONTINUE",
        reason: "USAGE",
        utilizationRatio: 0,
        projectedGbSeconds: 0,
      };
    },
    scheduleNextScan: vi.fn(async () => {
      calls.push("schedule");
      return { delaySeconds: 75 };
    }),
    loadSecrets: vi.fn(async () => {
      calls.push("secrets");
      return { sessionKey: new Uint8Array(32) };
    }),
    decryptSession: vi.fn(() => {
      calls.push("decrypt");
      return {};
    }),
    createMonitorDependencies: vi.fn(async () => {
      calls.push("browser");
      return {} as never;
    }),
    runMonitor: vi.fn(async () => {
      calls.push("monitor");
      return { acquired: true, evaluated: 0, alertsSent: 0 };
    }),
    notifyDiagnostic: vi.fn(async () => undefined),
    clock: () => NOW,
    ...overrides,
  };
  return {
    handler: createScanHandler(dependencies),
    dependencies,
    store,
    calls,
    config: () => config,
  };
}

describe("scan Lambda handler", () => {
  it("real runMonitor closes its source and releases its lock after failure", async () => {
    const close = vi.fn(async () => undefined);
    const releaseLock = vi.fn(async () => undefined);
    const repository = {
      acquireLock: vi.fn(async () => true),
      releaseLock,
      getBlacklist: vi.fn(async () => []),
      getOpportunityFingerprints: vi.fn(async () => ({})),
      addBlacklistEntries: vi.fn(),
      saveOpportunity: vi.fn(),
      claimAlert: vi.fn(),
      completeAlert: vi.fn(),
      releaseAlertClaim: vi.fn(),
    };
    await expect(
      runApplicationMonitor(
        {
          repository,
          notifier: { send: vi.fn() },
          createSource: async () => ({
            getPortfolio: async () => ({
              availableBalanceCents: null,
              activeTotalCents: null,
              exposureByTaxId: {},
            }),
            listEligibleOpportunities: async () => {
              throw new Error("opportunities failed");
            },
            close,
          }),
          config: CONFIG.monitor,
        },
        { owner: "message-1", lockTtlSeconds: 120, alertLeaseSeconds: 300 },
      ),
    ).rejects.toThrow("opportunities failed");
    expect(close).toHaveBeenCalledOnce();
    expect(releaseLock).toHaveBeenCalledWith("message-1");
  });
  it("schedules before decrypting, creating the browser, and running", async () => {
    const f = fixture();
    await f.handler(EVENT, {
      awsRequestId: "request-1",
      getRemainingTimeInMillis: () => 30_000,
    });
    expect(f.calls).toEqual(
      expect.arrayContaining([
        "config",
        "schedule",
        "session",
        "decrypt",
        "browser",
        "monitor",
      ]),
    );
    expect(f.calls.indexOf("schedule")).toBeLessThan(
      f.calls.indexOf("browser"),
    );
    expect(
      f.calls
        .filter(
          (call, index, all) =>
            [
              "config",
              "usage",
              "cost",
              "schedule",
              "session",
              "secrets",
              "decrypt",
              "browser",
              "monitor",
            ].includes(call) && all.indexOf(call) === index,
        )
        .slice(0, 9),
    ).toEqual([
      "config",
      "usage",
      "cost",
      "schedule",
      "session",
      "secrets",
      "decrypt",
      "browser",
      "monitor",
    ]);
  });
  it.each([
    { ...CONFIG, enabled: false },
    { ...CONFIG, paused_until: "manual" },
  ])("exits without cost or scheduling", async (config) => {
    const f = fixture();
    f.store.loadConfig.mockResolvedValue(config);
    await f.handler(EVENT, { getRemainingTimeInMillis: () => 30_000 });
    expect(f.dependencies.scheduleNextScan).not.toHaveBeenCalled();
    expect(f.store.incrementMonthlyUsage).not.toHaveBeenCalled();
  });
  it("runs the exact one-shot SQS contract while disabled and never chains", async () => {
    const f = fixture();
    f.store.loadConfig.mockResolvedValue({ ...CONFIG, enabled: false });
    await f.handler(ONE_SHOT_EVENT, {
      getRemainingTimeInMillis: () => 30_000,
    });
    expect(f.dependencies.runMonitor).toHaveBeenCalledOnce();
    expect(f.dependencies.scheduleNextScan).not.toHaveBeenCalled();
    expect(f.store.claimScheduleSlot).not.toHaveBeenCalled();
  });
  it("keeps one-shot subject to pause and rejects extra or malformed SQS bodies", async () => {
    const f = fixture();
    f.store.loadConfig.mockResolvedValue({ ...CONFIG, paused_until: "manual" });
    await f.handler(ONE_SHOT_EVENT, {
      getRemainingTimeInMillis: () => 30_000,
    });
    expect(f.dependencies.runMonitor).not.toHaveBeenCalled();
    await expect(
      f.handler(
        {
          Records: [
            {
              messageId: "one-shot-2",
              body: '{"kind":"scan-once","schemaVersion":1,"extra":true}',
            },
          ],
        },
        { getRemainingTimeInMillis: () => 30_000 },
      ),
    ).rejects.toThrow("Invalid scan invocation");
    await expect(
      f.handler(
        { Records: [{ messageId: "one-shot-3", body: "not-json" }] },
        { getRemainingTimeInMillis: () => 30_000 },
      ),
    ).rejects.toThrow("Invalid scan invocation");
  });
  it("rejects hostile events and exits before three seconds", async () => {
    const f = fixture();
    await expect(
      f.handler({ Records: [] }, { getRemainingTimeInMillis: () => 30_000 }),
    ).rejects.toThrow("Invalid scan invocation");
    await f.handler(EVENT, { getRemainingTimeInMillis: () => 2_999 });
    expect(f.dependencies.scheduleNextScan).not.toHaveBeenCalled();
  });
  it("does not construct a browser when a cost alert consumes the safe budget", async () => {
    let remaining = 30_000;
    const f = fixture({
      assessCost: () => ({
        action: "WARN",
        reason: "USAGE",
        utilizationRatio: 0.7,
        projectedGbSeconds: 1,
      }),
      notifyDiagnostic: vi.fn(async () => {
        remaining = 4_000;
      }),
    });
    await f.handler(EVENT, { getRemainingTimeInMillis: () => remaining });
    expect(f.dependencies.scheduleNextScan).toHaveBeenCalledOnce();
    expect(f.store.loadEncryptedSession).not.toHaveBeenCalled();
    expect(f.dependencies.createMonitorDependencies).not.toHaveBeenCalled();
    expect(f.dependencies.runMonitor).not.toHaveBeenCalled();
  });
  it("does not navigate on duplicate lock contention", async () => {
    const f = fixture({
      runMonitor: vi.fn(async () => ({
        acquired: false,
        evaluated: 0,
        alertsSent: 0,
      })),
    });
    await f.handler(EVENT, { getRemainingTimeInMillis: () => 30_000 });
    expect(f.store.incrementMonthlyUsage).not.toHaveBeenCalledWith(
      expect.anything(),
      { scans: 1 },
    );
  });
  it("leaves close and lock release exclusively to runMonitor", async () => {
    const close = vi.fn();
    const releaseLock = vi.fn();
    const monitorDependencies = {
      createSource: async () => ({ close }),
      repository: { releaseLock },
    } as never;
    const runMonitor = vi.fn(async () => ({
      acquired: true,
      evaluated: 0,
      alertsSent: 0,
    }));
    const f = fixture({
      createMonitorDependencies: vi.fn(async () => monitorDependencies),
      runMonitor,
    });
    await f.handler(EVENT, { getRemainingTimeInMillis: () => 30_000 });
    expect(runMonitor).toHaveBeenCalledWith(
      monitorDependencies,
      expect.anything(),
    );
    expect(close).not.toHaveBeenCalled();
    expect(releaseLock).not.toHaveBeenCalled();
  });
  it("deduplicates a previously completed message before scheduling", async () => {
    const f = fixture();
    f.store.loadConfig.mockResolvedValue({
      ...CONFIG,
      last_message_id: "message-1",
    });
    await f.handler(EVENT, { getRemainingTimeInMillis: () => 30_000 });
    expect(f.dependencies.scheduleNextScan).not.toHaveBeenCalled();
  });
  it("does not confirm a message when runtime work fails and permits retry", async () => {
    const runMonitor = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary"))
      .mockRejectedValueOnce(new Error("temporary again"))
      .mockResolvedValueOnce({ acquired: true, evaluated: 0, alertsSent: 0 });
    const f = fixture({ runMonitor });
    await expect(
      f.handler(EVENT, { getRemainingTimeInMillis: () => 30_000 }),
    ).rejects.toThrow("Monitor invocation failed");
    expect(f.config().last_message_id).toBeUndefined();
    await expect(
      f.handler(EVENT, { getRemainingTimeInMillis: () => 30_000 }),
    ).rejects.toThrow("Monitor invocation failed");
    await expect(
      f.handler(EVENT, { getRemainingTimeInMillis: () => 30_000 }),
    ).resolves.toBeUndefined();
    expect(f.dependencies.scheduleNextScan).toHaveBeenCalledTimes(1);
    expect(runMonitor).toHaveBeenCalledTimes(3);
    expect(f.config().last_message_id).toBe("message-1");
  });
  it("infers an accepted successor from future next_scan_at when marker persistence failed", async () => {
    const f = fixture();
    vi.mocked(f.dependencies.scheduleNextScan).mockImplementationOnce(
      async () => {
        await f.store.saveConfig({
          ...f.config(),
          next_scan_at: "2026-08-26T12:01:30.000Z",
        });
        return { delaySeconds: 90 };
      },
    );
    const normalSave = f.store.saveConfig.getMockImplementation();
    f.store.saveConfig
      .mockImplementationOnce(normalSave as never)
      .mockRejectedValueOnce(new Error("marker write failed"));
    await expect(
      f.handler(EVENT, { getRemainingTimeInMillis: () => 30_000 }),
    ).rejects.toThrow("Monitor invocation failed");
    expect(f.config().next_scan_at).toBe("2026-08-26T12:01:30.000Z");
    await f.handler(EVENT, { getRemainingTimeInMillis: () => 30_000 });
    expect(f.dependencies.scheduleNextScan).toHaveBeenCalledOnce();
    expect(f.config().successor_scheduled_for_message_id).toBe("message-1");
  });
  it("keeps the pre-send lease when SQS accepted but next_scan persistence failed", async () => {
    const runMonitor = vi
      .fn()
      .mockRejectedValueOnce(new Error("work retry"))
      .mockResolvedValueOnce({ acquired: true, evaluated: 0, alertsSent: 0 });
    const f = fixture({ runMonitor });
    vi.mocked(f.dependencies.scheduleNextScan).mockRejectedValueOnce(
      new SqsSchedulerError(true),
    );
    await expect(
      f.handler(EVENT, { getRemainingTimeInMillis: () => 30_000 }),
    ).rejects.toThrow("Monitor invocation failed");
    expect(f.store.releaseScheduleSlot).not.toHaveBeenCalled();
    await expect(
      f.handler(EVENT, { getRemainingTimeInMillis: () => 30_000 }),
    ).rejects.toThrow("Monitor invocation failed");
    await f.handler(EVENT, { getRemainingTimeInMillis: () => 30_000 });
    expect(f.dependencies.scheduleNextScan).toHaveBeenCalledOnce();
    expect(f.store.claimScheduleSlot).toHaveBeenCalledTimes(2);
    expect(runMonitor).toHaveBeenCalledTimes(2);
  });
  it("releases only an unequivocal pre-accept failure so redelivery can retry", async () => {
    const f = fixture();
    vi.mocked(f.dependencies.scheduleNextScan)
      .mockRejectedValueOnce(new SqsSchedulerError(false))
      .mockResolvedValueOnce({ delaySeconds: 90 });
    await expect(
      f.handler(EVENT, { getRemainingTimeInMillis: () => 30_000 }),
    ).rejects.toThrow("Monitor invocation failed");
    await f.handler(EVENT, { getRemainingTimeInMillis: () => 30_000 });
    expect(f.dependencies.scheduleNextScan).toHaveBeenCalledTimes(2);
    expect(f.store.releaseScheduleSlot).toHaveBeenCalledTimes(1);
  });
  it("uses independent 15-day slots for concurrent duplicates and their successor", async () => {
    const f = fixture();
    await Promise.all([
      f.handler(EVENT, { getRemainingTimeInMillis: () => 30_000 }),
      f.handler(EVENT, { getRemainingTimeInMillis: () => 30_000 }),
    ]);
    expect(f.dependencies.scheduleNextScan).toHaveBeenCalledOnce();
    expect(f.store.claimScheduleSlot).toHaveBeenCalledWith(
      "message-1",
      1_789_041_600,
    );
    const successor = {
      Records: [
        { messageId: "message-2", body: '{"kind":"scan","schemaVersion":1}' },
      ],
    };
    await f.handler(successor, { getRemainingTimeInMillis: () => 30_000 });
    expect(f.dependencies.scheduleNextScan).toHaveBeenCalledTimes(2);
    expect(f.store.claimScheduleSlot).toHaveBeenLastCalledWith(
      "message-2",
      1_789_041_600,
    );
  });
  it("retains per-message send idempotency at +120s and just under 14 days", async () => {
    let nowMs = NOW.getTime();
    const leases = new Map<string, number>();
    const f = fixture({
      clock: () => new Date(nowMs),
      runMonitor: vi.fn(async () => {
        throw new Error("retry work");
      }),
    });
    f.store.claimScheduleSlot.mockImplementation(async (owner, expiresAt) => {
      const current = leases.get(owner) ?? 0;
      if (current > Math.floor(nowMs / 1_000)) return false;
      leases.set(owner, expiresAt);
      return true;
    });
    for (const advance of [0, 120_000, 14 * 24 * 3_600_000 - 1]) {
      nowMs = NOW.getTime() + advance;
      const {
        successor_scheduled_for_message_id: _successor,
        next_scan_at: _next,
        last_message_id: _last,
        ...rest
      } = f.config();
      void _successor;
      void _next;
      void _last;
      await f.store.saveConfig(rest as ScanRuntimeConfig);
      await expect(
        f.handler(EVENT, { getRemainingTimeInMillis: () => 30_000 }),
      ).rejects.toThrow("Monitor invocation failed");
    }
    expect(f.dependencies.scheduleNextScan).toHaveBeenCalledOnce();
  });
  it.each([
    [new SessionExpiredError(), "manual", 0],
    [new SessionChallengeError(), "manual", 0],
    [new RateLimitError(429), "2026-08-26T18:00:00.000Z", 1],
    [new PageStructureError("MISSING_FIELD", "selector"), "manual", 0],
  ])("maps typed error %s", async (error, pause, count) => {
    const f = fixture({
      runMonitor: vi.fn(async () => {
        throw error;
      }),
    });
    await f.handler(EVENT, {
      awsRequestId: "ok-id",
      getRemainingTimeInMillis: () => 30_000,
    });
    expect(f.config().paused_until).toBe(pause);
    expect(f.config().rate_limit_count ?? 0).toBe(count);
    expect(f.config().last_message_id).toBe("message-1");
    expect(
      (f.config().last_error as { message: string }).message,
    ).not.toContain("token=");
  });
  it.each(["WARN", "PAUSE"] as const)(
    "persists and retries the cost %s outbox before continuing",
    async (action) => {
      const notifyDiagnostic = vi
        .fn()
        .mockRejectedValueOnce(new Error("telegram unavailable"))
        .mockResolvedValueOnce(undefined);
      const f = fixture({
        assessCost: () => ({
          action,
          reason: "GB_SECONDS",
          utilizationRatio: 0.9,
          projectedGbSeconds: 360_000,
        }),
        notifyDiagnostic,
      });
      await expect(
        f.handler(EVENT, { getRemainingTimeInMillis: () => 30_000 }),
      ).rejects.toThrow("Runtime alert delivery failed");
      expect(f.dependencies.scheduleNextScan).not.toHaveBeenCalled();
      expect(f.config().pending_runtime_alert).toBeDefined();
      await f.handler(EVENT, { getRemainingTimeInMillis: () => 30_000 });
      expect(f.config().pending_runtime_alert).toBeUndefined();
      if (action === "PAUSE") {
        expect(f.config().paused_until).toBe("manual");
        expect(f.config().last_message_id).toBe("message-1");
        expect(f.dependencies.scheduleNextScan).not.toHaveBeenCalled();
      } else {
        expect(f.config().cost_warning_month).toBe("2026-08");
        expect(f.dependencies.scheduleNextScan).toHaveBeenCalledOnce();
      }
    },
  );
  it("rejects hostile getters and invalid clock without leaking their causes", async () => {
    const context = Object.create(null) as {
      getRemainingTimeInMillis: () => number;
    };
    Object.defineProperty(context, "getRemainingTimeInMillis", {
      get() {
        throw new Error("token=secret");
      },
    });
    const f = fixture();
    await expect(f.handler(EVENT, context)).rejects.toThrow(
      "Invalid Lambda context",
    );
    const badClock = fixture({ clock: () => new Date(Number.NaN) });
    await expect(
      badClock.handler(EVENT, { getRemainingTimeInMillis: () => 30_000 }),
    ).rejects.toThrow("Invalid runtime clock");
    const hostile = fixture();
    const config = Object.create(null) as ScanRuntimeConfig;
    Object.defineProperty(config, "enabled", {
      get() {
        throw new Error("secret");
      },
    });
    hostile.store.loadConfig.mockResolvedValue(config);
    await expect(
      hostile.handler(EVENT, { getRemainingTimeInMillis: () => 30_000 }),
    ).rejects.toThrow("Invalid runtime configuration");
    const malformed = fixture();
    malformed.store.loadConfig.mockResolvedValue({
      enabled: true,
      monitor: {} as never,
      costLimits: {} as never,
    });
    await expect(
      malformed.handler(EVENT, { getRemainingTimeInMillis: () => 30_000 }),
    ).rejects.toThrow("Invalid runtime configuration");
    expect(malformed.store.incrementMonthlyUsage).not.toHaveBeenCalled();
  });
  it.each([
    [1, "2026-08-27T12:00:00.000Z", 2],
    [2, "manual", 3],
  ] as const)(
    "escalates persisted rate-limit count %s",
    async (initial, pause, expected) => {
      const f = fixture({
        runMonitor: vi.fn(async () => {
          throw new RateLimitError(429);
        }),
      });
      f.store.loadConfig.mockImplementation(async () => ({
        ...f.config(),
        rate_limit_count: initial,
      }));
      await f.handler(EVENT, { getRemainingTimeInMillis: () => 30_000 });
      expect(f.config().paused_until).toBe(pause);
      expect(f.config().rate_limit_count).toBe(expected);
    },
  );
  it("keeps page error primary when diagnostic notification fails", async () => {
    const notifyDiagnostic = vi
      .fn()
      .mockRejectedValueOnce(new Error("telegram"))
      .mockResolvedValueOnce(undefined);
    const f = fixture({
      runMonitor: vi.fn(async () => {
        throw new PageStructureError("MISSING_FIELD", "token=secret");
      }),
      notifyDiagnostic,
    });
    await expect(
      f.handler(EVENT, {
        awsRequestId: "bad id!",
        getRemainingTimeInMillis: () => 30_000,
      }),
    ).rejects.toThrow("Runtime alert delivery failed");
    expect(f.config().last_error).toMatchObject({
      class: "PageStructureError",
    });
    expect(f.config().last_error).not.toHaveProperty("requestId");
    expect(f.config().pending_runtime_alert).toBeDefined();
    expect(f.config().last_message_id).toBeUndefined();
    await f.handler(EVENT, { getRemainingTimeInMillis: () => 30_000 });
    expect(f.config().pending_runtime_alert).toBeUndefined();
    expect(f.config().last_message_id).toBe("message-1");
    expect(f.dependencies.scheduleNextScan).toHaveBeenCalledOnce();
  });
});
