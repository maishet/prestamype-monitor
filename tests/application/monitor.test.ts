import { describe, expect, it, vi } from "vitest";

import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import type {
  Evaluation,
  Opportunity,
  PortfolioSnapshot,
} from "../../src/domain/types.js";
import {
  materialAlertKeys,
  runMonitor,
} from "../../src/application/monitor.js";
import { PageStructureError } from "../../src/browser/errors.js";
import type {
  MonitorRepository,
  OpportunitySource,
} from "../../src/application/ports.js";

const opportunity: Opportunity = {
  id: "opp-1",
  auctionCode: "M5dGmP0G",
  commercialName: "CLIENTE",
  investmentType: "Factoring",
  url: "https://prestamype.com/oportunidad/opp-1",
  supplier: { legalName: "Proveedor SAC", taxId: "201" },
  debtor: { legalName: "Pagador SAC", taxId: "202" },
  risk: "A+",
  currency: "PEN",
  annualReturnPct: 20,
  monthlyReturnPct: 1.5,
  totalAmountCents: 100_000,
  fundedAmountCents: 10_000,
  remainingAmountCents: 90_000,
  closesAt: "2026-08-28T00:00:00.000Z",
  dueAt: "2026-10-28T00:00:00.000Z",
  debtorHistory: null,
  supplierHistory: null,
  collectionProblem: false,
};

const portfolio: PortfolioSnapshot = {
  availableBalanceCents: 100_000,
  activeTotalCents: 0,
  exposureByParty: {},
};

function setup(
  options: {
    lock?: boolean;
    claim?: boolean;
    evaluation?: Evaluation;
  } = {},
) {
  const events: string[] = [];
  const evaluation = options.evaluation ?? {
    decision: "INVEST",
    score: 90,
    components: {},
    reasons: ["good"],
    warnings: [],
  };
  const source: OpportunitySource = {
    beginScan: vi.fn(() => {
      events.push("begin-scan");
    }),
    getPortfolio: vi.fn(async () => {
      events.push("portfolio");
      return portfolio;
    }),
    listEligibleOpportunities: vi.fn(async () => {
      events.push("candidates");
      return [opportunity];
    }),
    close: vi.fn(async () => {
      events.push("close");
    }),
  };
  const repository: MonitorRepository = {
    acquireLock: vi.fn(async () => {
      events.push("acquire");
      return options.lock ?? true;
    }),
    releaseLock: vi.fn(async () => {
      events.push("release");
    }),
    getBlacklist: vi.fn(async () => {
      events.push("blacklist");
      return [];
    }),
    getOpportunityFingerprints: vi.fn(async () => {
      events.push("fingerprints");
      return {};
    }),
    addBlacklistEntries: vi.fn(async () => {
      events.push("add-blacklist");
    }),
    saveOpportunity: vi.fn(async () => {
      events.push("save");
    }),
    claimAlert: vi.fn(async () => {
      events.push("claim");
      return options.claim ?? true;
    }),
    completeAlert: vi.fn(async () => {
      events.push("complete");
    }),
    releaseAlertClaim: vi.fn(async () => {
      events.push("release-claim");
    }),
  };
  const notifier = {
    send: vi.fn(async () => {
      events.push("send");
    }),
  };
  const createSource = vi.fn(async () => {
    events.push("source");
    return source;
  });
  const evaluate = vi.fn(() => {
    events.push("evaluate");
    return evaluation;
  });
  const formatAlert = vi.fn(
    (...args: [Opportunity, Evaluation, PortfolioSnapshot, Date]) => {
      void args;
      return "alert";
    },
  );
  const dependencies = {
    repository,
    notifier,
    createSource,
    config: DEFAULT_CONFIG,
    clock: () => new Date("2026-08-27T12:00:00.000Z"),
    evaluate,
    formatAlert,
  };
  return { events, source, repository, notifier, createSource, dependencies };
}

describe("runMonitor", () => {
  it("changes the alert key for hidden detail and evaluation changes", () => {
    const evaluation: Evaluation = {
      decision: "INVEST",
      score: 90,
      components: { risk: 10 },
      reasons: [],
      warnings: [],
    };
    const base = materialAlertKeys(opportunity, evaluation)[0];
    for (const changed of [
      { ...opportunity, closesAt: "2026-08-29T00:00:00.000Z" },
      { ...opportunity, collectionProblem: true },
      {
        ...opportunity,
        debtorHistory: {
          totalAuctions: 1,
          paidOnTime: 1,
          paidLate: 0,
          currentOnTime: 0,
          overdue: 0,
          averageDelayDays: 0,
          delinquencyPct: 0,
          historicalAmountCents: 100,
        },
      },
    ]) {
      expect(materialAlertKeys(changed, evaluation)[0]).not.toBe(base);
    }
    expect(
      materialAlertKeys(opportunity, { ...evaluation, score: 91 })[0],
    ).not.toBe(base);
  });
  it("orchestrates a claimed alert in strict order", async () => {
    const context = setup();
    const result = await runMonitor(context.dependencies, {
      owner: "run-1",
      lockTtlSeconds: 60,
      alertLeaseSeconds: 30,
    });

    expect(result).toEqual({ acquired: true, evaluated: 1, alertsSent: 1 });
    expect(context.events).toEqual([
      "acquire",
      "blacklist",
      "fingerprints",
      "source",
      "begin-scan",
      "portfolio",
      "candidates",
      "evaluate",
      "claim",
      "send",
      "complete",
      "save",
      "close",
      "release",
    ]);
    expect(context.dependencies.formatAlert).toHaveBeenCalledWith(
      opportunity,
      expect.any(Object),
      portfolio,
      new Date("2026-08-27T12:00:00.000Z"),
    );
  });

  it("does not create or release anything when the lock is unavailable", async () => {
    const context = setup({ lock: false });
    await expect(
      runMonitor(context.dependencies, {
        owner: "run-1",
        lockTtlSeconds: 60,
        alertLeaseSeconds: 30,
      }),
    ).resolves.toEqual({ acquired: false, evaluated: 0, alertsSent: 0 });
    expect(context.events).toEqual(["acquire"]);
    expect(context.createSource).not.toHaveBeenCalled();
  });

  it("saves but does not send when an alert claim is duplicate", async () => {
    const context = setup({ claim: false });
    const result = await runMonitor(context.dependencies, {
      owner: "run-1",
      lockTtlSeconds: 60,
      alertLeaseSeconds: 30,
    });
    expect(result.alertsSent).toBe(0);
    expect(context.events).not.toContain("send");
    expect(context.events).toContain("save");
  });

  it("uses a new material key when a recommendation material changes", async () => {
    const first = setup();
    await runMonitor(first.dependencies, {
      owner: "run",
      lockTtlSeconds: 60,
      alertLeaseSeconds: 30,
    });
    const second = setup();
    const changed = { ...opportunity, remainingAmountCents: 80_000 };
    vi.mocked(second.source.listEligibleOpportunities).mockResolvedValue([
      changed,
    ]);
    await runMonitor(second.dependencies, {
      owner: "run",
      lockTtlSeconds: 60,
      alertLeaseSeconds: 30,
    });
    expect(vi.mocked(first.repository.claimAlert).mock.calls[0]?.[0]).not.toBe(
      vi.mocked(second.repository.claimAlert).mock.calls[0]?.[0],
    );
  });

  it("alerts only when an individual normalized DO_NOT_INVEST conflict is new", async () => {
    const denied: Evaluation = {
      decision: "DO_NOT_INVEST",
      score: 0,
      components: {},
      reasons: [],
      warnings: ["  BlackList   MATCH  ", "Cobranza problemática"],
    };
    const context = setup({ evaluation: denied });
    const completed = new Set<string>();
    vi.mocked(context.repository.claimAlert).mockImplementation(async (key) => {
      context.events.push("claim");
      return !completed.has(key);
    });
    vi.mocked(context.repository.completeAlert).mockImplementation(
      async (key) => {
        context.events.push("complete");
        completed.add(key);
      },
    );
    await runMonitor(context.dependencies, {
      owner: "run",
      lockTtlSeconds: 60,
      alertLeaseSeconds: 30,
    });
    expect(context.repository.claimAlert).toHaveBeenCalledTimes(2);
    expect(context.notifier.send).toHaveBeenCalledOnce();

    vi.mocked(context.dependencies.evaluate).mockReturnValue({
      ...denied,
      warnings: ["blacklist match"],
    });
    await runMonitor(context.dependencies, {
      owner: "run",
      lockTtlSeconds: 60,
      alertLeaseSeconds: 30,
    });
    expect(context.notifier.send).toHaveBeenCalledOnce();

    vi.mocked(context.dependencies.evaluate).mockReturnValue({
      ...denied,
      warnings: ["blacklist match", "Nuevo conflicto"],
    });
    await runMonitor(context.dependencies, {
      owner: "run",
      lockTtlSeconds: 60,
      alertLeaseSeconds: 30,
    });
    expect(context.notifier.send).toHaveBeenCalledTimes(2);
  });

  it("releases every newly claimed conflict when formatting fails", async () => {
    const context = setup({
      evaluation: {
        decision: "DO_NOT_INVEST",
        score: 0,
        components: {},
        reasons: [],
        warnings: ["blacklist", "collection"],
      },
    });
    vi.mocked(context.dependencies.formatAlert).mockImplementation(() => {
      throw new Error("format failed");
    });
    await expect(
      runMonitor(context.dependencies, {
        owner: "run",
        lockTtlSeconds: 60,
        alertLeaseSeconds: 30,
      }),
    ).rejects.toThrow("format failed");
    expect(context.repository.releaseAlertClaim).toHaveBeenCalledTimes(2);
    expect(context.notifier.send).not.toHaveBeenCalled();
  });

  it("releases the claim when notification fails so a retry can claim", async () => {
    const context = setup();
    vi.mocked(context.notifier.send).mockRejectedValue(
      new Error("telegram down"),
    );
    await expect(
      runMonitor(context.dependencies, {
        owner: "run",
        lockTtlSeconds: 60,
        alertLeaseSeconds: 30,
      }),
    ).rejects.toThrow("telegram down");
    expect(context.events).toContain("release-claim");
    expect(context.repository.saveOpportunity).not.toHaveBeenCalled();
    expect(context.events.slice(-2)).toEqual(["close", "release"]);
  });

  it("retries on a later run after a pre-delivery failure without a saved fingerprint", async () => {
    const context = setup();
    vi.mocked(context.notifier.send)
      .mockRejectedValueOnce(new Error("telegram down"))
      .mockResolvedValueOnce(undefined);
    const input = { owner: "run", lockTtlSeconds: 60, alertLeaseSeconds: 30 };
    await expect(runMonitor(context.dependencies, input)).rejects.toThrow(
      "telegram down",
    );
    expect(context.repository.saveOpportunity).not.toHaveBeenCalled();
    await expect(
      runMonitor(context.dependencies, input),
    ).resolves.toMatchObject({
      alertsSent: 1,
    });
    expect(context.notifier.send).toHaveBeenCalledTimes(2);
    expect(context.repository.saveOpportunity).toHaveBeenCalledOnce();
  });

  it("does not release an ambiguous claim when completion fails after send", async () => {
    const context = setup({
      evaluation: {
        decision: "DO_NOT_INVEST",
        score: 0,
        components: {},
        reasons: [],
        warnings: ["blacklist", "collection"],
      },
    });
    vi.mocked(context.repository.completeAlert).mockRejectedValueOnce(
      new Error("complete failed"),
    );
    await expect(
      runMonitor(context.dependencies, {
        owner: "run",
        lockTtlSeconds: 60,
        alertLeaseSeconds: 30,
      }),
    ).rejects.toThrow("complete failed");
    expect(context.notifier.send).toHaveBeenCalledOnce();
    expect(context.repository.completeAlert).toHaveBeenCalledTimes(2);
    expect(context.repository.releaseAlertClaim).not.toHaveBeenCalled();
  });

  it("saves IGNORE evaluations without claiming or sending", async () => {
    const context = setup({
      evaluation: {
        decision: "IGNORE",
        score: 1,
        components: {},
        reasons: [],
        warnings: [],
      },
    });
    const result = await runMonitor(context.dependencies, {
      owner: "run",
      lockTtlSeconds: 60,
      alertLeaseSeconds: 30,
    });
    expect(result).toEqual({ acquired: true, evaluated: 1, alertsSent: 0 });
    expect(context.repository.claimAlert).not.toHaveBeenCalled();
  });

  it("adds every party under collection from the portfolio before evaluation", async () => {
    const context = setup();
    const conflictPortfolio: PortfolioSnapshot = {
      ...portfolio,
      collectionConflicts: [
        {
          party: { legalName: "Proveedor SAC", taxId: "201" },
          state: "Por cobrar",
          stage: "Cobranza administrativa I",
        },
        {
          party: { legalName: "Pagador SAC", taxId: "202" },
          state: "Por cobrar",
          stage: "Cobranza administrativa I",
        },
      ],
    };
    vi.mocked(context.source.getPortfolio).mockResolvedValue(conflictPortfolio);
    await runMonitor(context.dependencies, {
      owner: "run",
      lockTtlSeconds: 60,
      alertLeaseSeconds: 30,
    });
    expect(context.repository.addBlacklistEntries).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          taxId: "201",
          source: "portfolio-collection",
        }),
        expect.objectContaining({
          taxId: "202",
          source: "portfolio-collection",
        }),
      ]),
    );
    expect(context.events.indexOf("add-blacklist")).toBeLessThan(
      context.events.indexOf("candidates"),
    );
    expect(context.dependencies.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        blacklistEntries: expect.arrayContaining([
          expect.objectContaining({ taxId: "201" }),
          expect.objectContaining({ taxId: "202" }),
        ]),
      }),
    );
  });

  it("enriches a name-only blacklist match with discovered RUC and stays idempotent", async () => {
    const context = setup();
    const existing = {
      taxId: null,
      normalizedName: "PROVEEDOR SAC",
      reason: "Entrada manual",
      source: "manual",
      createdAt: "2026-08-01T00:00:00.000Z",
    };
    const conflictPortfolio: PortfolioSnapshot = {
      ...portfolio,
      collectionConflicts: [
        {
          party: { legalName: "Proveedor S.A.C.", taxId: "20123456789" },
          state: "Por cobrar",
          stage: "Cobranza legal",
        },
        {
          party: { legalName: "Pagador S.A.", taxId: "20987654321" },
          state: "Por cobrar",
          stage: "Cobranza legal",
        },
      ],
    };
    vi.mocked(context.source.getPortfolio).mockResolvedValue(conflictPortfolio);
    vi.mocked(context.repository.getBlacklist).mockResolvedValue([existing]);
    await runMonitor(context.dependencies, {
      owner: "run",
      lockTtlSeconds: 60,
      alertLeaseSeconds: 30,
    });
    const added = vi.mocked(context.repository.addBlacklistEntries).mock
      .calls[0]?.[0];
    expect(added).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          taxId: "20123456789",
          normalizedName: "PROVEEDOR SAC",
          source: "portfolio-collection",
          evidence: "Cobranza legal",
          createdAt: "2026-08-27T12:00:00.000Z",
        }),
        expect.objectContaining({ taxId: "20987654321" }),
      ]),
    );

    vi.mocked(context.repository.getBlacklist).mockResolvedValue([
      existing,
      ...(added ?? []),
    ]);
    await runMonitor(context.dependencies, {
      owner: "run-2",
      lockTtlSeconds: 60,
      alertLeaseSeconds: 30,
    });
    expect(context.repository.addBlacklistEntries).toHaveBeenCalledTimes(1);
  });

  it("closes and releases on browser/parser and repository failures", async () => {
    for (const failure of ["browser", "repository"] as const) {
      const context = setup();
      if (failure === "browser") {
        vi.mocked(context.source.listEligibleOpportunities).mockRejectedValue(
          new Error(failure),
        );
      } else {
        vi.mocked(context.repository.saveOpportunity).mockRejectedValue(
          new Error(failure),
        );
      }
      await expect(
        runMonitor(context.dependencies, {
          owner: "run",
          lockTtlSeconds: 60,
          alertLeaseSeconds: 30,
        }),
      ).rejects.toThrow(failure);
      expect(context.events.slice(-2)).toEqual(["close", "release"]);
      if (failure === "browser")
        expect(context.notifier.send).not.toHaveBeenCalled();
    }
  });

  it("preserves a primary AggregateError object and appends cleanup errors", async () => {
    const context = setup();
    const primary = new AggregateError([new Error("inner")], "primary");
    vi.mocked(context.source.listEligibleOpportunities).mockRejectedValue(
      primary,
    );
    vi.mocked(context.source.close).mockImplementation(async () => {
      context.events.push("close");
      throw new Error("close failed");
    });
    vi.mocked(context.repository.releaseLock).mockImplementation(async () => {
      context.events.push("release");
      throw new Error("release failed");
    });
    const caught = await runMonitor(context.dependencies, {
      owner: "run",
      lockTtlSeconds: 60,
      alertLeaseSeconds: 30,
    }).catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors[0]).toBe(primary);
    expect((caught as AggregateError).errors.slice(1).map(String)).toEqual([
      "Error: close failed",
      "Error: release failed",
    ]);
    expect((caught as AggregateError).cause).toBe(primary);
    expect(context.events.slice(-2)).toEqual(["close", "release"]);
  });

  it("evaluates all candidates before persistence and sends none on PageStructureError", async () => {
    const context = setup();
    vi.mocked(context.source.listEligibleOpportunities).mockResolvedValue([
      opportunity,
      { ...opportunity, id: "opp-2" },
    ]);
    vi.mocked(context.dependencies.evaluate)
      .mockReturnValueOnce({
        decision: "INVEST",
        score: 90,
        components: {},
        reasons: [],
        warnings: [],
      })
      .mockImplementationOnce(() => {
        throw new PageStructureError("MISSING_FIELD", "candidate-2");
      });
    await expect(
      runMonitor(context.dependencies, {
        owner: "run",
        lockTtlSeconds: 60,
        alertLeaseSeconds: 30,
      }),
    ).rejects.toBeInstanceOf(PageStructureError);
    expect(context.notifier.send).not.toHaveBeenCalled();
    expect(context.repository.saveOpportunity).not.toHaveBeenCalled();
  });

  it("reads the clock for each claim and uses that alert's detectedAt", async () => {
    const context = setup();
    vi.mocked(context.source.listEligibleOpportunities).mockResolvedValue([
      opportunity,
      { ...opportunity, id: "opp-2" },
    ]);
    const times = [
      new Date("2026-08-27T12:00:00.000Z"),
      new Date("2026-08-27T12:01:00.000Z"),
      new Date("2026-08-27T12:02:00.000Z"),
    ];
    context.dependencies.clock = vi.fn(() => times.shift() ?? new Date(0));
    await runMonitor(context.dependencies, {
      owner: "run",
      lockTtlSeconds: 60,
      alertLeaseSeconds: 30,
    });
    expect(
      vi
        .mocked(context.repository.claimAlert)
        .mock.calls.map((call) => call[2]),
    ).toEqual([1_787_832_090, 1_787_832_150]);
    expect(
      vi
        .mocked(context.dependencies.formatAlert)
        .mock.calls.map((call) => call[3]),
    ).toEqual([
      new Date("2026-08-27T12:01:00.000Z"),
      new Date("2026-08-27T12:02:00.000Z"),
    ]);
  });

  it("reads a fresh lease clock for every conflict claim", async () => {
    const context = setup({
      evaluation: {
        decision: "DO_NOT_INVEST",
        score: 0,
        components: {},
        reasons: [],
        warnings: ["blacklist", "collection"],
      },
    });
    const times = [
      new Date("2026-08-27T12:00:00.000Z"),
      new Date("2026-08-27T12:01:00.000Z"),
      new Date("2026-08-27T12:02:00.000Z"),
    ];
    context.dependencies.clock = vi.fn(() => times.shift() ?? new Date(0));
    await runMonitor(context.dependencies, {
      owner: "run",
      lockTtlSeconds: 60,
      alertLeaseSeconds: 30,
    });
    expect(
      vi
        .mocked(context.repository.claimAlert)
        .mock.calls.map((call) => call[2]),
    ).toEqual([1_787_832_090, 1_787_832_150]);
    expect(context.dependencies.formatAlert).toHaveBeenCalledWith(
      opportunity,
      expect.any(Object),
      portfolio,
      new Date("2026-08-27T12:01:00.000Z"),
    );
  });
});
