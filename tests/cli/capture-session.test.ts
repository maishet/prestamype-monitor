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
    | "cookieChallenge"
    | "invisibleCaptcha"
    | "visibleOpportunities"
    | "canonicalDomain"
    | "pending"
    | "gotoPending"
    | "statePending" = "success",
) {
  const events: string[] = [];
  const state = { cookies: [], origins: [] };
  let launchOptions: object | undefined;
  let visibilityChecks = 0;
  let cookieConsentVisible = mode === "cookieChallenge";
  let cookieConsentChecks = 0;
  const page = {
    async goto(url: string) {
      events.push(`goto:${url}`);
      if (mode === "gotoPending")
        return await new Promise<void>(() => undefined);
    },
    url: () =>
      mode === "canonicalDomain"
        ? "https://prestamype.com/app/inversionista/oportunidades"
        : "https://www.prestamype.com/app/inversionista/oportunidades",
    async waitForSelector(selector: string) {
      events.push(`wait:${selector}`);
      if (
        mode === "visibleOpportunities" &&
        !selector.includes("Oportunidades")
      )
        throw new Error("legacy authenticated marker is absent");
      if (mode === "pending") return await new Promise<void>(() => undefined);
    },
    locator(selector: string) {
      return {
        async isVisible() {
          visibilityChecks += 1;
          if (selector.includes("Permitir la selección")) {
            cookieConsentChecks += 1;
            if (mode === "cookieChallenge" && cookieConsentChecks > 1)
              cookieConsentVisible = false;
            return cookieConsentVisible;
          }
          if (mode === "invisibleCaptcha")
            return selector.includes('iframe[src*="captcha"]');
          return (
            selector.includes("captcha") &&
            (mode === "captcha" || cookieConsentVisible)
          );
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
  it("accepts Prestamype's canonical domain after redirect", async () => {
    const h = harness("canonicalDomain");
    const output = vi.fn();

    await captureSession({ launcher: h.launcher, store: h.store, key, output });

    expect(h.saved).toHaveLength(1);
  });

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

    expect(output.mock.calls.map(([message]) => message)).toEqual([
      "Inicia sesión manualmente y vuelve aquí",
      "Guardando sesión cifrada",
      "Sesión cifrada guardada",
    ]);
    expect(JSON.stringify(output.mock.calls)).not.toContain("secret");
    expect(h.getLaunchOptions()).toEqual({ headless: false });
    expect(h.saved).toHaveLength(1);
    expect(h.events.slice(-3)).toEqual([
      "save",
      "context.close",
      "browser.close",
    ]);
  });

  it("recognizes the visible oportunidades page when legacy data markers are absent", async () => {
    const h = harness("visibleOpportunities");
    await captureSession({
      launcher: h.launcher,
      store: h.store,
      key,
      output: vi.fn(),
    });
    expect(h.saved).toHaveLength(1);
    expect(h.events).toContain(
      'wait:h1:has-text("Oportunidades"), h2:has-text("Oportunidades"), h3:has-text("Oportunidades"), [role="heading"]:has-text("Oportunidades")',
    );
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

  it("does not treat an invisible generic CAPTCHA iframe as a challenge", async () => {
    const h = harness("invisibleCaptcha");
    await captureSession({
      launcher: h.launcher,
      store: h.store,
      key,
      output: vi.fn(),
    });
    expect(h.saved).toHaveLength(1);
  });

  it("waits for the visible cookie choice to be dismissed before checking for a challenge", async () => {
    const h = harness("cookieChallenge");
    await captureSession({
      launcher: h.launcher,
      store: h.store,
      key,
      output: vi.fn(),
    });
    expect(h.saved).toHaveLength(1);
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
            ? "goto:https://www.prestamype.com/app/inversionista/oportunidades"
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

  it("uses the bundled AWS adapter when no override is configured", async () => {
    const h = harness();
    const loader = vi.fn(async () => ({
      createCaptureDependencies: async () => ({
        launcher: h.launcher,
        store: h.store,
        key,
      }),
    }));
    await runCaptureSessionCli({}, loader);
    expect(loader).toHaveBeenCalledWith(
      expect.stringMatching(/aws-capture-adapter\.js$/),
    );
    expect(h.saved).toHaveLength(1);
  });

  it("bounds adapter creation before any browser or session write", async () => {
    vi.useFakeTimers();
    try {
      const launch = vi.fn();
      const save = vi.fn();
      const createCaptureDependencies = vi.fn(
        async (options?: { signal?: AbortSignal }) =>
          await new Promise<never>((_resolve, reject) => {
            options?.signal?.addEventListener(
              "abort",
              () => reject(new Error("ssm pending")),
              { once: true },
            );
          }),
      );
      const run = runCaptureSessionCli(
        {},
        async () => ({ createCaptureDependencies }),
        { timeoutMs: 20 },
      );
      const rejected = expect(run).rejects.toThrow(
        "Authentication was not completed in time",
      );
      await vi.advanceTimersByTimeAsync(20);
      await rejected;
      expect(createCaptureDependencies).toHaveBeenCalledWith({
        signal: expect.any(AbortSignal),
      });
      expect(launch).not.toHaveBeenCalled();
      expect(save).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
