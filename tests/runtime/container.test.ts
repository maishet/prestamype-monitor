import { describe, expect, it } from "vitest";

import {
  containerResources,
  exitForFreshContainer,
  isSpentContainer,
  isDisposableTemporary,
  sweepBrowserTemporaries,
  withoutCoreDumps,
} from "../../src/runtime/container.js";

describe("isSpentContainer", () => {
  // Verbatim from the twenty minutes of three-minute ticks that all failed in
  // the same warm sandbox, each one under a second.
  it.each([
    "page.goto: net::ERR_INSUFFICIENT_RESOURCES at https://www.prestamype.com/app/inversionista/mis-inversiones",
    "browser.newContext: Target page, context or browser has been closed",
    "browser.newContext: Error setting storage state: | Target page, context or browser has been closed",
    "page.goto: Target page, context or browser has been closed",
  ])("recognises %s", (message) => {
    expect(isSpentContainer(new Error(message))).toBe(true);
  });

  // A scan can fail for reasons the next tick would survive. Throwing the
  // container away for those would cold start every scan for nothing.
  it.each([
    "A required page field is missing (opportunitiesTable)",
    "page.goto: Timeout 12000ms exceeded.",
    "Telegram delivery failed",
  ])("leaves %s to the next tick", (message) => {
    expect(isSpentContainer(new Error(message))).toBe(false);
  });

  it("reads a thrown non-error without throwing", () => {
    expect(isSpentContainer("ERR_INSUFFICIENT_RESOURCES")).toBe(true);
    expect(isSpentContainer(undefined)).toBe(false);
  });
});

describe("containerResources", () => {
  it("reports nothing rather than throwing where there is no procfs", () => {
    const resources = containerResources();
    expect(typeof resources).toBe("object");
    for (const value of Object.values(resources))
      expect(Number.isFinite(value)).toBe(true);
  });
});

describe("exitForFreshContainer", () => {
  it("does nothing outside Lambda", () => {
    // Guarded because the unguarded call would end the test run here.
    expect(process.env.AWS_LAMBDA_FUNCTION_NAME).toBeUndefined();
    expect(exitForFreshContainer()).toBe(false);
  });
});

describe("sweepBrowserTemporaries", () => {
  it("reports a count without throwing where there is no /tmp", () => {
    // The sweep runs before every scan, so it must never be the thing that
    // fails one.
    expect(sweepBrowserTemporaries()).toEqual({ swept: expect.any(Number) });
  });
});

describe("withoutCoreDumps", () => {
  it("hands back the real binary outside Lambda", () => {
    // A developer machine keeps whatever core behaviour it is configured for.
    expect(process.env.AWS_LAMBDA_FUNCTION_NAME).toBeUndefined();
    expect(withoutCoreDumps("/tmp/chromium")).toBe("/tmp/chromium");
  });
});

describe("isDisposableTemporary", () => {
  // Names taken from a real sandbox: the first two are what filled the disk,
  // the rest are what the browser needs to exist at all.
  it.each([
    "core.chromium.55",
    "playwright_chromiumdev_profile-aB3",
    "Crashpad",
  ])("sweeps %s", (name) => {
    expect(isDisposableTemporary(name)).toBe(true);
  });

  it.each([
    "chromium",
    "chromium-no-core",
    "al2023",
    "libGLESv2.so",
    "libvk_swiftshader.so",
    "libvulkan.so.1",
  ])("keeps %s", (name) => {
    expect(isDisposableTemporary(name)).toBe(false);
  });
});
