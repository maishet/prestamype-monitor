import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  GetFunctionConfigurationCommand,
  LambdaClient,
} from "@aws-sdk/client-lambda";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { chromium } from "playwright";

import { DynamoRepository } from "../adapters/dynamodb-repository.js";
import {
  CaptureSessionError,
  type CaptureBrowserLauncher,
  type CaptureDependencies,
} from "./capture-session.js";

interface SsmLike {
  send(
    command: GetParameterCommand,
    options?: { abortSignal?: AbortSignal },
  ): Promise<unknown>;
}

interface LambdaLike {
  send(
    command: GetFunctionConfigurationCommand,
    options?: { abortSignal?: AbortSignal },
  ): Promise<unknown>;
}

/** The deployed scan function; it holds the table and key path it reads. */
const DEFAULT_SCAN_FUNCTION = "prestamype-monitor-scan";
const TABLE_PATTERN = /^[A-Za-z0-9_.-]{3,255}$/;
const PARAMETER_PATTERN = /^\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/;

export interface AwsCaptureAdapterOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly ssm?: SsmLike;
  readonly lambda?: LambdaLike;
  readonly launcher?: CaptureBrowserLauncher;
  readonly store?: CaptureDependencies["store"];
  readonly signal?: AbortSignal;
}

function required(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  pattern: RegExp,
): string {
  const value = env[name];
  if (typeof value !== "string" || !pattern.test(value))
    throw new CaptureSessionError("Session capture is not configured");
  return value;
}

function decodeKey(value: unknown): Uint8Array {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(value))
    throw new CaptureSessionError("Session key is unavailable");
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== 32 || decoded.toString("base64") !== value)
    throw new CaptureSessionError("Session key is unavailable");
  return new Uint8Array(decoded);
}

function isBlank(value: string | undefined): boolean {
  return value === undefined || value.trim() === "";
}

/**
 * Hand-typed TABLE_NAME / SESSION_KEY_PARAMETER drifted from the deployed
 * stack once (the docs named resources that never existed), so a capture
 * looked done but saved nowhere the monitor reads. When they are not set,
 * take them from the scan function itself: the session lands exactly where
 * the monitor looks for it.
 */
async function resolveTargets(
  options: AwsCaptureAdapterOptions,
  env: Readonly<Record<string, string | undefined>>,
): Promise<Readonly<Record<string, string | undefined>>> {
  const functionName = isBlank(env.PRESTAMYPE_SCAN_FUNCTION)
    ? DEFAULT_SCAN_FUNCTION
    : env.PRESTAMYPE_SCAN_FUNCTION!;
  const lambda = options.lambda ?? new LambdaClient({});
  let output: unknown;
  try {
    output = await lambda.send(
      new GetFunctionConfigurationCommand({ FunctionName: functionName }),
      options.signal === undefined
        ? undefined
        : { abortSignal: options.signal },
    );
    options.signal?.throwIfAborted();
  } catch {
    throw new CaptureSessionError("Session capture is not configured");
  }
  const variables = (
    output as { Environment?: { Variables?: Record<string, unknown> } }
  )?.Environment?.Variables;
  const pick = (name: string): string | undefined =>
    !isBlank(env[name])
      ? env[name]
      : typeof variables?.[name] === "string"
        ? (variables[name] as string)
        : undefined;
  return {
    ...env,
    TABLE_NAME: pick("TABLE_NAME"),
    SESSION_KEY_PARAMETER: pick("SESSION_KEY_PARAMETER"),
  };
}

export async function createCaptureDependencies(
  options: AwsCaptureAdapterOptions = {},
): Promise<CaptureDependencies> {
  const given = options.env ?? process.env;
  // Only a lookup awaits: a fully configured run reaches SSM synchronously.
  const env =
    isBlank(given.TABLE_NAME) || isBlank(given.SESSION_KEY_PARAMETER)
      ? await resolveTargets(options, given)
      : given;
  const tableName = required(env, "TABLE_NAME", TABLE_PATTERN);
  const parameterName = required(
    env,
    "SESSION_KEY_PARAMETER",
    PARAMETER_PATTERN,
  );
  options.signal?.throwIfAborted();
  const ssm = options.ssm ?? new SSMClient({});
  let output: unknown;
  try {
    output = await ssm.send(
      new GetParameterCommand({ Name: parameterName, WithDecryption: true }),
      options.signal === undefined
        ? undefined
        : { abortSignal: options.signal },
    );
    options.signal?.throwIfAborted();
  } catch {
    throw new CaptureSessionError("Session key is unavailable");
  }
  const value = (output as { Parameter?: { Value?: unknown } } | undefined)
    ?.Parameter?.Value;
  const key = decodeKey(value);
  const store =
    options.store ??
    new DynamoRepository({
      client: DynamoDBDocumentClient.from(new DynamoDBClient({})),
      tableName,
    });
  return {
    launcher: options.launcher ?? (chromium as CaptureBrowserLauncher),
    store,
    key,
    output: (message) => console.log(message),
  };
}
