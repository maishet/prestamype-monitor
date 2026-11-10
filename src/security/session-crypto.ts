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
  _crHasCrossSiteAncestor?: boolean;
};

export interface StorageState extends Omit<OfficialStorageState, "cookies"> {
  cookies: StorageCookie[];
}

function assertKey(key: Uint8Array): void {
  if (!(key instanceof Uint8Array) || key.byteLength !== 32) {
    throw new Error("Encryption key must be exactly 32 bytes");
  }
}

// The reason names the failing field, never its value, so a rejected
// capture says what to fix without leaking session material.
function invalid(reason?: string): never {
  throw new Error(
    reason === undefined ? INVALID_MESSAGE : `${INVALID_MESSAGE} (${reason})`,
  );
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
    return invalid("state.keys");
  if (!Array.isArray(value.cookies) || !Array.isArray(value.origins))
    return invalid("state.arrays");
  if (value.cookies.length > MAX_ITEMS || value.origins.length > MAX_ITEMS)
    return invalid("state.size");

  const cookies = value.cookies.map((candidate) => {
    const cookieKeys = [
      "name",
      "value",
      "domain",
      "path",
      "expires",
      "httpOnly",
      "secure",
      "sameSite",
      "partitionKey",
      "_crHasCrossSiteAncestor",
    ];
    if (!isPlainRecord(candidate)) return invalid("cookie.shape");
    if (!hasOnlyKeys(candidate, cookieKeys))
      return invalid(
        `cookie.keys:${Object.keys(candidate)
          .filter((key) => !cookieKeys.includes(key))
          .join(",")}`,
      );
    const badFields = [
      ...(["name", "value", "domain", "path"] as const).filter(
        (field) => !safeString(candidate[field]),
      ),
      ...(typeof candidate.expires !== "number" ||
      !Number.isFinite(candidate.expires)
        ? ["expires"]
        : []),
      ...(typeof candidate.httpOnly !== "boolean" ? ["httpOnly"] : []),
      ...(typeof candidate.secure !== "boolean" ? ["secure"] : []),
      ...(candidate._crHasCrossSiteAncestor !== undefined &&
      typeof candidate._crHasCrossSiteAncestor !== "boolean"
        ? ["_crHasCrossSiteAncestor"]
        : []),
      ...(!["Strict", "Lax", "None"].includes(candidate.sameSite as string)
        ? ["sameSite"]
        : []),
    ];
    if (badFields.length > 0)
      return invalid(`cookie.${badFields.join(",")}`);
    if (candidate.partitionKey !== undefined) {
      if (!safeString(candidate.partitionKey)) return invalid("cookie.partitionKey");
      try {
        const partitionUrl = new URL(candidate.partitionKey);
        if (partitionUrl.origin !== candidate.partitionKey) return invalid("cookie.partitionKey");
      } catch {
        return invalid("cookie.partitionKey");
      }
    }
    return {
      name: candidate.name as string,
      value: candidate.value as string,
      domain: candidate.domain as string,
      path: candidate.path as string,
      expires: candidate.expires as number,
      httpOnly: candidate.httpOnly as boolean,
      secure: candidate.secure as boolean,
      sameSite: candidate.sameSite as StorageCookie["sameSite"],
      ...(candidate.partitionKey === undefined
        ? {}
        : { partitionKey: candidate.partitionKey }),
      ...(candidate._crHasCrossSiteAncestor === undefined
        ? {}
        : {
            _crHasCrossSiteAncestor:
              candidate._crHasCrossSiteAncestor as boolean,
          }),
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
      return invalid("origin.shape");
    try {
      const origin = new URL(candidate.origin);
      if (
        origin.origin !== candidate.origin ||
        origin.username !== "" ||
        origin.password !== ""
      )
        return invalid("origin.url");
    } catch {
      return invalid("origin.url");
    }
    const localStorage = candidate.localStorage.map((entry) => {
      if (
        !isPlainRecord(entry) ||
        !hasOnlyKeys(entry, ["name", "value"]) ||
        !safeString(entry.name) ||
        !safeString(entry.value)
      )
        return invalid("localStorage.entry");
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
  if (plaintext.byteLength > MAX_CIPHERTEXT_BYTES) return invalid("size");
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
