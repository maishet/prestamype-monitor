import { describe, expect, it, vi } from "vitest";

import type { SessionStore } from "../../src/application/ports.js";
import {
  CaptureSessionError,
  captureSession,
  runCaptureSessionCli,
  type CaptureBrowserLauncher,
} from "../../src/cli/capture-session.js";

const key = new Uint8Array(32).fill(9);

function harness(
  mode:
    | "success"
    | "captcha"
    | "pending"
    | "gotoPending"
    | "statePending" = "success",
) {
  const events: string[] = [];
  const state = { cookies: [], origins: [] };
  let launchOptions: object | undefined;
  let visibilityChecks = 0;
  const page = {
    async goto(url: string) {
      events.push(`goto:${url}`);
      if (mode === "gotoPending")
        return await new Promise<void>(() => undefined);
    },
    url: () => "https://prestamype.com/app/inversionista/oportunidades",
    async waitForSelector(selector: string) {
      events.push(`wait:${selector}`);
      if (mode === "pending") return await new Promise<void>(() => undefined);
    },
    locator(selector: string) {
      return {
        async isVisible() {
          visibilityChecks += 1;
          return mode === "captcha" && selector.includes("captcha");
        },
      };
    },
  };
  const context = {
    async newPage() {
      return page;
    },
    async storageState() {
      events.push("state");
      if (mode === "statePending")
        return await new Promise<never>(() => undefined);
      return state;
    },
    async close() {
      events.push("context.close");
    },
  };
  const browser = {
    async newContext() {
      events.push("context");
      return context;
    },
    async close() {
      events.push("browser.close");
    },
  };
  const launcher: CaptureBrowserLauncher = {
    async launch(options) {
      events.push("launch");
      launchOptions = options;
      return browser;
    },
  };
  const saved: unknown[] = [];
  const store: SessionStore = {
    async loadEncryptedSession() {
      return null;
    },
    async saveEncryptedSession(payload) {
      events.push("save");
      saved.push(payload);
    },
  };
  return {
    events,
    launcher,
    saved,
    store,
    getLaunchOptions: () => launchOptions,
    getVisibilityChecks: () => visibilityChecks,
  };
}

describe("captureSession", () => {
  it("times out even when browser launch never settles", async () => {
    vi.useFakeTimers();
    try {
      const capture = captureSession(
        {
          launcher: { launch: async () => await new Promise(() => undefined) },
          store: harness().store,
          key,
          output: vi.fn(),
        },
        { timeoutMs: 20, cleanupTimeoutMs: 10 },
      );
      const rejected = expect(capture).rejects.toThrow(
        "Authentication was not completed in time",
      );
      await vi.advanceTimersByTimeAsync(20);
      await rejected;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes a browser that resolves after timeout", async () => {
    vi.useFakeTimers();
    try {
      let resolveLaunch!: (browser: {
        newContext(): Promise<never>;
        close(): Promise<void>;
      }) => void;
      let closes = 0;
      const capture = captureSession(
        {
          launcher: {
            launch: async () =>
              await new Promise((resolve) => {
                resolveLaunch = resolve;
              }),
          },
          store: harness().store,
          key,
          output: vi.fn(),
        },
        { timeoutMs: 20, cleanupTimeoutMs: 10 },
      );
      const rejected = expect(capture).rejects.toThrow(
        "Authentication was not completed in time",
      );
      await vi.advanceTimersByTimeAsync(20);
      await rejected;
      resolveLaunch({
        newContext: async () => await new Promise(() => undefined),
        close: async () => {
          closes += 1;
        },
      });
      await vi.runAllTimersAsync();
      expect(closes).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("external abort wins over a pending launch and clears the watchdog", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const capture = captureSession(
        {
          launcher: { launch: async () => await new Promise(() => undefined) },
          store: harness().store,
          key,
          output: vi.fn(),
        },
        { signal: controller.signal, timeoutMs: 10_000 },
      );
      const rejected = expect(capture).rejects.toThrow(
        "Session capture cancelled",
      );
      controller.abort();
      await rejected;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("launches visibly, instructs once, captures, encrypts and saves", async () => {
    const h = harness();
    const output = vi.fn();
    await captureSession({ launcher: h.launcher, store: h.store, key, output });

    expect(output).toHaveBeenCalledTimes(1);
    expect(output).toHaveBeenCalledWith(
      "Inicia sesión manualmente y vuelve aquí",
    );
    expect(JSON.stringify(output.mock.calls)).not.toContain("secret");
    expect(h.getLaunchOptions()).toEqual({ headless: false });
    expect(h.saved).toHaveLength(1);
    expect(h.events.slice(-3)).toEqual([
      "save",
      "context.close",
      "browser.close",
    ]);
  });

  it("detects CAPTCHA and never saves", async () => {
    const h = harness("captcha");
    await expect(
      captureSession({
        launcher: h.launcher,
        store: h.store,
        key,
        output: vi.fn(),
      }),
    ).rejects.toThrow("Authentication challenge detected");
    expect(h.saved).toHaveLength(0);
    expect(h.events.slice(-2)).toEqual(["context.close", "browser.close"]);
  });

  it("times out waiting for explicit authentication marker", async () => {
    const h = harness("pending");
    await expect(
      captureSession(
        { launcher: h.launcher, store: h.store, key, output: vi.fn() },
        { timeoutMs: 5 },
      ),
    ).rejects.toBeInstanceOf(CaptureSessionError);
    expect(h.events.slice(-2)).toEqual(["context.close", "browser.close"]);
    const checksAfterReturn = h.getVisibilityChecks();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(h.getVisibilityChecks()).toBe(checksAfterReturn);
  });

  it("supports cancellation and cleans up", async () => {
    const h = harness("pending");
    const controller = new AbortController();
    controller.abort();
    await expect(
      captureSession(
        { launcher: h.launcher, store: h.store, key, output: vi.fn() },
        { signal: controller.signal },
      ),
    ).rejects.toThrow("Session capture cancelled");
    expect(h.events.at(-1)).toBe("browser.close");
  });

  it("passes cancellation to a pending store and does not persist late", async () => {
    const h = harness();
    const controller = new AbortController();
    let saved = false;
    h.store.saveEncryptedSession = async (_payload, options) => {
      await new Promise<void>((resolve, reject) => {
        options?.signal.addEventListener(
          "abort",
          () => reject(new Error("cancelled")),
          { once: true },
        );
      });
      saved = true;
    };
    const capture = captureSession(
      { launcher: h.launcher, store: h.store, key, output: vi.fn() },
      { signal: controller.signal },
    );
    await vi.waitFor(() => expect(h.events).toContain("state"));
    controller.abort();
    await expect(capture).rejects.toThrow("Session capture cancelled");
    expect(saved).toBe(false);
    expect(h.events.slice(-2)).toEqual(["context.close", "browser.close"]);
  });

  it.each(["gotoPending", "statePending"] as const)(
    "aborts pending %s and cleans all acquired resources",
    async (mode) => {
      const h = harness(mode);
      const controller = new AbortController();
      const capture = captureSession(
        { launcher: h.launcher, store: h.store, key, output: vi.fn() },
        { signal: controller.signal },
      );
      await vi.waitFor(() =>
        expect(h.events).toContain(
          mode === "gotoPending"
            ? "goto:https://prestamype.com/app/inversionista/oportunidades"
            : "state",
        ),
      );
      controller.abort();
      await expect(capture).rejects.toThrow("Session capture cancelled");
      expect(h.events.slice(-2)).toEqual(["context.close", "browser.close"]);
    },
  );

  it("closes context and browser when save fails", async () => {
    const h = harness();
    h.store.saveEncryptedSession = async () => {
      throw new Error("database detail");
    };
    await expect(
      captureSession({
        launcher: h.launcher,
        store: h.store,
        key,
        output: vi.fn(),
      }),
    ).rejects.toThrow("database detail");
    expect(h.events.slice(-2)).toEqual(["context.close", "browser.close"]);
  });

  it("surfaces cleanup failures and preserves the primary error first", async () => {
    const h = harness();
    h.store.saveEncryptedSession = async () => {
      throw new Error("primary");
    };
    const browser = await h.launcher.launch({ headless: false });
    const originalNewContext = browser.newContext.bind(browser);
    browser.newContext = async (options) => {
      const context = await originalNewContext(options);
      context.close = async () => {
        throw new Error("context cleanup");
      };
      return context;
    };
    browser.close = async () => {
      throw new Error("browser cleanup");
    };

    try {
      await captureSession({
        launcher: { launch: async () => browser },
        store: h.store,
        key,
        output: vi.fn(),
      });
      expect.fail("capture should fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors.map(String)).toEqual([
        "Error: primary",
        "Error: context cleanup",
        "Error: browser cleanup",
      ]);
    }
  });

  it("fails when cleanup alone fails", async () => {
    const h = harness();
    const browser = await h.launcher.launch({ headless: false });
    browser.close = async () => {
      throw new Error("browser cleanup");
    };
    await expect(
      captureSession({
        launcher: { launch: async () => browser },
        store: h.store,
        key,
        output: vi.fn(),
      }),
    ).rejects.toBeInstanceOf(AggregateError);
  });
});

describe("capture CLI composition", () => {
  it("loads a non-secret adapter specifier and runs capture", async () => {
    const h = harness();
    const loader = vi.fn(async () => ({
      createCaptureDependencies: async () => ({
        launcher: h.launcher,
        store: h.store,
        key,
        output: vi.fn(),
      }),
    }));
    await runCaptureSessionCli(
      { PRESTAMYPE_CAPTURE_ADAPTER: "./capture-adapter.js" },
      loader,
    );
    expect(loader).toHaveBeenCalledWith("./capture-adapter.js");
    expect(h.saved).toHaveLength(1);
  });

  it("fails safely without a configured adapter", async () => {
    await expect(runCaptureSessionCli({}, vi.fn())).rejects.toThrow(
      "Session capture is not configured",
    );
  });
});
