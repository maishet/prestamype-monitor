import { describe, expect, it, vi } from "vitest";
import {
  createCommandHandler,
  formatOpportunityAnalysis,
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
  it("allows public queries in approved chats", async () => {
    const { deps, call } = setup();
    await call("/oportunidades");
    expect(deps.execute).toHaveBeenCalledWith("oportunidades", "", false);
  });
  it.each(["analizar", "estado", "escanear", "pausar", "reanudar", "recuperar", "sesionestado"])(
    "denies private command %s to group members",
    async (command) => {
      const { deps, call } = setup();
      await call(`/${command}`);
      expect(deps.execute).not.toHaveBeenCalled();
    },
  );
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
    const text = formatOpportunityAnalysis({
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
    }, {
      allowedCurrencies: ["PEN", "USD"],
      allowedRisks: ["A+", "A", "B", "C"],
      minimumAnnualReturnPct: 13,
      minimumInvestmentCents: 10_000,
      reviewScore: 65,
      highPriorityScore: 80,
    });
    expect(text).toContain("Código: nvhp7jO8");
    expect(text).toContain("4.4 puntos por debajo");
    expect(text).toContain("Historial del proveedor: 2.33");
    expect(text).toContain("Moneda USD permitida");
    expect(text).toContain("Alertada: no");
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
