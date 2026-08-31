import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
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
  const supervisorDirectory = join(temporaryRoot, "supervisor");
  let result;
  try {
    const scan = await bundle(
      "src/lambda/handler.ts",
      scanDirectory,
      "handler",
      browserExternals,
    );
    const supervisor = await bundle(
      "src/lambda/supervisor.ts",
      supervisorDirectory,
      "supervisor",
    );
    const artifactModules = join(scanDirectory, "node_modules");
    const copied = new Set();
    for (const dependency of browserExternals) {
      await copyPackageClosure(dependency, artifactModules, copied);
    }

    const scanBundle = join(scanDirectory, "handler.mjs");
    const supervisorBundle = join(supervisorDirectory, "supervisor.mjs");
    const scanText = await readFile(scanBundle, "utf8");
    const unresolvedImports = [];
    for (const bundlePath of [scanBundle, supervisorBundle]) {
      try {
        await import(`${pathToFileURL(bundlePath).href}?smoke=${Date.now()}`);
      } catch (error) {
        unresolvedImports.push(
          error instanceof Error
            ? `${error.name}: ${error.message}`
            : "UnknownImportError",
        );
      }
    }
    result = {
      scanBundle:
        existsSync(scanBundle) && Object.keys(scan.metafile.outputs).length > 0,
      supervisorBundle:
        existsSync(supervisorBundle) &&
        Object.keys(supervisor.metafile.outputs).length > 0,
      chromiumExternal: scanText.includes("@sparticuz/chromium"),
      playwrightExternal: scanText.includes("playwright-core"),
      chromiumBinCopied: existsSync(
        join(artifactModules, "@sparticuz", "chromium", "bin", "chromium.br"),
      ),
      playwrightCoreCopied: existsSync(
        join(artifactModules, "playwright-core", "package.json"),
      ),
      unresolvedImports,
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
