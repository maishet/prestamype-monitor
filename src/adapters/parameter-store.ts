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
  send(command: GetParametersCommand): Promise<unknown>;
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
const CHAT_ID = /^-?\d{1,20}$/;

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
): Promise<RuntimeSecrets> {
  try {
    const names = parameterNames(env);
    const output = record(
      await client.send(
        new GetParametersCommand({ Names: [...names], WithDecryption: true }),
      ),
    );
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
): () => Promise<RuntimeSecrets> {
  let cache: Promise<RuntimeSecrets> | undefined;
  const reset = (): void => {
    cache = undefined;
  };
  resetters.add(reset);
  return () => {
    if (cache === undefined) {
      const pending = requestSecrets(options.client, options.env);
      cache = pending;
      void pending.catch(() => {
        if (cache === pending) cache = undefined;
      });
    }
    return cache.then(copySecrets);
  };
}

export function resetRuntimeSecretsCacheForTests(): void {
  for (const reset of resetters) reset();
}

const defaultLoader = createRuntimeSecretsLoader({
  client: new SSMClient({}),
  env: process.env,
});

export function loadRuntimeSecrets(): Promise<RuntimeSecrets> {
  return defaultLoader();
}
