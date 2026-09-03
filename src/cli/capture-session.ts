import { pathToFileURL } from "node:url";

import type { SessionStore } from "../application/ports.js";
import {
  encryptSession,
  type StorageState,
} from "../security/session-crypto.js";

const OPPORTUNITIES_URL =
  "https://www.prestamype.com/app/inversionista/oportunidades";
const AUTHENTICATED_MARKER =
  '[data-opportunity-card], [data-page="opportunities"]';
const CAPTCHA_MARKER = '[data-captcha], iframe[src*="captcha"], .g-recaptcha';
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export class CaptureSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptureSessionError";
  }
}

interface CapturePage {
  goto(url: string): Promise<unknown>;
  url(): string;
  waitForSelector(selector: string): Promise<unknown>;
  locator(selector: string): { isVisible(): Promise<boolean> };
  close?(): Promise<void>;
}

interface CaptureContext {
  newPage(): Promise<CapturePage>;
  storageState(): Promise<StorageState>;
  close(): Promise<void>;
}

interface CaptureBrowser {
  newContext(options: object): Promise<CaptureContext>;
  close(): Promise<void>;
}

export interface CaptureBrowserLauncher {
  launch(options: { headless: false }): Promise<CaptureBrowser>;
}

export interface CaptureDependencies {
  launcher: CaptureBrowserLauncher;
  store: SessionStore;
  key: Uint8Array;
  output(message: string): void;
}

export interface CaptureOptions {
  timeoutMs?: number;
  cleanupTimeoutMs?: number;
  signal?: AbortSignal;
}

export interface CaptureCliOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type CaptureModuleLoader = (specifier: string) => Promise<unknown>;

function assertAllowedUrl(rawUrl: string): void {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new CaptureSessionError("Unexpected browser destination");
  }
  if (
    url.origin !== "https://www.prestamype.com" ||
    url.username !== "" ||
    url.password !== "" ||
    !/^\/(?:app\/inversionista\/oportunidades|iniciar-sesion)\/?$/.test(
      url.pathname,
    )
  ) {
    throw new CaptureSessionError("Unexpected browser destination");
  }
}

function assertAuthenticatedUrl(rawUrl: string): void {
  assertAllowedUrl(rawUrl);
  const url = new URL(rawUrl);
  if (!/^\/app\/inversionista\/oportunidades\/?$/.test(url.pathname)) {
    throw new CaptureSessionError("Authentication was not completed");
  }
}

function abortError(signal: AbortSignal): CaptureSessionError {
  return new CaptureSessionError(
    signal.reason === "timeout"
      ? "Authentication was not completed in time"
      : "Session capture cancelled",
  );
}

export async function raceWithAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  onLateResolve?: (value: T) => void | Promise<void>,
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    let finished = false;
    const dispose = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      if (finished) return;
      finished = true;
      dispose();
      reject(abortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    void operation.then(
      (value) => {
        if (finished) {
          if (onLateResolve !== undefined)
            void Promise.resolve(onLateResolve(value)).catch(() => undefined);
          return;
        }
        finished = true;
        dispose();
        resolve(value);
      },
      (error: unknown) => {
        if (finished) return;
        finished = true;
        dispose();
        reject(error);
      },
    );
  });
}

async function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw abortError(signal);
  await new Promise<void>((resolve, reject) => {
    const finish = () => signal.removeEventListener("abort", onAbort);
    const timer = setTimeout(() => {
      finish();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      finish();
      reject(abortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function waitForAuthentication(
  page: CapturePage,
  signal: AbortSignal,
): Promise<void> {
  const authenticationController = new AbortController();
  const forwardAbort = () => authenticationController.abort(signal.reason);
  signal.addEventListener("abort", forwardAbort, { once: true });
  if (signal.aborted) authenticationController.abort(signal.reason);
  const authenticationSignal = authenticationController.signal;
  const challenge = (async () => {
    while (!authenticationSignal.aborted) {
      if (
        await raceWithAbort(
          page.locator(CAPTCHA_MARKER).isVisible(),
          authenticationSignal,
        )
      ) {
        throw new CaptureSessionError("Authentication challenge detected");
      }
      await abortableDelay(100, authenticationSignal);
    }
    throw abortError(authenticationSignal);
  })();
  const aborted = new Promise<never>((_resolve, reject) => {
    if (authenticationSignal.aborted) reject(abortError(authenticationSignal));
    else
      authenticationSignal.addEventListener(
        "abort",
        () => reject(abortError(authenticationSignal)),
        { once: true },
      );
  });
  try {
    await Promise.race([
      raceWithAbort(
        page.waitForSelector(AUTHENTICATED_MARKER),
        authenticationSignal,
      ),
      challenge,
      aborted,
    ]);
  } finally {
    authenticationController.abort("cleanup");
    signal.removeEventListener("abort", forwardAbort);
  }
}

export async function captureSession(
  dependencies: CaptureDependencies,
  options: CaptureOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cleanupTimeoutMs = options.cleanupTimeoutMs ?? 2_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new CaptureSessionError("Invalid session capture timeout");
  if (!Number.isFinite(cleanupTimeoutMs) || cleanupTimeoutMs <= 0)
    throw new CaptureSessionError("Invalid session cleanup timeout");
  const controller = new AbortController();
  const forwardAbort = () => controller.abort("external");
  options.signal?.addEventListener("abort", forwardAbort, { once: true });
  if (options.signal?.aborted) controller.abort("external");
  const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);
  let browser: CaptureBrowser | undefined;
  let context: CaptureContext | undefined;
  let page: CapturePage | undefined;
  let primaryError: unknown;
  let cleanupPromise: Promise<unknown[]> | undefined;
  const closeWithinLimit = async (
    close: () => Promise<void>,
  ): Promise<void> => {
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(close),
        new Promise<never>((_resolve, reject) => {
          cleanupTimer = setTimeout(
            () => reject(new CaptureSessionError("Session cleanup timed out")),
            cleanupTimeoutMs,
          );
        }),
      ]);
    } finally {
      if (cleanupTimer !== undefined) clearTimeout(cleanupTimer);
    }
  };
  const closeLate = (resource: { close(): Promise<void> }) =>
    closeWithinLimit(() => resource.close()).catch(() => undefined);
  const startCleanup = (): Promise<unknown[]> => {
    cleanupPromise ??= Promise.allSettled([
      ...(page?.close === undefined
        ? []
        : [closeWithinLimit(() => page!.close!())]),
      ...(context === undefined
        ? []
        : [closeWithinLimit(() => context!.close())]),
      ...(browser === undefined
        ? []
        : [closeWithinLimit(() => browser!.close())]),
    ]).then((results) =>
      results.flatMap((result) =>
        result.status === "rejected" ? [result.reason as unknown] : [],
      ),
    );
    return cleanupPromise;
  };
  const cleanupOnAbort = () => {
    void startCleanup();
  };
  controller.signal.addEventListener("abort", cleanupOnAbort, { once: true });
  try {
    browser = await raceWithAbort(
      dependencies.launcher.launch({ headless: false }),
      controller.signal,
      closeLate,
    );
    context = await raceWithAbort(
      browser.newContext({
        locale: "es-PE",
        timezoneId: "America/Lima",
        viewport: { width: 1280, height: 720 },
      }),
      controller.signal,
      closeLate,
    );
    page = await raceWithAbort(
      context.newPage(),
      controller.signal,
      (latePage) =>
        latePage.close === undefined
          ? undefined
          : closeLate(latePage as { close(): Promise<void> }),
    );
    await raceWithAbort(page.goto(OPPORTUNITIES_URL), controller.signal);
    assertAllowedUrl(page.url());
    dependencies.output("Inicia sesión manualmente y vuelve aquí");
    if (
      await raceWithAbort(
        page.locator(CAPTCHA_MARKER).isVisible(),
        controller.signal,
      )
    )
      throw new CaptureSessionError("Authentication challenge detected");
    await waitForAuthentication(page, controller.signal);
    assertAuthenticatedUrl(page.url());
    if (
      await raceWithAbort(
        page.locator(CAPTCHA_MARKER).isVisible(),
        controller.signal,
      )
    )
      throw new CaptureSessionError("Authentication challenge detected");
    const storageState = await raceWithAbort(
      context.storageState(),
      controller.signal,
    );
    await raceWithAbort(
      dependencies.store.saveEncryptedSession(
        encryptSession(storageState, dependencies.key),
        { signal: controller.signal },
      ),
      controller.signal,
    );
  } catch (error) {
    primaryError = error;
  }
  clearTimeout(timer);
  options.signal?.removeEventListener("abort", forwardAbort);
  controller.signal.removeEventListener("abort", cleanupOnAbort);
  const cleanupErrors = await startCleanup();
  if (cleanupErrors.length > 0) {
    const errors =
      primaryError === undefined
        ? cleanupErrors
        : [primaryError, ...cleanupErrors];
    throw new AggregateError(errors, "Session capture and cleanup failed", {
      ...(primaryError === undefined ? {} : { cause: primaryError }),
    });
  }
  if (primaryError !== undefined) throw primaryError;
}

function isCaptureDependencies(value: unknown): value is CaptureDependencies {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const candidate = value as Partial<CaptureDependencies>;
  return (
    candidate.key instanceof Uint8Array &&
    candidate.key.byteLength === 32 &&
    typeof candidate.launcher?.launch === "function" &&
    typeof candidate.store?.loadEncryptedSession === "function" &&
    typeof candidate.store.saveEncryptedSession === "function" &&
    (candidate.output === undefined || typeof candidate.output === "function")
  );
}

export async function runCaptureSessionCli(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  moduleLoader: CaptureModuleLoader = (specifier) =>
    import(specifier) as Promise<unknown>,
  options: CaptureCliOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new CaptureSessionError("Invalid session capture timeout");
  const controller = new AbortController();
  const forwardAbort = () => controller.abort("external");
  options.signal?.addEventListener("abort", forwardAbort, { once: true });
  if (options.signal?.aborted) controller.abort("external");
  const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);
  const started = Date.now();
  const specifier = environment.PRESTAMYPE_CAPTURE_ADAPTER;
  try {
    const loaded = await raceWithAbort(
      moduleLoader(
        specifier === undefined || specifier.trim() === ""
          ? new URL("./aws-capture-adapter.js", import.meta.url).href
          : specifier,
      ),
      controller.signal,
    );
    if (
      typeof loaded !== "object" ||
      loaded === null ||
      !("createCaptureDependencies" in loaded) ||
      typeof loaded.createCaptureDependencies !== "function"
    ) {
      throw new CaptureSessionError("Session capture adapter is invalid");
    }
    const factory = loaded.createCaptureDependencies as (options?: {
      signal?: AbortSignal;
    }) => Promise<unknown> | unknown;
    const dependencies = await raceWithAbort(
      Promise.resolve().then(() => factory({ signal: controller.signal })),
      controller.signal,
    );
    if (!isCaptureDependencies(dependencies))
      throw new CaptureSessionError("Session capture adapter is invalid");
    const remainingMs = timeoutMs - (Date.now() - started);
    if (remainingMs <= 0) throw abortError(controller.signal);
    await captureSession(
      { ...dependencies, output: dependencies.output ?? console.log },
      { timeoutMs: remainingMs, signal: controller.signal },
    );
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", forwardAbort);
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void runCaptureSessionCli().catch((error: unknown) => {
    console.error(
      error instanceof CaptureSessionError
        ? error.message
        : "Session capture failed safely",
    );
    process.exitCode = 1;
  });
}
