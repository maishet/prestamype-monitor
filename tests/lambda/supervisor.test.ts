import { describe, expect, it, vi } from "vitest";
import {
  runSupervisor,
  supervisorHandler,
  type SupervisorConfig,
} from "../../src/lambda/supervisor.js";

const NOW = new Date("2026-08-26T12:10:00.000Z");
function fixture(config: SupervisorConfig | null, locked = false) {
  let claimed = false;
  const schedule = vi.fn(async () => undefined);
  const claim = vi.fn(async () => {
    if (claimed) return false;
    claimed = true;
    return true;
  });
  const release = vi.fn(async () => {
    claimed = false;
  });
  return {
    dependencies: {
      loadConfig: async () => config,
      hasActiveLock: async () => locked,
      claimSupervisorMarker: claim,
      releaseSupervisorMarker: release,
      scheduleImmediateScan: schedule,
    },
    schedule,
    claim,
    release,
  };
}
describe("supervisor", () => {
  it("validates production EventBridge invocations before connecting AWS", async () => {
    await expect(
      supervisorHandler(
        { source: "hostile" } as never,
        {
          getRemainingTimeInMillis: () => 30_000,
        } as never,
      ),
    ).rejects.toThrow("Invalid supervisor invocation");
    const event = {
      source: "aws.events",
      "detail-type": "Scheduled Event",
      detail: {},
    } as never;
    await expect(
      supervisorHandler(event, {
        getRemainingTimeInMillis: () => 2_999,
      } as never),
    ).resolves.toEqual({ scheduled: false, reason: "INVALID" });
    const hostile = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(hostile, "source", {
      get() {
        throw new Error("secret");
      },
    });
    await expect(
      supervisorHandler(
        hostile as never,
        {
          getRemainingTimeInMillis: () => 30_000,
        } as never,
      ),
    ).rejects.toThrow("Invalid supervisor invocation");
  });
  it("normalizes a hostile next_scan_at getter without calling AWS recovery", async () => {
    const config = { enabled: true } as SupervisorConfig;
    Object.defineProperty(config, "next_scan_at", {
      get() {
        throw new Error("token=secret");
      },
    });
    const f = fixture(config);
    await expect(runSupervisor(f.dependencies, NOW)).rejects.toThrow(
      "Invalid supervisor configuration",
    );
    expect(f.claim).not.toHaveBeenCalled();
  });
  it("claims atomically before scheduling and suppresses concurrent ticks", async () => {
    const f = fixture({
      enabled: true,
      next_scan_at: "2026-08-26T12:06:59.000Z",
    });
    const [first, second] = await Promise.all([
      runSupervisor(f.dependencies, NOW),
      runSupervisor(f.dependencies, NOW),
    ]);
    expect([first.reason, second.reason].sort()).toEqual([
      "DUPLICATE",
      "SCHEDULED",
    ]);
    expect(f.schedule).toHaveBeenCalledOnce();
    expect(f.claim.mock.invocationCallOrder[0]).toBeLessThan(
      f.schedule.mock.invocationCallOrder[0] as number,
    );
  });
  it("releases a claim after SQS failure so a retry can recover", async () => {
    const f = fixture({ enabled: true, next_scan_at: "2020-01-01T00:00:00Z" });
    f.schedule.mockRejectedValueOnce(new Error("SQS unavailable"));
    await expect(runSupervisor(f.dependencies, NOW)).rejects.toThrow(
      "SQS unavailable",
    );
    expect(f.release).toHaveBeenCalledOnce();
    await expect(runSupervisor(f.dependencies, NOW)).resolves.toMatchObject({
      scheduled: true,
    });
  });
  it.each([
    [
      { enabled: false, next_scan_at: "2020-01-01T00:00:00Z" },
      false,
      "DISABLED",
    ],
    [
      {
        enabled: true,
        paused_until: "manual",
        next_scan_at: "2020-01-01T00:00:00Z",
      },
      false,
      "PAUSED",
    ],
    [
      { enabled: true, next_scan_at: "2026-08-26T12:07:00.000Z" },
      false,
      "NOT_STALE",
    ],
    [{ enabled: true, next_scan_at: "2020-01-01T00:00:00Z" }, true, "LOCKED"],
  ] as const)("does not schedule %#", async (config, locked, reason) => {
    const f = fixture(config, locked);
    await expect(runSupervisor(f.dependencies, NOW)).resolves.toMatchObject({
      scheduled: false,
      reason,
    });
    expect(f.schedule).not.toHaveBeenCalled();
    expect(f.claim).not.toHaveBeenCalled();
  });
});
