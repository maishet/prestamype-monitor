import { describe, expect, it, vi } from "vitest";
import {
  createCommandHandler,
  evaluationText,
  formatCriteria,
  formatHelp,
  formatMonitorStatus,
  formatOpportunityList,
  formatOpportunityAnalysis,
  formatSessionStatus,
  isOpportunityOpenInLima,
  type CommandDependencies,
} from "../../src/lambda/commands.js";

const setup = () => {
  const deps: CommandDependencies = {
    secret: async () => "test-secret",
    ownerId: "1524876607",
    botUsername: "cve_subastas_noti_bot",
    chats: async () => ["-100123"],
    claim: vi.fn(async () => true),
    execute: vi.fn(async () => "OK"),
  };
  const call = (
    text: string,
    id = 123,
    chat = -100123,
    type = "group",
    extra = {},
  ) =>
    createCommandHandler(deps)({
      requestContext: { http: { method: "POST" } },
      headers: { "x-telegram-bot-api-secret-token": "test-secret" },
      body: JSON.stringify({
        update_id: 1,
        message: {
          text,
          from: { id, is_bot: false },
          chat: { id: chat, type },
          ...extra,
        },
      }),
    });
  return { deps, call };
};

describe("Telegram commands authorization", () => {
  it("ignores commands addressed to a different bot", async () => {
    const { deps, call } = setup();
    await call("/ayuda@another_bot");
    expect(deps.execute).not.toHaveBeenCalled();
    await call("/detalle@cve_subastas_noti_bot abc");
    expect(deps.execute).toHaveBeenCalledWith("detalle", "abc", false);
  });
  it("logs only the error class name when a command fails", async () => {
    const { deps, call } = setup();
    vi.mocked(deps.execute).mockRejectedValueOnce(
      Object.assign(new Error("arn:aws:dynamodb:secret-detail"), {
        name: "ProvisionedThroughputExceededException",
      }),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const response = await call(
      "/analizar XGI0Hlf2",
      1524876607,
      1524876607,
      "private",
    );
    expect(response.body).toContain("No pude completar");
    expect(warn).toHaveBeenCalledWith(
      "Telegram command failed",
      JSON.stringify({
        command: "analizar",
        error: "ProvisionedThroughputExceededException",
      }),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret-detail");
    warn.mockRestore();
  });
  it("allows public queries in approved chats", async () => {
    const { deps, call } = setup();
    await call("/oportunidades");
    expect(deps.execute).toHaveBeenCalledWith("oportunidades", "", false);
  });
  it.each([
    "analizar",
    "estado",
    "escanear",
    "pausar",
    "reanudar",
    "recuperar",
    "sesionestado",
  ])("denies private command %s to group members", async (command) => {
    const { deps, call } = setup();
    await call(`/${command}`);
    expect(deps.execute).not.toHaveBeenCalled();
  });
  it("denies even the owner administrative commands in a group", async () => {
    const { deps, call } = setup();
    await call("/pausar", 1524876607);
    expect(deps.execute).not.toHaveBeenCalled();
  });
  it("allows the owner only in their private chat", async () => {
    const { deps, call } = setup();
    await call("/escanear", 1524876607, 1524876607, "private");
    expect(deps.execute).toHaveBeenCalledWith("escanear", "", true);
  });
  it("allows the owner to request a private analysis by auction code", async () => {
    const { deps, call } = setup();
    await call("/analizar nvhp7jO8", 1524876607, 1524876607, "private");
    expect(deps.execute).toHaveBeenCalledWith("analizar", "nvhp7jO8", true);
  });
  it("allows the owner recovery command only in their private chat", async () => {
    const { deps, call } = setup();
    await call("/recuperar", 1524876607, 1524876607, "private");
    expect(deps.execute).toHaveBeenCalledWith("recuperar", "", true);
  });
  it("allows the owner session status command only in their private chat", async () => {
    const { deps, call } = setup();
    await call("/sesionestado", 1524876607, 1524876607, "private");
    expect(deps.execute).toHaveBeenCalledWith("sesionestado", "", true);
  });
  it("rejects unknown chats and anonymous senders", async () => {
    const { deps, call } = setup();
    await call("/ayuda", 123, -999);
    await call("/ayuda", 1524876607, -100123, "group", {
      sender_chat: { id: -100123 },
    });
    expect(deps.execute).not.toHaveBeenCalled();
  });
  it("does not execute duplicated or throttled updates", async () => {
    const { deps, call } = setup();
    deps.claim = vi.fn(async () => false);
    await call("/escanear", 1524876607, 1524876607, "private");
    expect(deps.execute).not.toHaveBeenCalled();
  });
  it("rejects invalid webhook secrets before accessing storage", async () => {
    const { deps } = setup();
    const response = await createCommandHandler(deps)({
      requestContext: { http: { method: "POST" } },
      headers: {},
      body: "{}",
    });
    expect(response.statusCode).toBe(403);
    expect(deps.claim).not.toHaveBeenCalled();
    expect(deps.execute).not.toHaveBeenCalled();
  });
  it("does not offer financial actions", async () => {
    const { deps, call } = setup();
    const response = await call("/invertir", 1524876607, 1524876607, "private");
    expect(deps.execute).not.toHaveBeenCalled();
    expect(response.body).toContain("ayuda");
  });
});

describe("opportunity analysis", () => {
  it("explains a scored opportunity that missed the review threshold", () => {
    const text = formatOpportunityAnalysis(
      {
        opportunity: {
          id: "x",
          auctionCode: "nvhp7jO8",
          commercialName: "COMPAÑIA MINERA SOL DE LOS ANDES",
          currency: "USD",
          totalAmountCents: 11_287_864,
          fundedAmountCents: 11_076_257,
          remainingAmountCents: 211_607,
          annualReturnPct: 15.39,
          monthlyReturnPct: 1.2,
          risk: "C",
          investmentType: "Confirming",
          closesAt: "2026-09-14",
          dueAt: "2026-12-04",
          collectionProblem: false,
          debtor: { legalName: "DEUDOR", taxId: null },
          supplier: { legalName: "", taxId: null },
          debtorHistory: null,
          supplierHistory: null,
          url: "https://www.prestamype.com/app/inversionista/oportunidades",
        },
        evaluation: {
          decision: "IGNORE",
          score: 60.6,
          components: { return: 5.78, supplierHistory: 2.33 },
          reasons: [],
          warnings: [],
        },
        alerted: false,
      },
      {
        allowedCurrencies: ["PEN", "USD"],
        allowedRisks: ["A+", "A", "B", "C"],
        minimumAnnualReturnPct: 13,
        minimumInvestmentCents: 10_000,
        reviewScore: 65,
        highPriorityScore: 80,
      },
    );
    expect(text).toContain("Análisis de la subasta nvhp7jO8");
    expect(text).toContain("ℹ️ REGISTRADA · COMPAÑIA MINERA SOL DE LOS ANDES");
    expect(text).toContain("US$ 2,116.07 de US$ 112,878.64");
    expect(text).toContain(
      "Pasó los filtros, pero su score de 60.6 quedó 4.4 puntos por debajo del mínimo de 65",
    );
    expect(text).toContain("• Historial del proveedor: 2.3 / 20");
    expect(text).toContain("No se envió alerta · avisa desde 🟡 65 (REVISAR)");
    // Raw enum values and English evaluator text never reach the chat.
    expect(text).not.toContain("IGNORE");
  });

  it("explains in Spanish why a filtered opportunity got no score", () => {
    const text = formatOpportunityAnalysis(
      {
        opportunity: {
          id: "b".repeat(32),
          auctionCode: "XGI0Hlf2",
          commercialName: "EMPRESA",
          currency: "PEN",
          totalAmountCents: 23_147_537,
          fundedAmountCents: 22_561_076,
          remainingAmountCents: 586_461,
          annualReturnPct: 14.84,
          monthlyReturnPct: null,
          risk: "C",
          investmentType: "Factoring",
          closesAt: "2026-11-20",
          dueAt: null,
          collectionProblem: false,
          debtor: { legalName: "DEUDOR", taxId: null },
          supplier: { legalName: "", taxId: null },
          debtorHistory: null,
          supplierHistory: null,
          url: "https://www.prestamype.com/app/inversionista/oportunidades",
        },
        evaluation: {
          decision: "IGNORE",
          score: 0,
          components: {},
          reasons: ["Annual return is below 16%"],
          warnings: [],
        },
      },
      {
        allowedCurrencies: ["PEN", "USD"],
        allowedRisks: ["A+", "A", "B", "C"],
        minimumAnnualReturnPct: 16,
        minimumInvestmentCents: 10_000,
        reviewScore: 65,
        highPriorityScore: 80,
      },
      new Date("2026-11-16T17:00:00.000Z"),
    );
    expect(text).toContain("Sin score: no pasó los filtros obligatorios");
    expect(text).toContain("• Retorno anual menor al mínimo de 16%");
    expect(text).not.toContain("Annual return");
    expect(text).not.toContain("Desglose del score");
  });
});

describe("opportunity closing date", () => {
  it("keeps an opportunity visible through its closing day in Lima", () => {
    expect(
      isOpportunityOpenInLima(
        "2026-09-14",
        new Date("2026-09-15T04:59:59.000Z"),
      ),
    ).toBe(true);
  });

  it("expires it when the next calendar day begins in Lima", () => {
    expect(
      isOpportunityOpenInLima(
        "2026-09-14",
        new Date("2026-09-15T05:00:00.000Z"),
      ),
    ).toBe(false);
  });
});

describe("status commands", () => {
  const now = new Date("2026-10-15T23:30:00.000Z");
  const expired = {
    enabled: true,
    paused_until: "manual",
    pause_reason: "SessionExpiredError",
    last_scan_at: "2026-10-14T16:19:08.846Z",
    last_scan_summary: "9 evaluadas; 0 alertas enviadas",
    last_error: {
      class: "SessionExpiredError",
      message: "Login page detected",
      timestamp: "2026-10-14T16:21:00.000Z",
    },
    costLimits: { configuredMemoryGb: 1, monthlyGbSecondsLimit: 400_000 },
  };

  it("/estado shows the stored error and its pause in Lima time", () => {
    const text = formatMonitorStatus(expired, 242_343, now);
    expect(text).toContain("en pausa por sesión expirada");
    expect(text).toContain("Último escaneo: 14/10/2026 11:19 (hace 31 h)");
    expect(text).toContain("Último error: sesión expirada · 14/10/2026 11:21");
    // The class already reads "sesión expirada"; its raw English detail is noise.
    expect(text).not.toContain("Login page detected");
    expect(text).toContain("npm run auth:capture");
    expect(text).toContain("(61%)");
    expect(text).not.toContain("2026-10-14T");
  });

  it("/estado reports an active monitor without a stale pause", () => {
    const text = formatMonitorStatus(
      {
        enabled: true,
        paused_until: "2026-10-15T20:00:00.000Z",
        pause_reason: "RateLimitError",
        costLimits: { configuredMemoryGb: 1, monthlyGbSecondsLimit: 400_000 },
      },
      0,
      now,
    );
    expect(text).toContain("Monitor: ✅ activo");
    expect(text).not.toContain("Pausa:");
    expect(text).toContain("Último error: ninguno registrado");
  });

  it("/sesionestado says an expired session is expired, not available", () => {
    const text = formatSessionStatus(expired, true, now);
    expect(text).toContain(
      "❌ expirada: Prestamype la rechazó el 14/10/2026 11:21",
    );
    expect(text).toContain("Pausa activa: sesión expirada");
    expect(text).not.toContain("disponible");
  });

  it("/sesionestado confirms a healthy session", () => {
    const text = formatSessionStatus(
      { enabled: true, last_scan_at: "2026-10-15T23:28:00.000Z" },
      true,
      now,
    );
    expect(text).toContain("✅ guardada (cifrada)");
    expect(text).toContain("15/10/2026 18:28 (hace 2 min)");
    expect(text).toContain("No se detecta una pausa por sesión.");
  });
});

describe("public opportunity messages", () => {
  const now = new Date("2026-09-10T15:00:00.000Z");
  const item = {
    opportunity: {
      id: "a".repeat(32),
      auctionCode: "abc12345",
      commercialName: "MINERA SOL",
      currency: "PEN" as const,
      totalAmountCents: 10_000_000,
      fundedAmountCents: 2_500_000,
      remainingAmountCents: 7_500_000,
      annualReturnPct: 18.5,
      monthlyReturnPct: 1.43,
      risk: "B" as const,
      investmentType: "Confirming" as const,
      closesAt: "2026-09-12",
      dueAt: "2026-11-11",
      collectionProblem: false,
      debtor: { legalName: "DEUDOR", taxId: null },
      supplier: { legalName: "", taxId: null },
      debtorHistory: {
        totalAuctions: 20,
        paidOnTime: 18,
        paidLate: 2,
        currentOnTime: 0,
        overdue: 0,
        averageDelayDays: 3,
        delinquencyPct: 0,
        historicalAmountCents: 1,
      },
      supplierHistory: null,
      url: "https://www.prestamype.com/app/inversionista/oportunidades",
    },
    evaluation: {
      decision: "REVIEW" as const,
      score: 72.34,
      components: {},
      reasons: [],
      warnings: ["Supplier history is unavailable"],
    },
    detailCheckedAt: "2026-09-10T14:00:00.000Z",
  };

  it("explains what an opportunity pays, until when and why it ranks", () => {
    const text = formatOpportunityList([item], now);
    expect(text).toContain("1. 🟡 REVISAR · MINERA SOL");
    expect(text).toContain("18.50% anual (1.43% mensual) · Riesgo B");
    expect(text).toContain(
      "Disponible S/ 75,000.00 de S/ 100,000.00 (25% financiado)",
    );
    expect(text).toContain("Cierra en 2 días (12 sep 2026)");
    expect(text).toContain("plazo de 60 días");
    expect(text).toContain("Deudor: 18/20 pagadas a tiempo · 2 tarde");
    expect(text).toContain("Proveedor: sin historial disponible");
    expect(text).toContain("Sin historial del proveedor");
    expect(text).toContain("Score 72.3/100");
    expect(text).toContain(`/detalle ${item.opportunity.id}`);
  });

  it("says what to do when nothing is open and no alert is recorded", () => {
    const text = formatOpportunityList([], now);
    expect(text).toContain("/criterios");
    expect(text).toContain("Aún no tengo registro de una alerta reciente");
  });

  it("shows the last alerted opportunity when nothing is open", () => {
    const closed = {
      ...item,
      opportunity: { ...item.opportunity, closesAt: "2026-09-08" },
    };
    const text = formatOpportunityList([], now, closed);
    expect(text).toContain("Última oportunidad alertada (ya cerró):");
    expect(text).toContain("MINERA SOL");
    expect(text).toContain("Cerró el 08 sep 2026");
    expect(text).not.toContain("Cierra HOY");
  });

  it("describes filters, score factors and thresholds", () => {
    const text = formatCriteria({
      allowedCurrencies: ["PEN", "USD"],
      allowedRisks: ["A+", "A", "B"],
      minimumAnnualReturnPct: 13,
      minimumInvestmentCents: 10_000,
      reviewScore: 65,
      highPriorityScore: 80,
    });
    expect(text).toContain("soles (PEN) o dólares (USD)");
    expect(text).toContain("Retorno anual mínimo: 13%");
    expect(text).toContain("Historial del deudor: hasta 30");
    expect(text).toContain("REVISAR: score desde 65");
    expect(text).toContain("INVERTIR: score desde 80");
  });
  it("does not advertise a protected minimum the evaluator does not apply", () => {
    const text = formatCriteria({
      allowedCurrencies: ["PEN"],
      allowedRisks: ["A", "PROTEGIDA"],
      minimumAnnualReturnPct: 16,
      minimumProtectedAnnualReturnPct: 5,
      minimumInvestmentCents: 10_000,
      reviewScore: 65,
      highPriorityScore: 80,
    });
    expect(text).toContain("Retorno anual mínimo: 16%\n");
    expect(text).not.toContain("protegidas piden");
    expect(text).toContain("Riesgo: A, Protegida");
  });
});

describe("help and evaluator text", () => {
  it("describes every administrative command only to the admin", () => {
    const publicHelp = formatHelp(false);
    expect(publicHelp).toContain("/oportunidades — ");
    expect(publicHelp).not.toContain("/analizar");
    const adminHelp = formatHelp(true);
    for (const command of [
      "estado",
      "sesionestado",
      "analizar CODIGO",
      "escanear",
      "pausar",
      "reanudar",
      "recuperar",
      "actualizarportafolio",
    ])
      expect(adminHelp).toContain(`/${command} — `);
  });

  it("translates every English evaluator reason", () => {
    expect(evaluationText("Risk E is not allowed")).toBe(
      "Riesgo E fuera de los permitidos",
    );
    expect(evaluationText("Currency EUR is not allowed")).toBe(
      "Moneda EUR no permitida",
    );
    expect(evaluationText("Remaining amount is below 10000 cents")).toBe(
      "Monto disponible menor al mínimo de 100.00",
    );
    expect(evaluationText("Blacklist match for debtor: fraude")).toBe(
      "En lista negra (deudor): fraude",
    );
    expect(evaluationText("Debtor history is unavailable")).toBe(
      "Sin historial del deudor",
    );
    expect(evaluationText("Riesgo B permitido")).toBe("Riesgo B permitido");
  });
});

describe("status error details", () => {
  const now = new Date("2026-11-16T17:30:00.000Z");
  const base = {
    enabled: true,
    last_scan_summary: "7 evaluadas; 0 alertas enviadas",
    costLimits: { configuredMemoryGb: 2, monthlyGbSecondsLimit: 650_000 },
  };
  const timeout = {
    class: "RuntimeError",
    message:
      'page.goto: Timeout 12000ms exceeded. Call log: - navigating to "https://x", waiting until "load"',
    timestamp: "2026-11-16T17:19:00.000Z",
  };

  it("marks an error as resolved when a later scan finished", () => {
    const text = formatMonitorStatus(
      {
        ...base,
        last_error: timeout,
        last_scan_at: "2026-11-16T17:25:00.000Z",
      },
      409_115,
      now,
    );
    expect(text).toContain("ya resuelto: el escaneo siguiente terminó bien");
    expect(text).not.toContain("page.goto");
    expect(text).toContain("409,115 / 650,000 GB-s (63%)");
  });

  it("summarizes a current timeout instead of dumping the call log", () => {
    const text = formatMonitorStatus(
      {
        ...base,
        last_error: timeout,
        last_scan_at: "2026-11-16T17:10:00.000Z",
      },
      0,
      now,
    );
    expect(text).toContain(
      "Prestamype tardó demasiado en responder (tiempo de espera agotado).",
    );
    expect(text).not.toContain("Call log");
  });
});
