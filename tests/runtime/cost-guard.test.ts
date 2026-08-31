import { describe, expect, it } from "vitest";

import {
  CostGuardInputError,
  assessMonthlyUsage,
} from "../../src/runtime/cost-guard.js";

const limits = {
  configuredMemoryGb: 1,
  monthlyGbSecondsLimit: 100_000,
} as const;

describe("monthly cost guard", () => {
  it.each([
    [69_999, 1, "CONTINUE"],
    [70_000, 1, "WARN"],
    [87_499, 1, "WARN"],
    [87_500, 1, "PAUSE"],
    [100_000, 1, "PAUSE"],
  ] as const)(
    "classifies projected use %s at the documented thresholds",
    (invocations, averageDurationSeconds, action) => {
      const decision = assessMonthlyUsage(
        { invocations, scans: 1, averageDurationSeconds },
        limits,
      );
      expect(decision).toEqual({
        action,
        projectedGbSeconds: invocations,
        utilizationRatio: invocations / 100_000,
        reason: action === "PAUSE" ? "GB_SECONDS" : "USAGE",
      });
      expect(Object.isFrozen(decision)).toBe(true);
    },
  );

  it("projects GB-seconds from invocations, memory, and average duration", () => {
    expect(
      assessMonthlyUsage(
        { invocations: 2_000, scans: 10, averageDurationSeconds: 4 },
        { configuredMemoryGb: 0.5, monthlyGbSecondsLimit: 10_000 },
      ).projectedGbSeconds,
    ).toBe(4_000);
  });

  it("pauses at the independent 31,000 scan ceiling", () => {
    expect(
      assessMonthlyUsage(
        { invocations: 1, scans: 31_000, averageDurationSeconds: 1 },
        limits,
      ),
    ).toMatchObject({ action: "PAUSE", reason: "SCAN_LIMIT" });
  });

  it.each([
    [{ invocations: -1, scans: 0, averageDurationSeconds: 1 }, limits],
    [{ invocations: 1, scans: Number.NaN, averageDurationSeconds: 1 }, limits],
    [{ invocations: 1, scans: 0, averageDurationSeconds: Infinity }, limits],
    [
      { invocations: 1, scans: 0, averageDurationSeconds: 1 },
      { ...limits, configuredMemoryGb: 0 },
    ],
    [
      { invocations: 1, scans: 0, averageDurationSeconds: 1 },
      { ...limits, monthlyGbSecondsLimit: 0 },
    ],
  ])("rejects invalid usage or limits", (usage, invalidLimits) => {
    expect(() => assessMonthlyUsage(usage, invalidLimits)).toThrow(
      CostGuardInputError,
    );
  });

  it.each([null, undefined])("rejects non-object usage %s", (usage) => {
    expect(() =>
      assessMonthlyUsage(
        usage as unknown as Parameters<typeof assessMonthlyUsage>[0],
        limits,
      ),
    ).toThrow(CostGuardInputError);
  });

  it.each([null, undefined])(
    "rejects non-object limits %s",
    (invalidLimits) => {
      expect(() =>
        assessMonthlyUsage(
          { invocations: 1, scans: 1, averageDurationSeconds: 1 },
          invalidLimits as unknown as Parameters<typeof assessMonthlyUsage>[1],
        ),
      ).toThrow(CostGuardInputError);
    },
  );

  it("normalizes hostile property access to CostGuardInputError", () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("token=VERY_SECRET");
        },
      },
    );
    const failure = (() => {
      try {
        assessMonthlyUsage(
          hostile as Parameters<typeof assessMonthlyUsage>[0],
          limits,
        );
      } catch (error) {
        return error;
      }
    })();
    expect(failure).toBeInstanceOf(CostGuardInputError);
    expect(String(failure)).not.toContain("VERY_SECRET");
    expect((failure as Error).cause).toBeUndefined();
  });
});
