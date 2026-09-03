import { GetParametersCommand } from "@aws-sdk/client-ssm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  SESSION_KEY_PARAMETER_ENV,
  TELEGRAM_CHAT_ID_PARAMETER_ENV,
  TELEGRAM_TOKEN_PARAMETER_ENV,
  createRuntimeSecretsLoader,
  resetRuntimeSecretsCacheForTests,
} from "../../src/adapters/parameter-store.js";

const names = {
  [TELEGRAM_TOKEN_PARAMETER_ENV]: "/prestamype/telegram-token",
  [TELEGRAM_CHAT_ID_PARAMETER_ENV]: "/prestamype/telegram-chat-id",
  [SESSION_KEY_PARAMETER_ENV]: "/prestamype/session-key",
};
const key = Buffer.alloc(32, 7).toString("base64");

describe("runtime secrets Parameter Store adapter", () => {
  beforeEach(() => resetRuntimeSecretsCacheForTests());

  it("requests the three configured names once with decryption and validates values", async () => {
    const send = vi.fn(async (command: GetParametersCommand) => {
      expect(command.input).toEqual({
        Names: Object.values(names),
        WithDecryption: true,
      });
      return {
        Parameters: [
          {
            Name: names.TELEGRAM_TOKEN_PARAMETER,
            Value: "123456789:AbCdEf_0123456789",
          },
          { Name: names.TELEGRAM_CHAT_ID_PARAMETER, Value: "-1001234567890" },
          { Name: names.SESSION_KEY_PARAMETER, Value: key },
        ],
      };
    });
    const load = createRuntimeSecretsLoader({ client: { send }, env: names });

    const result = await load();

    expect(result.telegramToken).toBe("123456789:AbCdEf_0123456789");
    expect(result.telegramChatId).toBe("-1001234567890");
    expect(result.sessionKey).toEqual(new Uint8Array(Buffer.alloc(32, 7)));
    expect(send).toHaveBeenCalledOnce();
  });

  it("accepts a comma-separated private chat and supergroup destination list", async () => {
    const send = vi.fn(async () => ({
      Parameters: [
        { Name: names.TELEGRAM_TOKEN_PARAMETER, Value: "123456789:AbCdEf_0123456789" },
        { Name: names.TELEGRAM_CHAT_ID_PARAMETER, Value: "1524876607,-1004295718410" },
        { Name: names.SESSION_KEY_PARAMETER, Value: key },
      ],
    }));
    const load = createRuntimeSecretsLoader({ client: { send }, env: names });

    await expect(load()).resolves.toMatchObject({
      telegramChatId: "1524876607,-1004295718410",
    });
  });

  it("shares an in-flight successful load and caches it for the warm process", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const send = vi.fn(async () => {
      await gate;
      return {
        Parameters: Object.values(names).map((Name, index) => ({
          Name,
          Value:
            index === 0
              ? "123456789:AbCdEf_0123456789"
              : index === 1
                ? "12345"
                : key,
        })),
      };
    });
    const load = createRuntimeSecretsLoader({ client: { send }, env: names });
    const first = load();
    const second = load();
    release();
    const [a, b] = await Promise.all([first, second]);

    expect(a).not.toBe(b);
    expect(a.sessionKey).not.toBe(b.sessionKey);
    a.sessionKey[0] = 99;
    expect(b.sessionKey[0]).toBe(7);
    const later = await load();
    expect(later).not.toBe(a);
    expect(later.sessionKey).not.toBe(a.sessionKey);
    expect(later.sessionKey[0]).toBe(7);
    expect(send).toHaveBeenCalledOnce();
  });

  it("clears a failed in-flight load so a later call retries", async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error("TOKEN_CANARY"))
      .mockResolvedValueOnce({
        Parameters: [
          {
            Name: names.TELEGRAM_TOKEN_PARAMETER,
            Value: "123456789:AbCdEf_0123456789",
          },
          { Name: names.TELEGRAM_CHAT_ID_PARAMETER, Value: "12345" },
          { Name: names.SESSION_KEY_PARAMETER, Value: key },
        ],
      });
    const load = createRuntimeSecretsLoader({ client: { send }, env: names });

    await expect(load()).rejects.toThrow("Runtime secrets unavailable");
    await expect(load()).resolves.toMatchObject({ telegramChatId: "12345" });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("rejects an already-aborted load without calling or caching SSM", async () => {
    const send = vi.fn();
    const load = createRuntimeSecretsLoader({ client: { send }, env: names });
    const controller = new AbortController();
    controller.abort();
    await expect(load({ signal: controller.signal })).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  it("passes abortSignal to SSM and does not cache an aborted request", async () => {
    const valid = {
      Parameters: Object.values(names).map((Name, index) => ({
        Name,
        Value:
          index === 0
            ? "123456789:AbCdEf_0123456789"
            : index === 1
              ? "12345"
              : key,
      })),
    };
    let attempt = 0;
    const send = vi.fn(
      async (
        _command: GetParametersCommand,
        options?: { abortSignal?: AbortSignal },
      ) => {
        attempt += 1;
        if (attempt > 1) return valid;
        await new Promise<void>((_resolve, reject) =>
          options?.abortSignal?.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          ),
        );
        return valid;
      },
    );
    const load = createRuntimeSecretsLoader({ client: { send }, env: names });
    const controller = new AbortController();
    const pending = load({ signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow("Runtime secrets unavailable");
    await expect(load()).resolves.toMatchObject({ telegramChatId: "12345" });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it.each(["first", "second"] as const)(
    "lets the %s waiter abort without cancelling the other waiter",
    async (which) => {
      let resolveSend!: (value: unknown) => void;
      const send = vi.fn(
        async (
          _command: GetParametersCommand,
          options?: { abortSignal?: AbortSignal },
        ) =>
          await new Promise<unknown>((resolve, reject) => {
            resolveSend = resolve;
            options?.abortSignal?.addEventListener(
              "abort",
              () => reject(new Error("internal aborted")),
              { once: true },
            );
          }),
      );
      const load = createRuntimeSecretsLoader({ client: { send }, env: names });
      const firstController = new AbortController();
      const secondController = new AbortController();
      const first = load({ signal: firstController.signal });
      const second = load({ signal: secondController.signal });
      (which === "first" ? firstController : secondController).abort();
      resolveSend({
        Parameters: Object.values(names).map((Name, index) => ({
          Name,
          Value:
            index === 0
              ? "123456789:AbCdEf_0123456789"
              : index === 1
                ? "12345"
                : key,
        })),
      });
      const aborted = which === "first" ? first : second;
      const successful = which === "first" ? second : first;
      await expect(aborted).rejects.toThrow("Runtime secrets unavailable");
      await expect(successful).resolves.toMatchObject({
        telegramChatId: "12345",
      });
      expect(send).toHaveBeenCalledOnce();
    },
  );

  it("aborts the shared SSM request when all waiters abort and permits a future retry", async () => {
    let internalAborted = false;
    const valid = {
      Parameters: Object.values(names).map((Name, index) => ({
        Name,
        Value:
          index === 0
            ? "123456789:AbCdEf_0123456789"
            : index === 1
              ? "12345"
              : key,
      })),
    };
    const send = vi.fn(
      async (
        _command: GetParametersCommand,
        options?: { abortSignal?: AbortSignal },
      ) => {
        if (send.mock.calls.length > 1) return valid;
        return await new Promise<unknown>((_resolve, reject) =>
          options?.abortSignal?.addEventListener(
            "abort",
            () => {
              internalAborted = true;
              reject(new Error("internal aborted"));
            },
            { once: true },
          ),
        );
      },
    );
    const load = createRuntimeSecretsLoader({ client: { send }, env: names });
    const a = new AbortController();
    const b = new AbortController();
    const first = load({ signal: a.signal });
    const second = load({ signal: b.signal });
    a.abort();
    b.abort();
    await expect(first).rejects.toThrow("Runtime secrets unavailable");
    await expect(second).rejects.toThrow("Runtime secrets unavailable");
    expect(internalAborted).toBe(true);
    await expect(load()).resolves.toMatchObject({ telegramChatId: "12345" });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it.each([
    [{ ...names, TELEGRAM_TOKEN_PARAMETER: "secret-value".repeat(200) }],
    [{ ...names, SESSION_KEY_PARAMETER: names.TELEGRAM_TOKEN_PARAMETER }],
    [{ ...names, TELEGRAM_CHAT_ID_PARAMETER: "not/a/path" }],
  ])(
    "rejects invalid or duplicate parameter names before sending",
    async (env) => {
      const send = vi.fn();
      const load = createRuntimeSecretsLoader({ client: { send }, env });
      await expect(load()).rejects.toThrow("Runtime secrets unavailable");
      expect(send).not.toHaveBeenCalled();
    },
  );

  it.each([
    [{ Parameters: [], InvalidParameters: [names.TELEGRAM_TOKEN_PARAMETER] }],
    [{ Parameters: [{ Name: names.TELEGRAM_TOKEN_PARAMETER, Value: "x" }] }],
    [
      {
        Parameters: [
          {
            Name: names.TELEGRAM_TOKEN_PARAMETER,
            Value: "123456789:AbCdEf_0123456789",
          },
          {
            Name: names.TELEGRAM_TOKEN_PARAMETER,
            Value: "123456789:AbCdEf_0123456789",
          },
          { Name: names.TELEGRAM_CHAT_ID_PARAMETER, Value: "12345" },
          { Name: names.SESSION_KEY_PARAMETER, Value: key },
        ],
      },
    ],
    [
      {
        Parameters: [
          {
            Name: names.TELEGRAM_TOKEN_PARAMETER,
            Value: "123456789:AbCdEf_0123456789",
          },
          { Name: names.TELEGRAM_CHAT_ID_PARAMETER, Value: "12345" },
          { Name: names.SESSION_KEY_PARAMETER, Value: `${key.slice(0, -2)}xx` },
        ],
      },
    ],
  ])(
    "rejects incomplete, duplicate, invalid, or noncanonical values without leakage",
    async (output) => {
      const canary = JSON.stringify(output);
      const load = createRuntimeSecretsLoader({
        client: { send: vi.fn(async () => output) },
        env: names,
      });
      try {
        await load();
        throw new Error("expected rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect(String(error)).not.toContain(canary);
        expect((error as Error).cause).toBeUndefined();
      }
    },
  );
});
