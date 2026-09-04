import { describe, expect, it } from "vitest";

import type {
  Evaluation,
  Opportunity,
  PaymentHistory,
  PortfolioSnapshot,
} from "../../src/domain/types.js";
import {
  formatOpportunityAlert,
  formatTechnicalAlert,
  type TechnicalAlertEvent,
} from "../../src/notifications/telegram-message.js";

const history: PaymentHistory = {
  totalAuctions: 12,
  paidOnTime: 11,
  paidLate: 1,
  currentOnTime: 0,
  overdue: 0,
  averageDelayDays: 1.5,
  delinquencyPct: 0,
  historicalAmountCents: 2_500_000,
};

const opportunity: Opportunity = {
  id: "opp-42",
  auctionCode: "M5dGmP0G",
  commercialName: "CLIENTE",
  investmentType: "Factoring",
  url: "https://www.prestamype.com/app/inversionista/oportunidades",
  supplier: { legalName: "Proveedor Andino S.A.C.", taxId: "20111111111" },
  debtor: { legalName: "Pagador Nacional S.A.", taxId: "20222222222" },
  risk: "A",
  currency: "PEN",
  annualReturnPct: 20,
  monthlyReturnPct: 1.53,
  totalAmountCents: 500_000,
  fundedAmountCents: 125_000,
  remainingAmountCents: 375_000,
  closesAt: "2026-08-28T01:00:00.000Z",
  dueAt: "2026-11-28T01:00:00.000Z",
  debtorHistory: history,
  supplierHistory: history,
  collectionProblem: false,
};

const portfolio: PortfolioSnapshot = {
  availableBalanceCents: 250_000,
  activeTotalCents: 1_000_000,
  exposureByParty: { "PAGADOR NACIONAL S A": 100_000 },
};

const evaluation: Evaluation = {
  decision: "INVEST",
  score: 91.4,
  components: { return: 15, risk: 10, debtorHistory: 28.5 },
  reasons: ["Buen historial del pagador", "Retorno atractivo"],
  warnings: ["Concentración resultante elevada"],
};

describe("formatOpportunityAlert", () => {
  const format = (
    over: Partial<Opportunity> = {},
    overEvaluation: Partial<Evaluation> = {},
    overPortfolio: Partial<PortfolioSnapshot> = {},
  ): string =>
    formatOpportunityAlert(
      { ...opportunity, ...over },
      { ...evaluation, ...overEvaluation },
      { ...portfolio, ...overPortfolio },
      new Date("2026-08-27T17:00:00.000Z"),
    );

  it("leads with the decision, the client and the terms", () => {
    const lines = format().split("\n");
    expect(lines[0]).toBe("<b>🔴 INVERTIR · CLIENTE</b>");
    expect(lines[1]).toBe(
      "Riesgo A · Factoring · 20.00% anual (1.53% mensual)",
    );
    expect(lines[2]).toBe("Restante S/3,750.00 de S/5,000.00 (25% financiado)");
  });

  it("stays short enough to read on a phone", () => {
    const message = format();
    expect(message.split("\n").length).toBeLessThanOrEqual(10);
    expect(message.length).toBeLessThan(600);
  });

  it("leaves out what the reader cannot act on", () => {
    const message = format({}, {}, { availableBalanceCents: 0 });
    // Deliberately absent: the balance, the auction code and the link.
    expect(message).not.toContain("saldo");
    expect(message).not.toContain("código");
    expect(message).not.toContain("<a href");
  });

  it("says how urgent the close is rather than only when it is", () => {
    const now = new Date("2026-09-03T12:00:00.000Z");
    const at = (closesAt: string) =>
      formatOpportunityAlert(
        { ...opportunity, closesAt },
        evaluation,
        portfolio,
        now,
      );
    expect(at("2026-09-03")).toContain("Cierra hoy");
    expect(at("2026-09-04")).toContain("Cierra mañana");
    expect(at("2026-09-10")).toContain("Cierra en 7 días");
  });

  it("states the term, which is what an annual rate must be judged against", () => {
    const message = formatOpportunityAlert(
      { ...opportunity, closesAt: "2026-09-03", dueAt: "2026-11-01" },
      evaluation,
      portfolio,
      new Date("2026-09-03T12:00:00.000Z"),
    );
    expect(message).toContain("pago 01 nov 2026 (59 días)");
  });

  it("adds the debtor's scale and punctuality when published", () => {
    const message = format({
      debtorHistory: {
        ...history,
        averageDelayDays: 10,
        historicalAmountCents: 950_000_000,
      },
    });
    expect(message).toContain("retraso medio 10 d");
    expect(message).toContain("S/9.5M histórico");
  });

  it("omits an implausible average delay instead of printing it", () => {
    // One debtor reported 1020 days; showing that as fact would be wrong.
    const message = format({
      debtorHistory: { ...history, averageDelayDays: 1020 },
      supplierHistory: null,
    });
    expect(message).not.toContain("1020");
    expect(message).not.toContain("retraso medio");
  });

  it("renders calendar dates on the day the site shows, not the day before", () => {
    // A date with no time of day used to be read as midnight UTC and printed
    // in Lima (UTC-5), moving every date back one day.
    const message = formatOpportunityAlert(
      { ...opportunity, closesAt: "2026-11-01", dueAt: "2026-11-01" },
      evaluation,
      portfolio,
      new Date("2026-09-03T12:00:00.000Z"),
    );
    expect(message).toContain("pago 01 nov 2026");
    expect(message).not.toContain("31 oct");
  });

  it("names a protected auction instead of inventing a letter grade", () => {
    expect(format({ risk: "PROTEGIDA" })).toContain("Protegida 🛡");
  });

  it("omits the monthly return when the panel does not publish one", () => {
    const message = format({ monthlyReturnPct: null });
    expect(message).toContain("20.00% anual");
    expect(message).not.toContain("mensual");
  });

  it("summarises each history in one line and drops empty decimals", () => {
    expect(format()).toContain(
      "Deudor 12 subastas · 11 a tiempo · 1 con retraso · mora 0% · retraso medio 2 d · S/25k histórico",
    );
  });

  it("omits a history that the tabs never delivered", () => {
    const message = format({ debtorHistory: null, supplierHistory: null });
    expect(message).not.toContain("Deudor ");
    expect(message).not.toContain("Proveedor ");
  });

  it("surfaces evaluation warnings", () => {
    expect(format()).toContain("⚠️ Concentración resultante elevada");
  });

  it("uses a distinct heading per decision", () => {
    expect(format({}, { decision: "REVIEW" })).toContain("🟡 REVISAR");
    expect(format({}, { decision: "DO_NOT_INVEST" })).toContain(
      "⛔ NO INVERTIR",
    );
    expect(format({}, { decision: "IGNORE" })).toContain("ℹ️ REGISTRADA");
  });

  it("escapes HTML in every value that comes from the page", () => {
    const message = format({
      commercialName: "Pagador > Proveedor & Co. <script>",
      investmentType: "Factoring" as Opportunity["investmentType"],
    });
    expect(message).toContain("&lt;script&gt;");
    expect(message).toContain("&amp;");
    expect(message).not.toMatch(/<script>/u);
  });

  it("redacts a tax id that leaked into a company name", () => {
    expect(format({ commercialName: "ACME 20123456789" })).not.toContain(
      "20123456789",
    );
  });

  it("never renders a URL, however hostile the stored one is", () => {
    for (const url of [
      "javascript:alert(1)",
      "https://evil.example/app/inversionista/oportunidades",
      "https://www.prestamype.com/app/inversionista/oportunidades",
    ]) {
      const message = format({ url });
      expect(message).not.toContain("<a href");
      expect(message).not.toContain("evil.example");
      expect(message).not.toContain("javascript:");
    }
  });

  it("stays within Telegram's limit when every field is oversized", () => {
    const huge = "M".repeat(5_000);
    const message = format(
      { commercialName: huge },
      { warnings: Array.from({ length: 40 }, (_, i) => `${huge}${i}`) },
    );
    expect(message.length).toBeLessThan(4_000);
    // Never cut through a tag or an entity.
    expect(message.match(/</gu)?.length).toBe(message.match(/>/gu)?.length);
    expect(message).not.toMatch(/&[a-z]*$/u);
  });

  it("keeps the heading even when everything else must be dropped", () => {
    const message = format(
      {},
      { warnings: Array.from({ length: 200 }, () => "x".repeat(500)) },
    );
    expect(message).toContain("INVERTIR");
    expect(message.length).toBeLessThan(4_000);
  });
});

describe("formatTechnicalAlert", () => {
  const cases: readonly [TechnicalAlertEvent["type"], string][] = [
    ["SESSION_EXPIRED", "SESIÓN VENCIDA"],
    ["CAPTCHA", "CAPTCHA DETECTADO"],
    ["RATE_LIMIT", "LÍMITE DE SOLICITUDES"],
    ["DOM_CHANGED", "CAMBIO DE ESTRUCTURA"],
    ["COST_PAUSE", "PAUSA POR COSTO"],
    ["RECOVERED", "SERVICIO RECUPERADO"],
  ];

  it.each(cases)("formats %s as a distinct technical alert", (type, title) => {
    const event: TechnicalAlertEvent = {
      type,
      detectedAt: "2026-08-27T15:30:00.000Z",
      safeDetail: "Detalle <verificado> & sin secretos",
    };
    const message = formatTechnicalAlert(event);

    expect(message).toContain(title);
    expect(message).toContain("Detalle &lt;verificado&gt; &amp; sin secretos");
    expect(message).toContain("27/08/2026, 10:30");
    expect(message.length).toBeLessThan(4000);
  });

  it("never serializes unknown exception or header objects", () => {
    const message = formatTechnicalAlert({
      type: "RATE_LIMIT",
      detectedAt: "2026-08-27T15:30:00.000Z",
      safeDetail: "Pausa controlada",
      error: { message: "secret-error" },
      headers: { authorization: "Bearer secret-token" },
    } as TechnicalAlertEvent);

    expect(message).toContain("Pausa controlada");
    expect(message).not.toMatch(/secret-error|authorization|secret-token/i);
  });

  it("redacts sensitive canaries from the explicitly safe detail", () => {
    const message = formatTechnicalAlert({
      type: "DOM_CHANGED",
      safeDetail:
        "RUC 20123456789 Authorization: Bearer very-secret cookie=session-value token=token-value",
    });
    expect(message).not.toMatch(
      /20123456789|very-secret|session-value|token-value/i,
    );
    expect(message).toContain("[REDACTADO]");
  });

  it("redacts the complete remainder of every line after a sensitive label", () => {
    const message = formatTechnicalAlert({
      type: "DOM_CHANGED",
      safeDetail:
        "Línea segura\nCookie: session=FIRST; csrf=SECONDSECRET Authorization: Bearer TOPSECRET\nOtra línea segura\ntoken=THIRD api-key=FOURTH",
    });
    expect(message).toContain("Línea segura");
    expect(message).toContain("Otra línea segura");
    expect(message).not.toMatch(/FIRST|SECONDSECRET|TOPSECRET|THIRD|FOURTH/);
    expect(message).toContain("Cookie: [REDACTADO]");
    expect(message).toContain("token=[REDACTADO]");
  });
});
