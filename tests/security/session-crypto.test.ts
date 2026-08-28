import { describe, expect, it } from "vitest";
import { createCipheriv } from "node:crypto";

import type { EncryptedSession } from "../../src/domain/types.js";
import {
  decryptSession,
  encryptSession,
} from "../../src/security/session-crypto.js";

const key = new Uint8Array(32).fill(7);
const state = {
  cookies: [
    {
      name: "session",
      value: "secret",
      domain: "prestamype.com",
      path: "/",
      expires: -1,
      httpOnly: true,
      secure: true,
      sameSite: "Lax" as const,
      partitionKey: "https://prestamype.com",
    },
  ],
  origins: [
    {
      origin: "https://prestamype.com",
      localStorage: [{ name: "theme", value: "light" }],
    },
  ],
};

describe("session crypto", () => {
  it("round trips a browser storage state using fresh 12-byte IVs", () => {
    const first = encryptSession(state, key);
    const second = encryptSession(state, key);

    expect(decryptSession(first, key)).toEqual(state);
    expect(first.iv).not.toBe(second.iv);
    expect(Buffer.from(first.iv, "base64")).toHaveLength(12);
    expect(Buffer.from(first.authTag, "base64")).toHaveLength(16);
  });

  it("requires a Uint8Array key of exactly 32 bytes", () => {
    expect(() => encryptSession(state, new Uint8Array(31))).toThrow(
      "Encryption key must be exactly 32 bytes",
    );
    expect(() =>
      decryptSession(encryptSession(state, key), new Uint8Array(33)),
    ).toThrow("Encryption key must be exactly 32 bytes");
    expect(() => encryptSession(state, "not-a-key" as never)).toThrow(
      "Encryption key must be exactly 32 bytes",
    );
  });

  it.each(["ciphertext", "iv", "authTag"] as const)(
    "rejects modified %s without exposing encrypted data",
    (field) => {
      const payload = encryptSession(state, key);
      const bytes = Buffer.from(payload[field], "base64");
      bytes[0] = bytes[0]! ^ 1;
      const changed = { ...payload, [field]: bytes.toString("base64") };
      expect(() => decryptSession(changed, key)).toThrow(
        "Invalid encrypted session",
      );
      try {
        decryptSession(changed, key);
      } catch (error) {
        expect(String(error)).not.toContain(payload[field]);
      }
    },
  );

  it("strictly validates schema, canonical base64 and encoded sizes", () => {
    const payload = encryptSession(state, key);
    for (const changed of [
      { ...payload, schemaVersion: 2 },
      { ...payload, iv: `${payload.iv}\n` },
      { ...payload, iv: Buffer.alloc(11).toString("base64") },
      { ...payload, authTag: Buffer.alloc(15).toString("base64") },
      { ...payload, ciphertext: "AA===" },
    ]) {
      expect(() => decryptSession(changed as EncryptedSession, key)).toThrow(
        "Invalid encrypted session",
      );
    }
  });

  it("rejects oversized ciphertext before decryption", () => {
    const payload = encryptSession(state, key);
    const oversized = {
      ...payload,
      ciphertext: Buffer.alloc(1024 * 1024 + 1).toString("base64"),
    };
    expect(() => decryptSession(oversized, key)).toThrow(
      "Invalid encrypted session",
    );
  });

  it("rejects an absurd encoded ciphertext before base64 decoding", () => {
    const payload = encryptSession(state, key);
    expect(() =>
      decryptSession(
        { ...payload, ciphertext: "A".repeat(2 * 1024 * 1024) },
        key,
      ),
    ).toThrow("Invalid encrypted session");
  });

  it("authenticates the schema domain as AAD", () => {
    const payload = encryptSession(state, key);
    const legacyAadCiphertext = (() => {
      const iv = Buffer.alloc(12, 1);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const ciphertext = Buffer.concat([
        cipher.update(JSON.stringify(state)),
        cipher.final(),
      ]);
      return {
        schemaVersion: 1 as const,
        iv: iv.toString("base64"),
        ciphertext: ciphertext.toString("base64"),
        authTag: cipher.getAuthTag().toString("base64"),
      };
    })();
    expect(payload.schemaVersion).toBe(1);
    expect(() => decryptSession(legacyAadCiphertext, key)).toThrow(
      "Invalid encrypted session",
    );
  });

  it("rejects invalid JSON and unsafe or malformed storage state", () => {
    const encryptRaw = (raw: string): EncryptedSession => {
      const iv = Buffer.alloc(12, 2);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from("prestamype-session:v1"));
      const ciphertext = Buffer.concat([cipher.update(raw), cipher.final()]);
      return {
        schemaVersion: 1,
        iv: iv.toString("base64"),
        ciphertext: ciphertext.toString("base64"),
        authTag: cipher.getAuthTag().toString("base64"),
      };
    };

    for (const raw of [
      "not-json",
      '"C:/session.json"',
      '{"cookies":[],"origins":[],"__proto__":{"polluted":true}}',
      '{"cookies":"bad","origins":[]}',
      '{"cookies":[{"name":"x"}],"origins":[]}',
    ]) {
      expect(() => decryptSession(encryptRaw(raw), key)).toThrow(
        "Invalid encrypted session",
      );
    }
  });
});
