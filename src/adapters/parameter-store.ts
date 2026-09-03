import { GetParametersCommand, SSMClient } from "@aws-sdk/client-ssm";

export const TELEGRAM_TOKEN_PARAMETER_ENV = "TELEGRAM_TOKEN_PARAMETER";
export const TELEGRAM_CHAT_ID_PARAMETER_ENV = "TELEGRAM_CHAT_ID_PARAMETER";
export const SESSION_KEY_PARAMETER_ENV = "SESSION_KEY_PARAMETER";

export interface RuntimeSecrets {
  readonly telegramToken: string;
  readonly telegramChatId: string;
  readonly sessionKey: Uint8Array;
}

function copySecrets(secrets: RuntimeSecrets): RuntimeSecrets {
  return Object.freeze({
    telegramToken: secrets.telegramToken,
    telegramChatId: secrets.telegramChatId,
    sessionKey: new Uint8Array(secrets.sessionKey),
  });
}

interface ParameterStoreClientLike {
  send(
    command: GetParametersCommand,
    options?: { abortSignal?: AbortSignal },
  ): Promise<unknown>;
}

export interface LoadRuntimeSecretsOptions {
  readonly signal?: AbortSignal;
}

export interface RuntimeSecretsLoaderOptions {
  readonly client: ParameterStoreClientLike;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export class RuntimeSecretsError extends Error {
  constructor() {
    super("Runtime secrets unavailable");
    this.name = "RuntimeSecretsError";
  }
}

const resetters = new Set<() => void>();
const PARAMETER_NAME = /^\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/;
const TOKEN = /^\d{6,12}:[A-Za-z0-9_-]{16,128}$/;
const CHAT_ID = /^-?\d{1,20}(?:\s*,\s*-?\d{1,20})*$/;

function fail(): never {
  throw new RuntimeSecretsError();
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parameterNames(
  env: Readonly<Record<string, string | undefined>>,
): readonly [string, string, string] {
  const values = [
    env[TELEGRAM_TOKEN_PARAMETER_ENV],
    env[TELEGRAM_CHAT_ID_PARAMETER_ENV],
    env[SESSION_KEY_PARAMETER_ENV],
  ];
  if (
    values.some(
      (value) =>
        typeof value !== "string" ||
        value.length > 1_011 ||
        !PARAMETER_NAME.test(value),
    ) ||
    new Set(values).size !== 3
  )
    fail();
  return values as [string, string, string];
}

function decodeCanonicalKey(value: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) fail();
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== 32 || decoded.toString("base64") !== value) fail();
  return new Uint8Array(decoded);
}

async function requestSecrets(
  client: ParameterStoreClientLike,
  env: Readonly<Record<string, string | undefined>>,
  options?: LoadRuntimeSecretsOptions,
): Promise<RuntimeSecrets> {
  try {
    options?.signal?.throwIfAborted();
    const names = parameterNames(env);
    const output = record(
      await client.send(
        new GetParametersCommand({ Names: [...names], WithDecryption: true }),
        options?.signal === undefined
          ? undefined
          : { abortSignal: options.signal },
      ),
    );
    options?.signal?.throwIfAborted();
    if (
      !Array.isArray(output?.Parameters) ||
      (Array.isArray(output.InvalidParameters) &&
        output.InvalidParameters.length > 0)
    )
      fail();
    const found = new Map<string, string>();
    for (const raw of output.Parameters) {
      const item = record(raw);
      if (
        typeof item?.Name !== "string" ||
        typeof item.Value !== "string" ||
        !names.includes(item.Name) ||
        found.has(item.Name)
      )
        fail();
      found.set(item.Name, item.Value);
    }
    if (found.size !== names.length) fail();
    const telegramToken = found.get(names[0]);
    const telegramChatId = found.get(names[1]);
    const rawKey = found.get(names[2]);
    if (
      telegramToken === undefined ||
      telegramChatId === undefined ||
      rawKey === undefined ||
      !TOKEN.test(telegramToken) ||
      !CHAT_ID.test(telegramChatId)
    )
      fail();
    return Object.freeze({
      telegramToken,
      telegramChatId,
      sessionKey: decodeCanonicalKey(rawKey),
    });
  } catch {
    fail();
  }
}

export function createRuntimeSecretsLoader(
  options: RuntimeSecretsLoaderOptions,
): (loadOptions?: LoadRuntimeSecretsOptions) => Promise<RuntimeSecrets> {
  let cached: RuntimeSecrets | undefined;
  let inFlight:
    | {
        readonly controller: AbortController;
        readonly promise: Promise<RuntimeSecrets>;
        waiters: number;
        settled: boolean;
      }
    | undefined;
  const reset = (): void => {
    cached = undefined;
    inFlight?.controller.abort();
    inFlight = undefined;
  };
  resetters.add(reset);
  return async (loadOptions) => {
    if (loadOptions?.signal?.aborted === true) throw new RuntimeSecretsError();
    if (cached !== undefined) return copySecrets(cached);
    if (inFlight === undefined) {
      const controller = new AbortController();
      const state = {
        controller,
        promise: Promise.resolve(undefined as never) as Promise<RuntimeSecrets>,
        waiters: 0,
        settled: false,
      };
      state.promise = requestSecrets(options.client, options.env, {
        signal: controller.signal,
      });
      inFlight = state;
      void state.promise.then(
        (secrets) => {
          state.settled = true;
          cached = secrets;
          if (inFlight === state) inFlight = undefined;
        },
        () => {
          state.settled = true;
          if (inFlight === state) inFlight = undefined;
        },
      );
    }
    const state = inFlight;
    state.waiters += 1;
    try {
      const secrets = await new Promise<RuntimeSecrets>((resolve, reject) => {
        const signal = loadOptions?.signal;
        const abort = (): void => reject(new RuntimeSecretsError());
        signal?.addEventListener("abort", abort, { once: true });
        void state.promise
          .then(resolve, reject)
          .finally(() => signal?.removeEventListener("abort", abort));
      });
      return copySecrets(secrets);
    } finally {
      state.waiters -= 1;
      if (state.waiters === 0 && !state.settled) state.controller.abort();
    }
  };
}

export function resetRuntimeSecretsCacheForTests(): void {
  for (const reset of resetters) reset();
}

const defaultLoader = createRuntimeSecretsLoader({
  client: new SSMClient({}),
  env: process.env,
});

export function loadRuntimeSecrets(
  options?: LoadRuntimeSecretsOptions,
): Promise<RuntimeSecrets> {
  return defaultLoader(options);
}
