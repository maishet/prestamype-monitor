import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");

describe("local Lambda build smoke", () => {
  it("externalizes and copies browser runtimes without unresolved imports", () => {
    const output = execFileSync(
      process.execPath,
      [resolve(root, "scripts/smoke-sam-build.mjs"), "--json"],
      { cwd: root, encoding: "utf8" },
    );
    expect(JSON.parse(output)).toEqual({
      scanBundle: true,
      supervisorBundle: true,
      chromiumExternal: true,
      playwrightExternal: true,
      chromiumBinCopied: true,
      playwrightCoreCopied: true,
      unresolvedImports: [],
      temporaryArtifactRemoved: true,
    });
  });
});
