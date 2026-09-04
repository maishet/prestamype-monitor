import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");

describe("local Lambda build smoke", () => {
  it("resolves external browser runtimes from a separate Lambda layer", () => {
    const output = execFileSync(
      process.execPath,
      [resolve(root, "scripts/smoke-sam-build.mjs"), "--json"],
      { cwd: root, encoding: "utf8" },
    );
    expect(JSON.parse(output)).toEqual({
      scanBundle: true,
      chromiumExternal: true,
      playwrightExternal: true,
      createRequireLoader: true,
      dynamicChromiumLoader: true,
      scanNodeModulesAbsent: true,
      layerChromiumBin: true,
      layerPlaywrightCore: true,
      templateLayerLinked: true,
      layerBuildsWithoutMake: true,
      runtimeHandler: true,
      runtimePlaywright: true,
      runtimeChromiumArgs: true,
      runtimeExecutableExists: true,
      temporaryArtifactRemoved: true,
    });
  }, 15_000);
});
