import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { BrowserContextOptions } from "playwright-core";

import type { EncryptedSession } from "../domain/types.js";

const AAD = Buffer.from("prestamype-session:v1", "utf8");
const MAX_CIPHERTEXT_BYTES = 1024 * 1024;
const MAX_CIPHERTEXT_BASE64_LENGTH = Math.ceil(MAX_CIPHERTEXT_BYTES / 3) * 4;
const MAX_ITEMS = 10_000;
const MAX_STRING_LENGTH = 64 * 1024;
const INVALID_MESSAGE = "Invalid encrypted session";

type OfficialStorageState = Exclude<
  BrowserContextOptions["storageState"],
  string | undefined
>;

export type StorageCookie = OfficialStorageState["cookies"][number] & {
  partitionKey?: string;
};

export interface StorageState extends Omit<OfficialStorageState, "cookies"> {
  cookies: StorageCookie[];
}

function assertKey(key: Uint8Array): void {
  if (!(key instanceof Uint8Array) || key.byteLength !== 32) {
    throw new Error("Encryption key must be exactly 32 bytes");
  }
}

function invalid(): never {
  throw new Error(INVALID_MESSAGE);
}

function decodeBase64(
  value: unknown,
  exactLength?: number,
  maximumEncodedLength?: number,
): Buffer {
  if (
    typeof value !== "string" ||
    value === "" ||
    (maximumEncodedLength !== undefined &&
      value.length > maximumEncodedLength) ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    return invalid();
  }
  const decoded = Buffer.from(value, "base64");
  if (
    decoded.toString("base64") !== value ||
    (exactLength !== undefined && decoded.byteLength !== exactLength)
  ) {
    return invalid();
  }
  return decoded;
}

function safeString(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_STRING_LENGTH;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return (
    Object.keys(value).every((key) => keys.includes(key)) &&
    !Object.keys(value).some(
      (key) =>
        key === "__proto__" || key === "prototype" || key === "constructor",
    )
  );
}

function parseStorageState(value: unknown): StorageState {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ["cookies", "origins"]))
    return invalid();
  if (!Array.isArray(value.cookies) || !Array.isArray(value.origins))
    return invalid();
  if (value.cookies.length > MAX_ITEMS || value.origins.length > MAX_ITEMS)
    return invalid();

  const cookies = value.cookies.map((candidate) => {
    if (
      !isPlainRecord(candidate) ||
      !hasOnlyKeys(candidate, [
        "name",
        "value",
        "domain",
        "path",
        "expires",
        "httpOnly",
        "secure",
        "sameSite",
        "partitionKey",
      ])
    )
      return invalid();
    if (
      !safeString(candidate.name) ||
      !safeString(candidate.value) ||
      !safeString(candidate.domain) ||
      !safeString(candidate.path) ||
      typeof candidate.expires !== "number" ||
      !Number.isFinite(candidate.expires) ||
      typeof candidate.httpOnly !== "boolean" ||
      typeof candidate.secure !== "boolean" ||
      !["Strict", "Lax", "None"].includes(candidate.sameSite as string)
    )
      return invalid();
    if (candidate.partitionKey !== undefined) {
      if (!safeString(candidate.partitionKey)) return invalid();
      try {
        const partitionUrl = new URL(candidate.partitionKey);
        if (partitionUrl.origin !== candidate.partitionKey) return invalid();
      } catch {
        return invalid();
      }
    }
    return {
      name: candidate.name,
      value: candidate.value,
      domain: candidate.domain,
      path: candidate.path,
      expires: candidate.expires,
      httpOnly: candidate.httpOnly,
      secure: candidate.secure,
      sameSite: candidate.sameSite as StorageCookie["sameSite"],
      ...(candidate.partitionKey === undefined
        ? {}
        : { partitionKey: candidate.partitionKey }),
    };
  });
  const origins = value.origins.map((candidate) => {
    if (
      !isPlainRecord(candidate) ||
      !hasOnlyKeys(candidate, ["origin", "localStorage"]) ||
      !safeString(candidate.origin) ||
      !Array.isArray(candidate.localStorage) ||
      candidate.localStorage.length > MAX_ITEMS
    )
      return invalid();
    try {
      const origin = new URL(candidate.origin);
      if (
        origin.origin !== candidate.origin ||
        origin.username !== "" ||
        origin.password !== ""
      )
        return invalid();
    } catch {
      return invalid();
    }
    const localStorage = candidate.localStorage.map((entry) => {
      if (
        !isPlainRecord(entry) ||
        !hasOnlyKeys(entry, ["name", "value"]) ||
        !safeString(entry.name) ||
        !safeString(entry.value)
      )
        return invalid();
      return { name: entry.name, value: entry.value };
    });
    return { origin: candidate.origin, localStorage };
  });
  return { cookies, origins };
}

export function encryptSession(
  storageState: unknown,
  key: Uint8Array,
): EncryptedSession {
  assertKey(key);
  const validated = parseStorageState(storageState);
  const plaintext = Buffer.from(JSON.stringify(validated), "utf8");
  if (plaintext.byteLength > MAX_CIPHERTEXT_BYTES) return invalid();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    schemaVersion: 1,
    iv: iv.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

export function decryptSession(
  payload: EncryptedSession,
  key: Uint8Array,
): StorageState {
  assertKey(key);
  try {
    if (
      !isPlainRecord(payload) ||
      payload.schemaVersion !== 1 ||
      !hasOnlyKeys(payload, ["schemaVersion", "iv", "ciphertext", "authTag"])
    )
      return invalid();
    const iv = decodeBase64(payload.iv, 12);
    const authTag = decodeBase64(payload.authTag, 16);
    const ciphertext = decodeBase64(
      payload.ciphertext,
      undefined,
      MAX_CIPHERTEXT_BASE64_LENGTH,
    );
    if (ciphertext.byteLength > MAX_CIPHERTEXT_BYTES) return invalid();
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(AAD);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return parseStorageState(JSON.parse(plaintext.toString("utf8")) as unknown);
  } catch {
    return invalid();
  }
}
