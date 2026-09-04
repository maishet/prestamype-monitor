import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const browserExternals = ["@sparticuz/chromium", "playwright-core"];

function packageDirectory(packageName) {
  return join(root, "node_modules", ...packageName.split("/"));
}

async function copyPackageClosure(packageName, artifactModules, copied) {
  if (copied.has(packageName)) return;
  const source = packageDirectory(packageName);
  const manifestPath = join(source, "package.json");
  if (!existsSync(manifestPath)) {
    throw new Error(
      `Missing installed package required by build: ${packageName}`,
    );
  }
  copied.add(packageName);
  const destination = join(artifactModules, ...packageName.split("/"));
  await cp(source, destination, { recursive: true });
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const dependencies = {
    ...(manifest.dependencies ?? {}),
    ...(manifest.optionalDependencies ?? {}),
  };
  for (const dependency of Object.keys(dependencies)) {
    await copyPackageClosure(dependency, artifactModules, copied);
  }
}

async function bundle(entryPoint, outputDirectory, entryName, external = []) {
  return build({
    absWorkingDir: root,
    entryPoints: [entryPoint],
    outdir: outputDirectory,
    entryNames: entryName,
    outExtension: { ".js": ".mjs" },
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
    minify: true,
    sourcemap: false,
    external,
    metafile: true,
    logLevel: "silent",
  });
}

export async function runSmokeBuild() {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "prestamype-sam-smoke-"));
  const scanDirectory = join(temporaryRoot, "scan");
  const layerDirectory = join(temporaryRoot, "layer");
  let result;
  try {
    const scan = await bundle(
      "src/lambda/handler.ts",
      scanDirectory,
      "handler",
      browserExternals,
    );
    const artifactModules = join(layerDirectory, "nodejs", "node_modules");
    const copied = new Set();
    for (const dependency of browserExternals) {
      await copyPackageClosure(dependency, artifactModules, copied);
    }

    const scanBundle = join(scanDirectory, "handler.mjs");
    const scanText = await readFile(scanBundle, "utf8");
    const runtimeProbe = JSON.parse(
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          [
            "import { createRequire } from 'node:module';",
            "import { existsSync } from 'node:fs';",
            `const handler = await import(${JSON.stringify(pathToFileURL(scanBundle).href)});`,
            "const runtimeRequire = createRequire(import.meta.url);",
            "const playwright = runtimeRequire('playwright-core');",
            "const chromium = runtimeRequire('@sparticuz/chromium').default;",
            "const executable = await chromium.executablePath();",
            "process.stdout.write(JSON.stringify({",
            "handler: typeof handler.handler === 'function',",
            "playwright: typeof playwright.chromium?.launch === 'function',",
            "chromiumArgs: Array.isArray(chromium.args),",
            "executableExists: existsSync(executable)",
            "}));",
          ].join(" "),
        ],
        {
          cwd: scanDirectory,
          encoding: "utf8",
          env: {
            ...process.env,
            NODE_PATH: join(layerDirectory, "nodejs", "node_modules"),
          },
        },
      ),
    );
    const template = JSON.parse(await readFile(join(root, "template.yaml")));
    const scanLayers = template.Resources.ScanFunction.Properties.Layers;
    const layer = template.Resources.BrowserDependenciesLayer;
    const layerMakefile = await readFile(
      join(root, "layers", "browser", "Makefile"),
      "utf8",
    );
    result = {
      scanBundle:
        existsSync(scanBundle) && Object.keys(scan.metafile.outputs).length > 0,
      chromiumExternal: scanText.includes("@sparticuz/chromium"),
      playwrightExternal: scanText.includes("playwright-core"),
      createRequireLoader: scanText.includes("createRequire(import.meta.url)"),
      dynamicChromiumLoader:
        scanText.includes("pathToFileURL") &&
        scanText.includes("@sparticuz/chromium"),
      scanNodeModulesAbsent: !existsSync(join(scanDirectory, "node_modules")),
      layerChromiumBin: existsSync(
        join(artifactModules, "@sparticuz", "chromium", "bin", "chromium.br"),
      ),
      layerPlaywrightCore: existsSync(
        join(artifactModules, "playwright-core", "package.json"),
      ),
      templateLayerLinked:
        JSON.stringify(scanLayers) ===
          JSON.stringify([{ Ref: "BrowserDependenciesLayer" }]) &&
        layer?.Properties?.ContentUri === "layers/browser" &&
        layer?.Metadata?.BuildMethod === "makefile",
      layerMakefileCi: layerMakefile.includes("npm ci --omit=dev"),
      runtimeHandler: runtimeProbe.handler,
      runtimePlaywright: runtimeProbe.playwright,
      runtimeChromiumArgs: runtimeProbe.chromiumArgs,
      runtimeExecutableExists: runtimeProbe.executableExists,
      temporaryArtifactRemoved: false,
    };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
  return {
    ...result,
    temporaryArtifactRemoved: !existsSync(temporaryRoot),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await runSmokeBuild();
  process.stdout.write(
    process.argv.includes("--json")
      ? `${JSON.stringify(result)}\n`
      : `SAM smoke build passed: ${JSON.stringify(result, null, 2)}\n`,
  );
}
