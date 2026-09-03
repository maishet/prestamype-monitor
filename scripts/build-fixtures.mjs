import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { load } from "cheerio";
import { resolve } from "node:path";

const SOURCE = resolve(process.cwd(), "captures");
const TARGET = resolve(process.cwd(), "tests/fixtures/live");

const KEEP = new Map([
  ["09-oportunidades-filtrado.html", "opportunities-table.html"],
  ["10-panel-riesgo-letra.html", "panel-invertir-riesgo-letra.html"],
  ["02-panel-invertir.html", "panel-invertir-protegida.html"],
  ["03-panel-deudor.html", "panel-deudor.html"],
  ["04-panel-proveedor.html", "panel-proveedor.html"],
  ["05-panel-facturas.html", "panel-facturas.html"],
  ["06-mis-inversiones.html", "mis-inversiones.html"],
  ["07-filtros-abierto.html", "filtros-abierto.html"],
  ["08-orden-abierto.html", "orden-abierto.html"],
  ["01-oportunidades.html", "opportunities-table-loading.html"],
]);

const NOISE_SELECTORS = [
  '[id*="Cybot"]',
  '[class*="Cybot"]',
  '[id*="hs-feedback"]',
  '[id*="hs-web-interactives"]',
  '[id*="poptin"]',
  '[class*="poptin"]',
  "iframe",
  "svg",
].join(", ");

function reduce(html) {
  const $ = load(html);
  $(NOISE_SELECTORS).remove();
  $("script, style, noscript").remove();
  for (const element of $("*").toArray()) {
    for (const name of Object.keys(element.attribs ?? {})) {
      if (/^data-v-[0-9a-f]{6,10}$/.test(name)) $(element).removeAttr(name);
    }
  }
  return $.html().replace(/[ \t]{2,}/g, " ");
}

async function main() {
  await mkdir(TARGET, { recursive: true });
  const available = new Set(await readdir(SOURCE));
  let kept = 0;
  for (const [source, target] of KEEP) {
    if (!available.has(source)) {
      console.log(`  – ${source} no está en captures/, omitido`);
      continue;
    }
    const original = await readFile(resolve(SOURCE, source), "utf8");
    const reduced = reduce(original);
    await writeFile(resolve(TARGET, target), reduced, "utf8");
    kept += 1;
    console.log(
      `  ✓ ${target.padEnd(36)} ${(original.length / 1024).toFixed(0)} KB → ${(reduced.length / 1024).toFixed(0)} KB`,
    );
  }
  console.log(`\n${kept} fixtures escritos en tests/fixtures/live`);
}

await main();
