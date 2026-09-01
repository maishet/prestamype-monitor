import { describe, expect, it, vi } from "vitest";
// @ts-expect-error The operational helper intentionally remains dependency-free JavaScript.
import { putSecureParameters } from "../../scripts/put-secure-parameters.mjs";

describe("secure parameter helper", () => {
  it("writes three SecureStrings sequentially without logging", async () => {
    const calls: unknown[] = [];
    await putSecureParameters(
      {
        region: "sa-east-1",
        parameters: [
          { name: "/p/token", value: "secret-1" },
          { name: "/p/chat", value: "secret-2" },
          { name: "/p/key", value: "secret-3" },
        ],
      },
      {
        put: vi.fn(async (request: unknown) => {
          calls.push(request);
        }),
      },
    );
    expect(calls).toEqual([
      {
        Name: "/p/token",
        Value: "secret-1",
        Type: "SecureString",
        Overwrite: true,
      },
      {
        Name: "/p/chat",
        Value: "secret-2",
        Type: "SecureString",
        Overwrite: true,
      },
      {
        Name: "/p/key",
        Value: "secret-3",
        Type: "SecureString",
        Overwrite: true,
      },
    ]);
  });

  it("rejects malformed or duplicate names before the duplicate write", async () => {
    const put = vi.fn();
    await expect(
      putSecureParameters({ region: "bad", parameters: [] }, { put }),
    ).rejects.toThrow("Invalid secure parameter request");
    await expect(
      putSecureParameters(
        {
          region: "sa-east-1",
          parameters: [
            { name: "/p/a", value: "1" },
            { name: "/p/a", value: "2" },
            { name: "/p/c", value: "3" },
          ],
        },
        { put },
      ),
    ).rejects.toThrow("Invalid secure parameter request");
    expect(put).not.toHaveBeenCalled();
  });

  it.each([1, 2, 3])(
    "fails generically without attempting later writes at position %s",
    async (failure) => {
      let count = 0;
      const sentinel = "TOP-SECRET-SENTINEL";
      const operation = putSecureParameters(
        {
          region: "sa-east-1",
          parameters: [
            { name: "/p/one", value: `${sentinel}-1` },
            { name: "/p/two", value: `${sentinel}-2` },
            { name: "/p/three", value: `${sentinel}-3` },
          ],
        },
        {
          put: async () => {
            count += 1;
            if (count === failure) throw new Error(sentinel);
          },
        },
      );
      await expect(operation).rejects.toThrow("Secure parameter update failed");
      await expect(operation).rejects.not.toThrow(sentinel);
      expect(count).toBe(failure);
    },
  );
});
