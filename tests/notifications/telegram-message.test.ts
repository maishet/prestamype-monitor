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
  url: "https://www.prestamype.com/app/inversionista/oportunidades/opp-42",
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
  it("formats a high-priority recommendation with the required context in Lima time", () => {
    const message = formatOpportunityAlert(
      opportunity,
      evaluation,
      portfolio,
      new Date("2026-08-27T15:30:00.000Z"),
    );

    expect(message).toContain("🔴 OPORTUNIDAD ALTA");
    expect(message).toContain("Decisión: <b>INVERTIR</b>");
    expect(message).toContain("Empresa: Proveedor Andino S.A.C.");
    expect(message).toContain("Pagador: Pagador Nacional S.A.");
    expect(message).toContain("Riesgo: A");
    expect(message).toContain("Retorno anual: 20.00%");
    expect(message).toContain("Score: 91.4/100");
    expect(message).toContain("Restante: S/3,750.00");
    expect(message).toContain("Buen historial del pagador");
    expect(message).toContain("Concentración resultante elevada");
    expect(message).toContain("27/08/2026, 10:30");
    expect(message).toContain(
      '<a href="https://www.prestamype.com/app/inversionista/oportunidades/opp-42">Abrir oportunidad</a>',
    );
    expect(message).toContain("Concentración resultante:");
    expect(message).toContain("Monto posible: S/2,500.00");
    expect(message).not.toMatch(
      /ejecutar la inversión|invertir automáticamente/i,
    );
  });

  it.each([
    ["INVEST", "🔴 OPORTUNIDAD ALTA", "INVERTIR"],
    ["REVIEW", "🟡 OPORTUNIDAD PARA REVISAR", "REVISAR"],
    ["DO_NOT_INVEST", "⛔ NO INVERTIR", "NO INVERTIR"],
  ] as const)("uses a clear title for %s", (decision, title, label) => {
    const message = formatOpportunityAlert(
      opportunity,
      { ...evaluation, decision },
      portfolio,
      new Date("2026-08-27T15:30:00.000Z"),
    );

    expect(message).toContain(title);
    expect(message).toContain(`Decisión: <b>${label}</b>`);
  });

  it("reports unavailable and zero balances without recommending execution", () => {
    const zero = formatOpportunityAlert(
      opportunity,
      evaluation,
      { ...portfolio, availableBalanceCents: 0 },
      new Date("2026-08-27T15:30:00.000Z"),
    );
    const unavailable = formatOpportunityAlert(
      opportunity,
      evaluation,
      { ...portfolio, availableBalanceCents: null },
      new Date("2026-08-27T15:30:00.000Z"),
    );

    expect(zero).toContain("Saldo disponible: S/0.00");
    expect(zero).toContain("Sin liquidez disponible; no ejecutar inversión");
    expect(unavailable).toContain("Saldo disponible: no disponible");
    expect(unavailable).not.toContain("Sin liquidez disponible");
  });

  it("uses the same possible amount for Telegram concentration as scoring", () => {
    const candidate = { ...opportunity, remainingAmountCents: 1_000_000 };
    const base = {
      ...portfolio,
      activeTotalCents: 100_000,
      exposureByParty: { "PAGADOR NACIONAL S A": 10_000 },
    };
    const zero = formatOpportunityAlert(
      candidate,
      evaluation,
      { ...base, availableBalanceCents: 0 },
      new Date("2026-08-27T15:30:00.000Z"),
    );
    const hundred = formatOpportunityAlert(
      candidate,
      evaluation,
      { ...base, availableBalanceCents: 10_000 },
      new Date("2026-08-27T15:30:00.000Z"),
    );
    expect(zero).toContain("Monto posible: S/0.00");
    expect(zero).toContain("Concentración resultante: 10.0%");
    expect(hundred).toContain("Monto posible: S/100.00");
    expect(hundred).toContain("Concentración resultante: 18.2%");
  });

  it("escapes HTML text and safe link attributes, and rejects non-HTTPS URLs", () => {
    const hostile = {
      ...opportunity,
      supplier: { legalName: 'Proveedor <script>& "Uno"', taxId: null },
      debtor: { legalName: "Pagador > Proveedor & Co.", taxId: null },
      url: "https://www.prestamype.com/app/inversionista/oportunidades/opp-safe",
    };
    const safe = formatOpportunityAlert(
      hostile,
      {
        ...evaluation,
        reasons: ["Rentable <hoy> & mañana"],
        warnings: ['Revisar "riesgo" & plazo'],
      },
      portfolio,
      new Date("2026-08-27T15:30:00.000Z"),
    );
    const unsafe = formatOpportunityAlert(
      { ...hostile, url: 'javascript:alert("token")' },
      evaluation,
      portfolio,
      new Date("2026-08-27T15:30:00.000Z"),
    );

    expect(safe).toContain(
      "Empresa: Proveedor &lt;script&gt;&amp; &quot;Uno&quot;",
    );
    expect(safe).toContain("Rentable &lt;hoy&gt; &amp; mañana");
    expect(safe).toContain(
      'href="https://www.prestamype.com/app/inversionista/oportunidades/opp-safe"',
    );
    expect(safe).not.toContain("<script>");
    expect(unsafe).not.toContain("href=");
    expect(unsafe).toContain("Enlace: no disponible (URL inválida)");
    expect(unsafe).not.toContain("javascript:");
  });

  it("stays below 4000 characters without cutting tags or entities and keeps essentials", () => {
    const longText = "alerta <crítica> & segura ".repeat(600);
    const message = formatOpportunityAlert(
      {
        ...opportunity,
        supplier: { ...opportunity.supplier, legalName: longText },
      },
      {
        ...evaluation,
        reasons: [
          `REASON_ONE ${longText}`,
          `REASON_TWO ${longText}`,
          `REASON_THREE ${longText}`,
        ],
        warnings: [`WARN_REQUIRED ${longText}`],
        components: Object.fromEntries(
          Array.from({ length: 80 }, (_, index) => [`detalle-${index}`, 1]),
        ),
      },
      portfolio,
      new Date("2026-08-27T15:30:00.000Z"),
    );

    expect(message.length).toBeLessThan(4000);
    expect(message).toContain("🔴 OPORTUNIDAD ALTA");
    expect(message).toContain("Decisión: <b>INVERTIR</b>");
    expect(message).toContain("Empresa:");
    expect(message).toContain("Score: 91.4/100");
    expect(message).toContain("⚠️ Advertencias:");
    expect(message).toContain("WARN_REQUIRED");
    expect(message).toContain("Razones:");
    expect(message).toContain("REASON_ONE");
    expect(message).toContain("REASON_TWO");
    expect(message).toContain("REASON_THREE");
    expect(message).toContain("Abrir oportunidad");
    expect(message).not.toMatch(/<[^>]*$/);
    expect(message).not.toMatch(/&(?:#\d*|#x[\da-f]*|\w*)$/i);
  });

  it("bounds escaped output without throwing and degrades an oversized link safely", () => {
    const ampersands = "&".repeat(950);
    const oversizedUrl = `https://www.prestamype.com/app/inversionista/oportunidades/opp-42?a=${ampersands}`;

    expect(() =>
      formatOpportunityAlert(
        {
          ...opportunity,
          url: oversizedUrl,
          supplier: { ...opportunity.supplier, legalName: ampersands },
          debtor: { ...opportunity.debtor, legalName: ampersands },
        },
        {
          ...evaluation,
          reasons: [ampersands, ampersands, ampersands],
          warnings: [ampersands, ampersands],
        },
        portfolio,
        new Date("2026-08-27T15:30:00.000Z"),
      ),
    ).not.toThrow();

    const message = formatOpportunityAlert(
      { ...opportunity, url: oversizedUrl },
      evaluation,
      portfolio,
      new Date("2026-08-27T15:30:00.000Z"),
    );
    expect(message.length).toBeLessThan(4000);
    expect(message).not.toContain("href=");
    expect(message).toContain("Enlace: no disponible (URL inválida)");
    expect(message).not.toMatch(/<[^>]*$/);
    expect(message).not.toMatch(/&(?:#\d*|#x[\da-f]*|\w*)$/i);
  });

  it("keeps bounded representations of the first and last warning", () => {
    const warnings = Array.from(
      { length: 50 },
      (_, index) =>
        `${index === 0 ? "WARN_FIRST" : index === 49 ? "WARN_LAST" : `WARN_${index}`} ${"<&>".repeat(100)}`,
    );
    const message = formatOpportunityAlert(
      opportunity,
      { ...evaluation, warnings },
      portfolio,
      new Date("2026-08-27T15:30:00.000Z"),
    );

    expect(message.length).toBeLessThan(4000);
    expect(message).toContain("WARN_FIRST");
    expect(message).toContain("WARN_LAST");
    expect(message).toMatch(/advertencias omitidas/i);
  });

  it("rejects HTTPS links outside the exact canonical Prestamype host", () => {
    const message = formatOpportunityAlert(
      { ...opportunity, url: "https://evil.example/oportunidad/opp-42" },
      evaluation,
      portfolio,
      new Date("2026-08-27T15:30:00.000Z"),
    );

    expect(message).not.toContain("href=");
    expect(message).not.toContain("evil.example");
    expect(message).toContain("Enlace: no disponible (URL inválida)");
  });

  it("rejects arbitrary Prestamype subdomains", () => {
    const message = formatOpportunityAlert(
      {
        ...opportunity,
        url: "https://evil.prestamype.com/app/inversionista/oportunidades/opp-42",
      },
      evaluation,
      portfolio,
      new Date("2026-08-27T15:30:00.000Z"),
    );
    expect(message).not.toContain("href=");
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
