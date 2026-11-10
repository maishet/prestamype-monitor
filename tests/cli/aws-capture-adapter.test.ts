import { describe, expect, it, vi } from "vitest";

import { createCaptureDependencies } from "../../src/cli/aws-capture-adapter.js";
import { CaptureSessionError } from "../../src/cli/capture-session.js";

const ENV = {
  TABLE_NAME: "prestamype-monitor",
  SESSION_KEY_PARAMETER: "/prestamype/monitor/session-key",
};

describe("AWS capture adapter", () => {
  it("loads and validates the decrypted session key without logging it", async () => {
    const key = Buffer.alloc(32, 7).toString("base64");
    const send = vi.fn(async () => ({ Parameter: { Value: key } }));
    const launcher = { launch: vi.fn() };
    const store = {
      loadEncryptedSession: vi.fn(),
      saveEncryptedSession: vi.fn(),
    };
    const dependencies = await createCaptureDependencies({
      env: ENV,
      ssm: { send },
      launcher,
      store,
    });
    expect(send).toHaveBeenCalledOnce();
    expect(dependencies.launcher).toBe(launcher);
    expect(dependencies.store).toBe(store);
    expect(dependencies.key).toEqual(new Uint8Array(32).fill(7));
    expect(JSON.stringify(dependencies)).not.toContain(key);
  });

  it("normalizes parameter failures without exposing the secret", async () => {
    await expect(
      createCaptureDependencies({
        env: ENV,
        ssm: {
          send: vi.fn(async () => {
            throw new Error("token=TOP-SECRET");
          }),
        },
      }),
    ).rejects.toEqual(new CaptureSessionError("Session key is unavailable"));
  });

  it("takes table and key path from the scan function when unset", async () => {
    const key = Buffer.alloc(32, 7).toString("base64");
    const lambdaSend = vi.fn(async (command: { input: unknown }) => {
      expect(command.input).toEqual({
        FunctionName: "prestamype-monitor-scan",
      });
      return {
        Environment: {
          Variables: {
            TABLE_NAME: "prestamype-monitor-MonitorTable-ABC",
            SESSION_KEY_PARAMETER: "/prestamype/prod/session-key",
          },
        },
      };
    });
    const send = vi.fn(async (command: { input: { Name?: string | undefined } }) => {
      expect(command.input.Name).toBe("/prestamype/prod/session-key");
      return { Parameter: { Value: key } };
    });
    const dependencies = await createCaptureDependencies({
      env: {},
      ssm: { send },
      lambda: { send: lambdaSend },
      launcher: { launch: vi.fn() },
    });
    expect(lambdaSend).toHaveBeenCalledOnce();
    expect(dependencies.key).toEqual(new Uint8Array(32).fill(7));
  });

  it("does not query the scan function when both targets are set", async () => {
    const lambdaSend = vi.fn();
    await createCaptureDependencies({
      env: ENV,
      ssm: {
        send: vi.fn(async () => ({
          Parameter: { Value: Buffer.alloc(32, 1).toString("base64") },
        })),
      },
      lambda: { send: lambdaSend },
      launcher: { launch: vi.fn() },
      store: { loadEncryptedSession: vi.fn(), saveEncryptedSession: vi.fn() },
    });
    expect(lambdaSend).not.toHaveBeenCalled();
  });

  it("reports a missing configuration when the scan function is unreadable", async () => {
    await expect(
      createCaptureDependencies({
        env: {},
        ssm: { send: vi.fn() },
        lambda: {
          send: vi.fn(async () => {
            throw new Error("AccessDenied");
          }),
        },
      }),
    ).rejects.toEqual(
      new CaptureSessionError("Session capture is not configured"),
    );
  });

  it("passes capture cancellation to a pending decrypted SSM read", async () => {
    const controller = new AbortController();
    const send = vi.fn(
      async (_command: unknown, options?: { abortSignal?: AbortSignal }) =>
        await new Promise<never>((_resolve, reject) => {
          options?.abortSignal?.addEventListener(
            "abort",
            () => reject(new Error("token=TOP-SECRET")),
            { once: true },
          );
        }),
    );
    const pending = createCaptureDependencies({
      env: ENV,
      ssm: { send },
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toEqual(
      new CaptureSessionError("Session key is unavailable"),
    );
    expect(send).toHaveBeenCalledWith(expect.anything(), {
      abortSignal: controller.signal,
    });
  });
});
