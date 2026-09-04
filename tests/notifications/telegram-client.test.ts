import { describe, expect, it, vi } from "vitest";

import {
  TelegramClient,
  TelegramDeliveryError,
} from "../../src/notifications/telegram-client.js";

const token = "123456789:SECRET_TOKEN_CANARY_abcdef";
const chatId = "-1001234567890";
const response = (
  status: number,
  body: string,
  headers?: HeadersInit,
): Response =>
  new Response(body, { status, ...(headers === undefined ? {} : { headers }) });

describe("TelegramClient", () => {
  it("posts the exact safe Telegram payload", async () => {
    const fetch = vi.fn<
      (input: string, init?: RequestInit) => Promise<Response>
    >(async () => response(200, '{"ok":true}'));
    await new TelegramClient({ token, chatId, fetch }).send("<b>hola</b>");

    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]!;
    expect(init).toBeDefined();
    if (init === undefined) throw new Error("missing request init");
    expect(url).toBe(`https://api.telegram.org/bot${token}/sendMessage`);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(String(init.body))).toEqual({
      chat_id: chatId,
      text: "<b>hola</b>",
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      disable_web_page_preview: true,
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("retries network errors and 5xx at most twice with injected bounded backoff", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error(`network ${token}`))
      .mockResolvedValueOnce(response(503, "bad gateway TOKEN_BODY_CANARY"))
      .mockResolvedValueOnce(response(200, '{"ok":true}'));
    const sleep = vi.fn(async () => undefined);
    const random = vi.fn(() => 0);
    await new TelegramClient({ token, chatId, fetch, sleep, random }).send(
      "MESSAGE_CANARY",
    );
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(
      sleep.mock.calls.flat().every((ms) => ms >= 100 && ms <= 5_000),
    ).toBe(true);
  });

  it("uses retry_after from JSON or header, with a safe minimum and five-second cap", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response(429, '{"ok":false,"parameters":{"retry_after":99}}'),
      )
      .mockResolvedValueOnce(response(429, "malformed", { "Retry-After": "0" }))
      .mockResolvedValueOnce(response(200, '{"ok":true}'));
    const sleep = vi.fn(async () => undefined);
    await new TelegramClient({ token, chatId, fetch, sleep }).send("hello");
    expect(sleep).toHaveBeenNthCalledWith(1, 5_000);
    expect(sleep).toHaveBeenNthCalledWith(2, 100);
  });

  it("does not retry ordinary 4xx responses", async () => {
    const fetch = vi.fn(async () =>
      response(400, '{"ok":false,"description":"BODY_CANARY"}'),
    );
    await expect(
      new TelegramClient({ token, chatId, fetch }).send("MESSAGE_CANARY"),
    ).rejects.toBeInstanceOf(TelegramDeliveryError);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    () => Promise.resolve(response(200, "malformed TOKEN_BODY_CANARY")),
    () =>
      Promise.resolve(
        response(200, '{"ok":false,"description":"TOKEN_BODY_CANARY"}'),
      ),
    () => Promise.reject(new Error(`FETCH_CANARY ${token}`)),
  ])(
    "throws only a generic error without token, message, body, or raw cause",
    async (implementation) => {
      const fetch = vi.fn(implementation);
      try {
        await new TelegramClient({ token, chatId, fetch }).send(
          "MESSAGE_CANARY",
        );
        throw new Error("expected rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(TelegramDeliveryError);
        const serialized = JSON.stringify(error);
        expect(`${String(error)} ${serialized}`).not.toMatch(
          /SECRET_TOKEN|MESSAGE_CANARY|TOKEN_BODY|FETCH_CANARY/,
        );
        expect((error as Error).cause).toBeUndefined();
      }
    },
  );

  it("rejects invalid constructor inputs and oversized messages before fetch", async () => {
    const fetch = vi.fn();
    expect(() => new TelegramClient({ token: "bad", chatId, fetch })).toThrow(
      TelegramDeliveryError,
    );
    expect(
      () => new TelegramClient({ token, chatId: "bad chat", fetch }),
    ).toThrow(TelegramDeliveryError);
    await expect(
      new TelegramClient({ token, chatId, fetch }).send("x".repeat(4_001)),
    ).rejects.toThrow(TelegramDeliveryError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("honors caller abort and does not retry it", async () => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      await new Promise<void>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
      return response(200, '{"ok":true}');
    });
    const controller = new AbortController();
    const pending = new TelegramClient({
      token,
      chatId,
      fetch,
      timeoutMs: 10_000,
    }).send("hello", { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow(TelegramDeliveryError);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("keeps the watchdog active while a resolved response body stalls and cancels the reader", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull: () => new Promise(() => undefined),
      cancel,
    });
    const fetch = vi.fn(async () => new Response(body, { status: 200 }));
    const started = Date.now();

    await expect(
      new TelegramClient({ token, chatId, fetch, timeoutMs: 100 }).send(
        "hello",
      ),
    ).rejects.toThrow(TelegramDeliveryError);

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("aborts a stalled response body immediately when the caller aborts before the watchdog", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull: () => new Promise(() => undefined),
      cancel,
    });
    const fetch = vi.fn(async () => new Response(body, { status: 200 }));
    const controller = new AbortController();
    const pending = new TelegramClient({
      token,
      chatId,
      fetch,
      timeoutMs: 10_000,
    }).send("hello", { signal: controller.signal });

    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toThrow(TelegramDeliveryError);
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("aborts retry_after sleep immediately and never starts another fetch", async () => {
    const fetch = vi.fn(async () =>
      response(429, '{"ok":false,"parameters":{"retry_after":5}}'),
    );
    const sleep = vi.fn(() => new Promise<void>(() => undefined));
    const controller = new AbortController();
    const pending = new TelegramClient({ token, chatId, fetch, sleep }).send(
      "hello",
      { signal: controller.signal },
    );

    while (sleep.mock.calls.length === 0) await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toThrow(TelegramDeliveryError);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("keeps delivering to the other chats when one destination is stale", async () => {
    const seen: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const chatId = JSON.parse(String(init?.body)).chat_id as string;
      seen.push(chatId);
      // A group that Telegram upgraded to a supergroup answers 400 forever.
      return chatId === "-5247697722"
        ? new Response(JSON.stringify({ ok: false }), { status: 400 })
        : new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const client = new TelegramClient({
      token,
      chatId: "-5247697722,1524876607,-4203788857",
      fetch: fetchMock as unknown as typeof fetch,
      sleep: async () => undefined,
    });

    await expect(client.send("hola")).resolves.toBeUndefined();
    expect(new Set(seen)).toEqual(
      new Set(["-5247697722", "1524876607", "-4203788857"]),
    );
    expect(warn).toHaveBeenCalledWith(
      "Telegram delivery failed for some chats",
      expect.stringContaining('"delivered":2'),
    );
    // The log identifies the broken destination without printing it in full.
    expect(warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining("7722"),
    );
    expect(warn).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining("-5247697722"),
    );
    warn.mockRestore();
  });

  it("fails only when no destination accepted the message", async () => {
    const client = new TelegramClient({
      token,
      chatId: "-5247697722,-4203788857",
      fetch: (async () =>
        new Response(JSON.stringify({ ok: false }), {
          status: 400,
        })) as unknown as typeof fetch,
      sleep: async () => undefined,
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(client.send("hola")).rejects.toThrow(TelegramDeliveryError);
    warn.mockRestore();
  });
});
