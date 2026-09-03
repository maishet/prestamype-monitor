import type { Notifier } from "../application/ports.js";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface TelegramClientOptions {
  readonly token: string;
  readonly chatId: string;
  readonly fetch?: FetchLike;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly clock?: () => number;
  readonly random?: () => number;
  readonly timeoutMs?: number;
}

export interface TelegramSendOptions {
  readonly signal?: AbortSignal;
}

export class TelegramDeliveryError extends Error {
  constructor() {
    super("Telegram delivery failed");
    this.name = "TelegramDeliveryError";
  }
}

const MAX_MESSAGE_LENGTH = 4_000;
const MAX_ATTEMPTS = 3;
const MAX_RESPONSE_BYTES = 16_384;
const MIN_RETRY_MS = 100;
const MAX_RETRY_MS = 5_000;
const TOKEN = /^\d{6,12}:[A-Za-z0-9_-]{16,128}$/;
const CHAT_ID = /^-?\d{1,20}(?:\s*,\s*-?\d{1,20})*$/;

function fail(): never {
  throw new TelegramDeliveryError();
}

function boundedDelay(seconds: unknown): number | undefined {
  const value =
    typeof seconds === "number"
      ? seconds
      : typeof seconds === "string" && seconds.trim() !== ""
        ? Number(seconds)
        : Number.NaN;
  if (!Number.isFinite(value) || value < 0) return undefined;
  return Math.min(MAX_RETRY_MS, Math.max(MIN_RETRY_MS, value * 1_000));
}

async function raceWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  onAbort?: () => void,
): Promise<T> {
  if (signal.aborted) {
    onAbort?.();
    fail();
  }
  return await new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      onAbort?.();
      reject(new TelegramDeliveryError());
    };
    const cleanup = (): void => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

async function boundedBody(
  response: Response,
  signal: AbortSignal,
): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let cancelled = false;
  const cancel = (): void => {
    if (cancelled) return;
    cancelled = true;
    void reader.cancel().catch(() => undefined);
  };
  try {
    while (length <= MAX_RESPONSE_BYTES) {
      const result = await raceWithAbort(reader.read(), signal, cancel);
      if (result.done) break;
      const remaining = MAX_RESPONSE_BYTES + 1 - length;
      const chunk = result.value.slice(0, remaining);
      chunks.push(chunk);
      length += chunk.byteLength;
      if (length > MAX_RESPONSE_BYTES) break;
    }
  } finally {
    cancel();
  }
  if (length > MAX_RESPONSE_BYTES) return "";
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function parsedJson(body: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function retryAfter(
  response: Response,
  parsed: Record<string, unknown> | undefined,
): number {
  const parameters = parsed?.parameters;
  const jsonValue =
    typeof parameters === "object" &&
    parameters !== null &&
    !Array.isArray(parameters)
      ? (parameters as Record<string, unknown>).retry_after
      : undefined;
  return (
    boundedDelay(jsonValue) ??
    boundedDelay(response.headers.get("Retry-After")) ??
    1_000
  );
}

export class TelegramClient implements Notifier {
  readonly #url: string;
  readonly #chatIds: readonly string[];
  readonly #fetch: FetchLike;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #random: () => number;
  readonly #timeoutMs: number;

  constructor(options: TelegramClientOptions) {
    if (!TOKEN.test(options.token) || !CHAT_ID.test(options.chatId)) fail();
    const timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000)
      fail();
    this.#url = `https://api.telegram.org/bot${options.token}/sendMessage`;
    this.#chatIds = options.chatId.split(",").map((id) => id.trim());
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#sleep =
      options.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)));
    void options.clock;
    this.#random = options.random ?? Math.random;
    this.#timeoutMs = timeoutMs;
  }

  async send(
    message: string,
    options: TelegramSendOptions = {},
  ): Promise<void> {
    if (
      typeof message !== "string" ||
      message.length === 0 ||
      message.length > MAX_MESSAGE_LENGTH
    )
      fail();
    for (const chatId of this.#chatIds)
      await this.sendToChat(message, chatId, options);
  }

  private async sendToChat(
    message: string,
    chatId: string,
    options: TelegramSendOptions,
  ): Promise<void> {
    const body = JSON.stringify({
      chat_id: chatId,
      text: message,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      disable_web_page_preview: true,
    });

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      if (options.signal?.aborted === true) fail();
      const controller = new AbortController();
      const abort = (): void => controller.abort();
      options.signal?.addEventListener("abort", abort, { once: true });
      const timeout = setTimeout(abort, this.#timeoutMs);
      let retryDelay: number | undefined;
      try {
        let response: Response | undefined;
        try {
          response = await raceWithAbort(
            this.#fetch(this.#url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body,
              signal: controller.signal,
            }),
            controller.signal,
          );
        } catch {
          if (
            options.signal?.aborted ||
            controller.signal.aborted ||
            attempt === MAX_ATTEMPTS - 1
          )
            fail();
          retryDelay = this.#backoff(attempt);
        }

        if (response !== undefined) {
          let text: string;
          try {
            text = await boundedBody(response, controller.signal);
          } catch {
            fail();
          }
          const parsed = parsedJson(text);
          if (response.ok && parsed?.ok === true) return;
          const retryable = response.status === 429 || response.status >= 500;
          if (!retryable || attempt === MAX_ATTEMPTS - 1) fail();
          retryDelay =
            response.status === 429
              ? retryAfter(response, parsed)
              : this.#backoff(attempt);
        }
      } catch {
        fail();
      } finally {
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", abort);
      }
      if (retryDelay === undefined) fail();
      await this.#wait(retryDelay, options.signal);
    }
    fail();
  }

  #backoff(attempt: number): number {
    let random = 0;
    try {
      random = this.#random();
    } catch {
      fail();
    }
    const jitter = Number.isFinite(random)
      ? Math.max(0, Math.min(1, random))
      : 0;
    return Math.min(
      MAX_RETRY_MS,
      250 * 2 ** attempt + Math.floor(jitter * 100),
    );
  }

  async #wait(
    milliseconds: number,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    try {
      const pending = this.#sleep(milliseconds);
      await (signal === undefined ? pending : raceWithAbort(pending, signal));
    } catch {
      fail();
    }
  }
}
