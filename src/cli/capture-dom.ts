import { createInterface } from "node:readline/promises";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { sanitizeCapturedHtml } from "./dom-capture-sanitizer.js";

const ORIGIN = "https://www.prestamype.com";
const OPPORTUNITIES_URL = `${ORIGIN}/app/inversionista/oportunidades`;
const PORTFOLIO_URL = `${ORIGIN}/app/inversionista/mis-inversiones`;
const OUTPUT_DIRECTORY = "captures";

interface CaptureStep {
  readonly file: string;
  readonly instruction: string;
  readonly navigateTo?: string;
}

const PASSES: Readonly<Record<string, readonly CaptureStep[]>> = {
  "1": [
    {
      file: "01-oportunidades.html",
      instruction:
        "Inicia sesión y ESPERA a que la tabla muestre filas reales (no el mensaje 'Buscando las mejores oportunidades').",
      navigateTo: OPPORTUNITIES_URL,
    },
    {
      file: "02-panel-invertir.html",
      instruction:
        'Haz clic en el NOMBRE del cliente de la primera fila para abrir el panel "Detalle de inversión" (pestaña Invertir).',
    },
    {
      file: "03-panel-deudor.html",
      instruction:
        'Cambia a la pestaña "Deudor" y espera a que carguen los cuadros de historial.',
    },
    {
      file: "04-panel-proveedor.html",
      instruction:
        'Cambia a la pestaña "Proveedor" y espera a que carguen los cuadros.',
    },
    {
      file: "05-panel-facturas.html",
      instruction: 'Cambia a la pestaña "Facturas" y espera a que cargue.',
    },
    {
      file: "06-mis-inversiones.html",
      instruction: "Espera a que cargue la tabla de inversiones.",
      navigateTo: PORTFOLIO_URL,
    },
  ],
  "2": [
    {
      file: "07-filtros-abierto.html",
      instruction:
        'Haz clic en "Filtros" para DESPLEGAR el panel y déjalo abierto (con las casillas de riesgo y moneda visibles).',
      navigateTo: OPPORTUNITIES_URL,
    },
    {
      file: "08-orden-abierto.html",
      instruction:
        'Cierra Filtros, haz clic en "Ordenar por: ..." para DESPLEGAR la lista de opciones y déjala abierta.',
    },
    {
      file: "09-oportunidades-filtrado.html",
      instruction:
        'Aplica riesgos A+, A, B, C y el orden "Retorno mayor". Espera a que la tabla recargue con filas.',
    },
    {
      file: "10-panel-riesgo-letra.html",
      instruction:
        'Abre el panel de una oportunidad que muestre LETRA de riesgo (C o D), no el escudo de "Protegida".',
    },
    {
      file: "11-mis-inversiones-p2.html",
      instruction:
        'Ve a la PÁGINA 2 del paginador y espera. Busca la fila con el badge "Cobranza administrativa".',
      navigateTo: PORTFOLIO_URL,
    },
  ],
};

function structuralSummary(html: string): string {
  const count = (pattern: RegExp): number => html.match(pattern)?.length ?? 0;
  const dataRows = count(/class="row_table row_table--clickable"/g);
  const loading = count(/row_table--loading/g);
  return [
    `${(html.length / 1024).toFixed(0)} KB`,
    `${dataRows} filas con datos`,
    loading > 0 ? `⚠ ${loading} fila(s) AÚN CARGANDO` : "sin filas en carga",
    `${count(/<td\b/gi)} td`,
  ].join(" · ");
}

async function main(): Promise<void> {
  const passArgument = process.argv
    .slice(2)
    .find((argument) => /^--pass(?:=|$)/.test(argument));
  const pass = passArgument?.split("=")[1] ?? "1";
  const steps = PASSES[pass];
  if (steps === undefined) {
    throw new Error(`Pasada desconocida "${pass}". Usa --pass=1 o --pass=2.`);
  }

  const { chromium } = await import("playwright");
  const directory = resolve(process.cwd(), OUTPUT_DIRECTORY);
  await mkdir(directory, { recursive: true });
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const browser = await chromium.launch({ headless: false });
  try {
    const context = await browser.newContext({
      locale: "es-PE",
      timezoneId: "America/Lima",
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    console.log(`\nPasada ${pass} · salida: ${directory}`);
    console.log("El script no hace clic en nada. Tú manejas el navegador.\n");

    for (const [index, step] of steps.entries()) {
      if (step.navigateTo !== undefined) await page.goto(step.navigateTo);
      const answer = await readline.question(
        `[${index + 1}/${steps.length}] ${step.instruction}\n    Enter = capturar · s = omitir · q = salir: `,
      );
      const choice = answer.trim().toLowerCase();
      if (choice === "q") break;
      if (choice === "s") {
        console.log("    omitido\n");
        continue;
      }
      if (new URL(page.url()).origin !== ORIGIN) {
        console.log(
          `    ✗ el navegador no está en ${ORIGIN}; no capturo nada\n`,
        );
        continue;
      }
      const sanitized = sanitizeCapturedHtml(await page.content());
      await writeFile(resolve(directory, step.file), sanitized, "utf8");
      console.log(`    ✓ ${step.file} — ${structuralSummary(sanitized)}\n`);
    }
    console.log("Listo. Revisa los archivos antes de compartirlos.");
  } finally {
    readline.close();
    await browser.close().catch(() => undefined);
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void main().catch((error: unknown) => {
    console.error(
      error instanceof Error
        ? `Captura fallida: ${error.message}`
        : "Captura fallida",
    );
    process.exitCode = 1;
  });
}
