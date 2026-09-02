import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
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

export interface AwsCaptureAdapterOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly ssm?: SsmLike;
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

export async function createCaptureDependencies(
  options: AwsCaptureAdapterOptions = {},
): Promise<CaptureDependencies> {
  const env = options.env ?? process.env;
  const tableName = required(env, "TABLE_NAME", /^[A-Za-z0-9_.-]{3,255}$/);
  const parameterName = required(
    env,
    "SESSION_KEY_PARAMETER",
    /^\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/,
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
