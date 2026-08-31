import { describe, expect, it } from "vitest";
import {
  runtimeErrorKind,
  storedRuntimeError,
} from "../../src/runtime/errors.js";

describe("runtime error normalization", () => {
  it("survives hostile name and message getters without exposing causes", () => {
    const error = new Error("safe");
    Object.defineProperty(error, "name", {
      get() {
        throw new Error("secret-name");
      },
    });
    Object.defineProperty(error, "message", {
      get() {
        throw new Error("secret-message");
      },
    });
    expect(runtimeErrorKind(error)).toBe("RuntimeError");
    expect(storedRuntimeError(error, new Date(Number.NaN), "bad id!")).toEqual({
      class: "RuntimeError",
      message: "Runtime failure",
      timestamp: "1970-01-01T00:00:00.000Z",
    });
  });
});
