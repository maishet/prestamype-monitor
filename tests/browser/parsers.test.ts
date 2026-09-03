import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { PageStructureError } from "../../src/browser/errors.js";
import {
  parseOpportunityCards,
  parseOpportunityDetail,
} from "../../src/browser/parsers.js";

const fixture = (name: string) =>
  readFile(new URL(`../fixtures/${name}`, import.meta.url), "utf8");

describe("parseOpportunityCards", () => {
  it("parses exact values, cents, percentages, identities, and stable link IDs", async () => {
    const summaries = parseOpportunityCards(
      await fixture("opportunities.html"),
    );

    expect(summaries).toHaveLength(4);
    expect(
      summaries.map(({ id, risk, annualReturnPct }) => ({
        id,
        risk,
        annualReturnPct,
      })),
    ).toEqual([
      { id: "opp-a-16", risk: "A", annualReturnPct: 16 },
      { id: "opp-c-20", risk: "C", annualReturnPct: 20 },
      { id: "opp-d-21", risk: "D", annualReturnPct: 21 },
      { id: "opp-b-149", risk: "B", annualReturnPct: 14.9 },
    ]);
    expect(summaries[0]).toEqual({
      id: "opp-a-16",
      url: "https://www.prestamype.com/app/inversionista/oportunidades/opp-a-16",
      supplier: { legalName: "Textiles Aurora S.A.C.", taxId: "20600010001" },
      debtor: { legalName: "Mercados del Sur S.A.", taxId: "20500020002" },
      risk: "A",
      currency: "PEN",
      annualReturnPct: 16,
      remainingAmountCents: 1_234_567,
    });
    expect(summaries[1]?.supplier.taxId).toBeNull();
    expect(summaries[1]?.debtor.taxId).toBeNull();
  });

  it.each([
    ["external host", "https://evil.example/opportunities/steal"],
    ["plain HTTP", "http://prestamype.com/opportunities/plain"],
    [
      "credentials",
      "https://user:secret@prestamype.com/opportunities/credentials",
    ],
    ["javascript", "javascript:alert(1)"],
  ])("rejects a dangerous %s link", (_label, href) => {
    const html = validCard().replace(
      "/app/inversionista/oportunidades/safe-id",
      href,
    );

    expect(() => parseOpportunityCards(html)).toThrowError(
      expect.objectContaining({ code: "INVALID_URL", field: "url" }),
    );
  });

  it.each([["mixed invalid", "1,23.456"]])(
    "rejects %s numeric syntax",
    (_label, amount) => {
      const html = validCard().replace("S/ 1.234,56", `S/ ${amount}`);

      expect(() => parseOpportunityCards(html)).toThrowError(
        expect.objectContaining({
          code: "INVALID_FIELD",
          field: "remainingAmountCents",
        }),
      );
    },
  );

  it.each([
    ["S/ 1.234,56", 123_456],
    ["S/ 6,807.52", 680_752],
    ["S/ 0.00", 0],
    ["S/ 1.234", 123_400],
    ["S/ 1,234", 123_400],
  ])("parses observed and integer-thousands money %s", (amount, cents) => {
    const html = validCard().replace("S/ 1.234,56", amount);
    expect(parseOpportunityCards(html)[0]?.remainingAmountCents).toBe(cents);
  });

  it("accepts controlled English numeric formatting", () => {
    const html = validCard()
      .replace("S/ 1.234,56", "PEN 1,234.56")
      .replace("16,25 %", "16.25 %");

    expect(parseOpportunityCards(html)[0]).toMatchObject({
      annualReturnPct: 16.25,
      remainingAmountCents: 123_456,
    });
  });

  it("parses a live table amount without its adjacent funding percentage", () => {
    const summaries = parseOpportunityCards(`<table><tbody>
      <tr class="row_table">
        <td><div class="cell-content client"><span class="label">Cliente S.A.C.</span></div></td>
        <td><div class="badge-risk">A</div></td>
        <td><div class="cell-content"><div class="label amount-label">S/ 194,596.10</div><span class="percentage-number">0%</span></div></td>
        <td>Factoring</td>
        <td><div class="tir-column">16.08 %</div></td>
        <td>08 nov. 2026</td>
      </tr>
    </tbody></table>`);

    expect(summaries).toEqual([
      expect.objectContaining({
        risk: "A",
        currency: "PEN",
        annualReturnPct: 16.08,
        remainingAmountCents: 19_459_610,
        rowIndex: 0,
      }),
    ]);
  });

  it.each([
    [
      "subdomain",
      "https://app.prestamype.com/app/inversionista/oportunidades/subdomain",
    ],
    ["API path", "https://prestamype.com/api/opportunities/api-id"],
    ["arbitrary path", "https://prestamype.com/not-an-opportunity/arbitrary"],
    [
      "query",
      "https://prestamype.com/app/inversionista/oportunidades/query-id?token=hidden",
    ],
    [
      "fragment",
      "https://prestamype.com/app/inversionista/oportunidades/fragment-id#private",
    ],
  ])(
    "rejects a Prestamype %s that is not the canonical opportunity route",
    (_label, href) => {
      const html = validCard().replace(
        "/app/inversionista/oportunidades/safe-id",
        href,
      );

      expect(() => parseOpportunityCards(html)).toThrowError(
        expect.objectContaining({ code: "INVALID_URL", field: "url" }),
      );
    },
  );

  it("requires percentage notation for returns", () => {
    const html = validCard().replace("16,25 %", "S/ 16,25");

    expect(() => parseOpportunityCards(html)).toThrowError(
      expect.objectContaining({
        code: "INVALID_FIELD",
        field: "annualReturnPct",
      }),
    );
  });

  it("rejects percentage notation in money fields", () => {
    const html = validCard().replace("S/ 1.234,56", "1.234,56 %");

    expect(() => parseOpportunityCards(html)).toThrowError(
      expect.objectContaining({
        code: "INVALID_FIELD",
        field: "remainingAmountCents",
      }),
    );
  });

  it("uses selector alternatives by priority rather than document order", () => {
    const html = validCard().replace(
      '<span data-field="annual-return">16,25 %</span>',
      '<span class="annual-return">99 %</span><span data-field="annual-return">16,25 %</span>',
    );

    expect(parseOpportunityCards(html)[0]?.annualReturnPct).toBe(16.25);
  });

  it("throws a typed safe error for malformed essential fields", () => {
    const sensitive = "SECRET-CARD-DUMP-987";
    const html = validCard().replace("16,25 %", sensitive);

    let thrown: unknown;
    try {
      parseOpportunityCards(html);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(PageStructureError);
    expect(thrown).toMatchObject({
      code: "INVALID_FIELD",
      field: "annualReturnPct",
    });
    expect((thrown as Error).message).not.toContain(sensitive);
    expect((thrown as Error).message).not.toContain("<article");
  });
});

describe("parseOpportunityDetail", () => {
  it("parses a complete opportunity and both payment histories", async () => {
    const summary = parseOpportunityCards(
      await fixture("opportunities.html"),
    )[0]!;
    const opportunity = parseOpportunityDetail(
      await fixture("opportunity-detail.html"),
      summary,
    );

    expect(opportunity).toEqual({
      id: "opp-a-16",
      url: "https://www.prestamype.com/app/inversionista/oportunidades/opp-a-16",
      supplier: { legalName: "Textiles Aurora S.A.C.", taxId: "20600010001" },
      debtor: { legalName: "Mercados del Sur S.A.", taxId: "20500020002" },
      risk: "A",
      currency: "PEN",
      annualReturnPct: 16,
      monthlyReturnPct: 1.25,
      totalAmountCents: 2_000_000,
      fundedAmountCents: 765_433,
      remainingAmountCents: 1_234_567,
      closesAt: "2026-09-02T23:00:00-05:00",
      dueAt: "2026-12-15",
      debtorHistory: {
        totalAuctions: 120,
        paidOnTime: 108,
        paidLate: 8,
        currentOnTime: 3,
        overdue: 1,
        averageDelayDays: 2.5,
        delinquencyPct: 0.83,
        historicalAmountCents: 123_456_789,
      },
      supplierHistory: {
        totalAuctions: 45,
        paidOnTime: 41,
        paidLate: 2,
        currentOnTime: 2,
        overdue: 0,
        averageDelayDays: 1,
        delinquencyPct: 0,
        historicalAmountCents: 25_000_000,
      },
      collectionProblem: false,
    });
  });

  it("returns null for absent optional detail values and histories", () => {
    const summary = parseOpportunityCards(validCard())[0]!;
    const opportunity = parseOpportunityDetail(
      `<main data-page="opportunity-detail">
        <span data-field="total-amount">S/ 2.000,00</span>
        <span data-field="funded-amount">S/ 765,44</span>
        <span data-field="remaining-amount">S/ 1.234,56</span>
      </main>`,
      summary,
    );

    expect(opportunity).toMatchObject({
      monthlyReturnPct: null,
      closesAt: null,
      dueAt: null,
      debtorHistory: null,
      supplierHistory: null,
      collectionProblem: false,
    });
  });

  it("limits parsing to the explicit detail container and ignores outside noise", () => {
    const summary = parseOpportunityCards(validCard())[0]!;
    const html = `<span data-field="total-amount">S/ 999.999,99</span>
      <main data-page="opportunity-detail">
        <span data-field="total-amount">S/ 2.000,00</span>
        <span data-field="funded-amount">S/ 765,44</span>
        <span data-field="remaining-amount">S/ 1.234,56</span>
      </main>`;

    expect(parseOpportunityDetail(html, summary).totalAmountCents).toBe(
      200_000,
    );
  });

  it("supports the explicit secondary detail-container alternative", () => {
    const summary = parseOpportunityCards(validCard())[0]!;
    const html = `<main class="opportunity-detail-page">
      <span class="total-amount">S/ 2.000,00</span>
      <span class="funded-amount">S/ 765,44</span>
      <span class="remaining-amount">S/ 1.234,56</span>
    </main>`;

    expect(parseOpportunityDetail(html, summary).remainingAmountCents).toBe(
      123_456,
    );
  });

  it("requires an explicit detail container", () => {
    const summary = parseOpportunityCards(validCard())[0]!;

    expect(() =>
      parseOpportunityDetail(validDetailBody(), summary),
    ).toThrowError(
      expect.objectContaining({ code: "MISSING_FIELD", field: "detailPage" }),
    );
  });

  it.each([
    "Cobranza administrativa II",
    "En cobranza legal",
    "Vencido hace 3 dias",
    "Factura vencida",
    "Documentos vencidos",
    "Vencimientos problematicos",
    "Vencimiento problemático",
    "En mora",
    "Presenta morosidad",
    "Cliente moroso",
    "Incumplido",
    "Incumplimiento contractual",
  ])(
    "recognizes the conservative problematic collection family: %s",
    (status) => {
      const summary = parseOpportunityCards(validCard())[0]!;
      const html = `<main data-page="opportunity-detail">${validDetailBody()}
      <span data-field="collection-status">${status}</span>
    </main>`;

      expect(parseOpportunityDetail(html, summary).collectionProblem).toBe(
        true,
      );
    },
  );

  it.each([
    "Al dia",
    "Pagado",
    "Sin mora",
    "No vencido",
    "No se encuentra vencido",
    "Sin señales de morosidad",
    "SIN   COBRANZA",
    "No hay incumplimiento",
    "Sin vencimientos problemáticos",
    "No hay ninguna señal de mora",
    "Sin evidencia actual alguna de morosidad",
    "No hay ningún indicio de mora",
    "Sin constancia reciente alguna de morosidad",
    "Sin señal de mora",
    "No en mora",
    "Sin estado de mora",
    "No vencido ni en mora",
    "Sin mora ni cobranza",
    "No vencido ni en mora ni cobranza",
  ])(
    'does not flag the safe or locally negated collection status "%s"',
    (status) => {
      const summary = parseOpportunityCards(validCard())[0]!;
      const html = `<main data-page="opportunity-detail">${validDetailBody()}
      <span data-field="collection-status">${status}</span>
    </main>`;

      expect(parseOpportunityDetail(html, summary).collectionProblem).toBe(
        false,
      );
    },
  );

  it("still flags another independent, non-negated indicator", () => {
    const summary = parseOpportunityCards(validCard())[0]!;
    const html = `<main data-page="opportunity-detail">${validDetailBody()}
      <span data-field="collection-status">Sin mora inicial; posteriormente vencido</span>
    </main>`;

    expect(parseOpportunityDetail(html, summary).collectionProblem).toBe(true);
  });

  it.each([
    "Sin mora, pero vencido",
    "No vencido; en mora",
    "Sin evidencia de mora aunque figura como incumplido",
    "Sin mora mas vencido",
    "Sin mora — vencido",
    "Sin mora / vencido",
    "Sin mora y luego vencido",
    "No vencido no obstante en mora",
    "No pagado, en mora",
    "Sin pago; vencido",
    "No regularizado y en cobranza",
    "Sin abono / incumplimiento",
  ])(
    "flags a non-negated indicator in a separate nearby clause: %s",
    (status) => {
      const summary = parseOpportunityCards(validCard())[0]!;
      const html = `<main data-page="opportunity-detail">${validDetailBody()}
      <span data-field="collection-status">${status}</span>
    </main>`;

      expect(parseOpportunityDetail(html, summary).collectionProblem).toBe(
        true,
      );
    },
  );

  it("rejects a money unit inconsistent with the opportunity currency", () => {
    const summary = parseOpportunityCards(validCard())[0]!;
    const html = `<main data-page="opportunity-detail">${validDetailBody().replace(
      "S/ 2.000,00",
      "USD 2.000,00",
    )}</main>`;

    expect(() => parseOpportunityDetail(html, summary)).toThrowError(
      expect.objectContaining({
        code: "INVALID_FIELD",
        field: "totalAmountCents",
      }),
    );
  });

  it("allows one negator to cover only the first subsequent indicator", () => {
    const summary = parseOpportunityCards(validCard())[0]!;
    const html = `<main data-page="opportunity-detail">${validDetailBody()}
      <span data-field="collection-status">Sin mora vencido</span>
    </main>`;

    expect(parseOpportunityDetail(html, summary).collectionProblem).toBe(true);
  });

  it("rejects an impossible calendar date", () => {
    const summary = parseOpportunityCards(validCard())[0]!;
    const html = `<main data-page="opportunity-detail">${validDetailBody()}
      <time data-field="due-at" datetime="2026-02-30"></time>
    </main>`;

    expect(() => parseOpportunityDetail(html, summary)).toThrowError(
      expect.objectContaining({ code: "INVALID_FIELD", field: "dueAt" }),
    );
  });

  it("does not guess when an essential detail amount is missing", () => {
    const summary = parseOpportunityCards(validCard())[0]!;

    expect(() =>
      parseOpportunityDetail(
        `<main data-page="opportunity-detail">
          <span data-field="total-amount">S/ 2.000,00</span>
          <span data-field="remaining-amount">S/ 1.234,56</span>
        </main>`,
        summary,
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "MISSING_FIELD",
        field: "fundedAmountCents",
      }),
    );
  });
});

function validCard(): string {
  return `<article data-opportunity-card>
    <a data-field="detail-link" href="/app/inversionista/oportunidades/safe-id">Detalle</a>
    <span data-field="supplier-name">Proveedor Seguro S.A.C.</span>
    <span data-field="debtor-name">Pagador Seguro S.A.</span>
    <span data-field="risk">A+</span>
    <span data-field="annual-return">16,25 %</span>
    <span data-field="currency">PEN</span>
    <span data-field="remaining-amount">S/ 1.234,56</span>
  </article>`;
}

function validDetailBody(): string {
  return `<span data-field="total-amount">S/ 2.000,00</span>
    <span data-field="funded-amount">S/ 765,44</span>
    <span data-field="remaining-amount">S/ 1.234,56</span>`;
}
