import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createScanHandler } from "../../src/lambda/handler.js";
import { captureSession } from "../../src/cli/capture-session.js";

const shells = ["pwsh", "powershell"].map(
  (name) =>
    execFileSync("where.exe", [name], { encoding: "utf8" })
      .trim()
      .split(/\r?\n/)[0]!,
);
const fixturePath = resolve("tests/operational");
const fullConfig = {
  PK: { S: "CONFIG" },
  SK: { S: "MONITOR" },
  enabled: { BOOL: false },
  monitor: {
    M: {
      allowedRisks: { L: [{ S: "A+" }] },
      minimumAnnualReturnPct: { N: "15" },
      currency: { S: "PEN" },
      minimumInvestmentCents: { N: "10000" },
      highPriorityScore: { N: "80" },
      reviewScore: { N: "70" },
      detailRefreshIntervalMs: { N: "900000" },
    },
  },
  costLimits: {
    M: {
      configuredMemoryGb: { N: "1" },
      monthlyGbSecondsLimit: { N: "400000" },
    },
  },
};

function run(shell: string, script: string, statePath: string, input?: string) {
  const scriptPath = resolve("scripts", script).replace(/'/g, "''");
  const arguments_ =
    script === "activate-monitor.ps1" || script === "resume-monitor.ps1"
      ? [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          `function global:Read-Host { '${script === "activate-monitor.ps1" ? "ACTIVAR" : "REANUDAR"}' }; & '${scriptPath}'`,
        ]
      : [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          scriptPath,
        ];
  return execFileSync(shell, arguments_, {
    encoding: "utf8",
    input,
    env: {
      ...process.env,
      PATH: `${fixturePath}${delimiter}${process.env.PATH}`,
      FAKE_AWS_STATE: statePath,
      REAL_NODE: process.execPath,
    },
    timeout: 15_000,
  });
}

function runResumeWithConfirmation(
  shell: string,
  statePath: string,
  confirmation: string,
) {
  const scriptPath = resolve("scripts/resume-monitor.ps1").replace(/'/g, "''");
  return execFileSync(
    shell,
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `function global:Read-Host { '${confirmation.replace(/'/g, "''")}' }; & '${scriptPath}'`,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fixturePath}${delimiter}${process.env.PATH}`,
        FAKE_AWS_STATE: statePath,
        REAL_NODE: process.execPath,
      },
      timeout: 15_000,
    },
  );
}

describe.each(shells)("stateful operational scripts in %s", (shell) => {
  it("bootstraps disabled config before streaming secrets and drains a flooding child", () => {
    const dir = mkdtempSync(`${tmpdir()}\\prestamype-ops-`);
    const statePath = `${dir}\\state.json`;
    const helperPath = `${dir}\\helper.json`;
    const testScript = `${dir}\\bootstrap-test.ps1`;
    const fakeHelper = resolve("tests/operational/fake-secure-child.mjs");
    const production = readFileSync(
      resolve("scripts/bootstrap-parameters.ps1"),
      "utf8",
    ).replace(
      'Join-Path $PSScriptRoot "put-secure-parameters.mjs"',
      `'${fakeHelper.replace(/'/g, "''")}'`,
    );
    writeFileSync(testScript, production, "utf8");
    const scriptPath = testScript.replace(/'/g, "''");
    const command = `function global:Read-Host { $s=New-Object Security.SecureString; ([Console]::In.ReadLine()).ToCharArray() | ForEach-Object { $s.AppendChar($_) }; $s.MakeReadOnly(); $s }; & '${scriptPath}'`;
    try {
      writeFileSync(
        statePath,
        JSON.stringify({
          config: null,
          messages: [],
          blacklist: {},
          calls: [],
        }),
      );
      execFileSync(
        shell,
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          command,
        ],
        {
          encoding: "utf8",
          input: "TOP-SECRET-TOKEN\nTOP-SECRET-CHAT\n",
          env: {
            ...process.env,
            PATH: `${fixturePath}${delimiter}${process.env.PATH}`,
            FAKE_AWS_STATE: statePath,
            FAKE_HELPER_INPUT: helperPath,
            REAL_NODE: process.execPath,
          },
          timeout: 15_000,
        },
      );
      const state = JSON.parse(readFileSync(statePath, "utf8"));
      const helper = JSON.parse(readFileSync(helperPath, "utf8"));
      expect(state.config.enabled).toEqual({ BOOL: false });
      expect(
        state.config.monitor.M.allowedRisks.L.map((x: { S: string }) => x.S),
      ).toEqual(["A+", "A", "B", "C"]);
      expect(state.config.costLimits.M.monthlyGbSecondsLimit).toEqual({
        N: "400000",
      });
      expect(helper.argv.join(" ")).not.toContain("TOP-SECRET");
      expect(helper.input).toContain("TOP-SECRET-TOKEN");
      expect(
        state.calls.flatMap((x: { args: string[] }) => x.args).join(" "),
      ).not.toContain("TOP-SECRET");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the monitor disabled when secure parameter loading fails", () => {
    const dir = mkdtempSync(`${tmpdir()}\\prestamype-ops-`);
    const statePath = `${dir}\\state.json`;
    const helperPath = `${dir}\\helper.json`;
    const testScript = `${dir}\\bootstrap-test.ps1`;
    const fakeHelper = resolve("tests/operational/fake-secure-child.mjs");
    writeFileSync(
      testScript,
      readFileSync(resolve("scripts/bootstrap-parameters.ps1"), "utf8").replace(
        'Join-Path $PSScriptRoot "put-secure-parameters.mjs"',
        `'${fakeHelper.replace(/'/g, "''")}'`,
      ),
      "utf8",
    );
    const command = `function global:Read-Host { $s=New-Object Security.SecureString; ([Console]::In.ReadLine()).ToCharArray() | ForEach-Object { $s.AppendChar($_) }; $s }; & '${testScript.replace(/'/g, "''")}'`;
    try {
      const active = structuredClone(fullConfig);
      active.enabled = { BOOL: true };
      writeFileSync(
        statePath,
        JSON.stringify({
          config: active,
          messages: [],
          blacklist: {},
          calls: [],
        }),
      );
      let failure = "";
      try {
        execFileSync(
          shell,
          [
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            command,
          ],
          {
            encoding: "utf8",
            input: "TOP-SECRET-TOKEN\nTOP-SECRET-CHAT\n",
            env: {
              ...process.env,
              PATH: `${fixturePath}${delimiter}${process.env.PATH}`,
              FAKE_AWS_STATE: statePath,
              FAKE_HELPER_INPUT: helperPath,
              FAKE_HELPER_EXIT: "7",
              REAL_NODE: process.execPath,
            },
            timeout: 15_000,
          },
        );
      } catch (error) {
        failure = String(error);
      }
      const state = JSON.parse(readFileSync(statePath, "utf8"));
      expect(state.config.enabled).toEqual({ BOOL: false });
      expect(failure).toContain("parametros seguros");
      expect(failure).not.toContain("TOP-SECRET");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("seeds idempotently and invokes the exact body without touching config", () => {
    const dir = mkdtempSync(`${tmpdir()}\\prestamype-ops-`);
    const statePath = `${dir}\\state.json`;
    try {
      writeFileSync(
        statePath,
        JSON.stringify({
          config: fullConfig,
          messages: [],
          blacklist: {},
          calls: [],
        }),
      );
      run(shell, "seed-blacklist.ps1", statePath);
      run(shell, "seed-blacklist.ps1", statePath);
      run(shell, "invoke-once.ps1", statePath);
      const state = JSON.parse(readFileSync(statePath, "utf8"));
      expect(Object.keys(state.blacklist).sort()).toEqual([
        "NAME#CORPORACION LERIBE SAC",
        "RUC#20517854523",
      ]);
      expect(state.messages).toEqual([
        {
          QueueUrl: "https://sqs.sa-east-1.amazonaws.com/123456789012/scan",
          MessageBody: '{"kind":"scan-once","schemaVersion":1}',
        },
      ]);
      expect(state.config).toEqual(fullConfig);
      for (const call of state.calls)
        if (call.inputPath)
          expect(() => readFileSync(call.inputPath)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("activates once, no-ops when already enabled, and deactivates preserving config", () => {
    const dir = mkdtempSync(`${tmpdir()}\\prestamype-ops-`);
    const statePath = `${dir}\\state.json`;
    try {
      writeFileSync(
        statePath,
        JSON.stringify({
          config: structuredClone(fullConfig),
          messages: [],
          blacklist: {},
          calls: [],
        }),
      );
      run(shell, "activate-monitor.ps1", statePath, "ACTIVAR\n");
      run(shell, "activate-monitor.ps1", statePath, "ACTIVAR\n");
      let state = JSON.parse(readFileSync(statePath, "utf8"));
      expect(state.messages).toHaveLength(1);
      expect(state.config.enabled).toEqual({ BOOL: true });
      expect(state.config.activation_owner).toBeUndefined();
      expect(Date.parse(state.config.next_scan_at.S)).not.toBeNaN();
      run(shell, "deactivate-monitor.ps1", statePath);
      state = JSON.parse(readFileSync(statePath, "utf8"));
      expect(state.config.enabled).toEqual({ BOOL: false });
      expect(state.config.monitor).toEqual(fullConfig.monitor);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rolls back only its own failed activation", () => {
    const dir = mkdtempSync(`${tmpdir()}\\prestamype-ops-`);
    const statePath = `${dir}\\state.json`;
    try {
      writeFileSync(
        statePath,
        JSON.stringify({
          config: structuredClone(fullConfig),
          messages: [],
          blacklist: {},
          calls: [],
          failSend: true,
        }),
      );
      expect(() =>
        run(shell, "activate-monitor.ps1", statePath, "ACTIVAR\n"),
      ).toThrow();
      const state = JSON.parse(readFileSync(statePath, "utf8"));
      expect(state.messages).toHaveLength(0);
      expect(state.config.enabled).toEqual({ BOOL: false });
      expect(state.config.activation_owner).toBeUndefined();
      expect(state.config.monitor).toEqual(fullConfig.monitor);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("disables a partially activated monitor after SQS accepts but next_scan_at cannot persist", () => {
    const dir = mkdtempSync(`${tmpdir()}\\prestamype-ops-`);
    const statePath = `${dir}\\state.json`;
    try {
      writeFileSync(
        statePath,
        JSON.stringify({
          config: structuredClone(fullConfig),
          messages: [],
          blacklist: {},
          calls: [],
          failActivationPersistence: true,
        }),
      );
      expect(() =>
        run(shell, "activate-monitor.ps1", statePath, "ACTIVAR\n"),
      ).toThrow(/mensaje fue aceptado|Command failed/);
      const state = JSON.parse(readFileSync(statePath, "utf8"));
      expect(state.messages).toEqual([
        expect.objectContaining({
          MessageBody: '{"kind":"scan","schemaVersion":1}',
        }),
      ]);
      expect(state.config.enabled).toEqual({ BOOL: false });
      expect(state.config.activation_owner).toBeUndefined();
      expect(state.config.next_scan_at).toBeUndefined();
      expect(
        state.calls.filter(
          (call: { args: string[] }) =>
            call.args[0] === "sqs" && call.args[1] === "send-message",
        ),
      ).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ["missing", null],
    [
      "incomplete",
      { PK: { S: "CONFIG" }, SK: { S: "MONITOR" }, enabled: { BOOL: false } },
    ],
    [
      "stale owner",
      { ...structuredClone(fullConfig), activation_owner: { S: "foreign" } },
    ],
  ])(
    "rejects %s config after a conditional failure without enqueue",
    (_label, config) => {
      const dir = mkdtempSync(`${tmpdir()}\\prestamype-ops-`);
      const statePath = `${dir}\\state.json`;
      try {
        writeFileSync(
          statePath,
          JSON.stringify({ config, messages: [], blacklist: {}, calls: [] }),
        );
        expect(() =>
          run(shell, "activate-monitor.ps1", statePath, "ACTIVAR\n"),
        ).toThrow(/configuracion falta|Command failed/);
        const state = JSON.parse(readFileSync(statePath, "utf8"));
        expect(state.messages).toHaveLength(0);
        expect(state.config).toEqual(config);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it("rejects enabled config when any activation owner is present", () => {
    const dir = mkdtempSync(`${tmpdir()}\\prestamype-ops-`);
    const statePath = `${dir}\\state.json`;
    const config = {
      ...structuredClone(fullConfig),
      enabled: { BOOL: true },
      activation_owner: { S: "foreign-owner" },
    };
    try {
      writeFileSync(
        statePath,
        JSON.stringify({ config, messages: [], blacklist: {}, calls: [] }),
      );
      expect(() =>
        run(shell, "activate-monitor.ps1", statePath, "ACTIVAR\n"),
      ).toThrow();
      const state = JSON.parse(readFileSync(statePath, "utf8"));
      expect(state.messages).toHaveLength(0);
      expect(state.config).toEqual(config);
      expect(
        state.calls.filter(
          (call: { args: string[] }) =>
            call.args[0] === "dynamodb" && call.args[1] === "update-item",
        ),
      ).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    "SessionExpiredError",
    "SessionChallengeError",
    "PageStructureError",
  ])(
    "resumes a disabled recoverable manual pause (%s) without sending",
    (reason) => {
      const dir = mkdtempSync(`${tmpdir()}\\prestamype-ops-`);
      const statePath = `${dir}\\state.json`;
      const config = {
        ...structuredClone(fullConfig),
        paused_until: { S: "manual" },
        pause_reason: { S: reason },
        rate_limit_count: { N: "2" },
        unrelated: { S: "preserve-me" },
      };
      try {
        writeFileSync(
          statePath,
          JSON.stringify({ config, messages: [], blacklist: {}, calls: [] }),
        );
        run(shell, "resume-monitor.ps1", statePath);
        const state = JSON.parse(readFileSync(statePath, "utf8"));
        expect(state.config.paused_until).toBeUndefined();
        expect(state.config.pause_reason).toBeUndefined();
        expect(state.config.enabled).toEqual({ BOOL: false });
        expect(state.config.rate_limit_count).toEqual({ N: "2" });
        expect(state.config.unrelated).toEqual({ S: "preserve-me" });
        expect(state.messages).toEqual([]);
        expect(state.calls.at(-1).input.ConditionExpression).toContain(
          "pause_reason = :reason",
        );
        for (const call of state.calls)
          if (call.inputPath)
            expect(() => readFileSync(call.inputPath)).toThrow();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.each([
    ["cost pause", "manual", "cost:MONTHLY_LIMIT", false],
    ["rate limit manual pause", "manual", "RateLimitError", false],
    ["other manual pause", "manual", "OperatorPause", false],
    ["timed pause", "2026-09-01T12:00:00.000Z", "SessionExpiredError", false],
    ["enabled pause", "manual", "SessionExpiredError", true],
    ["missing reason", "manual", null, false],
  ])(
    "rejects %s without update or send",
    (_label, pausedUntil, reason, enabled) => {
      const dir = mkdtempSync(`${tmpdir()}\\prestamype-ops-`);
      const statePath = `${dir}\\state.json`;
      const config: Record<string, unknown> = {
        ...structuredClone(fullConfig),
        enabled: { BOOL: enabled },
        paused_until: { S: pausedUntil },
      };
      if (reason) config.pause_reason = { S: reason };
      try {
        writeFileSync(
          statePath,
          JSON.stringify({ config, messages: [], blacklist: {}, calls: [] }),
        );
        expect(() => run(shell, "resume-monitor.ps1", statePath)).toThrow();
        const state = JSON.parse(readFileSync(statePath, "utf8"));
        expect(state.config).toEqual(config);
        expect(state.messages).toEqual([]);
        expect(
          state.calls.filter(
            (call: { args: string[] }) =>
              call.args[0] === "dynamodb" && call.args[1] === "update-item",
          ),
        ).toHaveLength(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it("reports a generic failure when the pause changes between read and update", () => {
    const dir = mkdtempSync(`${tmpdir()}\\prestamype-ops-`);
    const statePath = `${dir}\\state.json`;
    const config = {
      ...structuredClone(fullConfig),
      paused_until: { S: "manual" },
      pause_reason: { S: "SessionExpiredError" },
    };
    try {
      writeFileSync(
        statePath,
        JSON.stringify({
          config,
          messages: [],
          blacklist: {},
          calls: [],
          failResumeCondition: true,
        }),
      );
      expect(() => run(shell, "resume-monitor.ps1", statePath)).toThrow(
        /cambio|Command failed/,
      );
      const state = JSON.parse(readFileSync(statePath, "utf8"));
      expect(state.config).toEqual(config);
      expect(state.messages).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(["reanudar", " REANUDAR", "REANUDAR ", ""])(
    "rejects non-exact confirmation %j before AWS",
    (confirmation) => {
      const dir = mkdtempSync(`${tmpdir()}\\prestamype-ops-`);
      const statePath = `${dir}\\state.json`;
      try {
        writeFileSync(statePath, JSON.stringify({ calls: [] }));
        expect(() =>
          runResumeWithConfirmation(shell, statePath, confirmation),
        ).toThrow();
        expect(JSON.parse(readFileSync(statePath, "utf8")).calls).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.each(["ValidateOnly", "WhatIf"])(
    "%s exits before prompt and AWS",
    (mode) => {
      const dir = mkdtempSync(`${tmpdir()}\\prestamype-ops-`);
      const statePath = `${dir}\\state.json`;
      const marker = `${dir}\\prompted`;
      const scriptPath = resolve("scripts/resume-monitor.ps1").replace(
        /'/g,
        "''",
      );
      try {
        writeFileSync(statePath, JSON.stringify({ calls: [] }));
        execFileSync(
          shell,
          [
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            `function global:Read-Host { Set-Content -LiteralPath '${marker.replace(/'/g, "''")}' -Value prompted; throw 'prompted' }; & '${scriptPath}' -${mode}`,
          ],
          {
            env: {
              ...process.env,
              PATH: `${fixturePath}${delimiter}${process.env.PATH}`,
              FAKE_AWS_STATE: statePath,
              REAL_NODE: process.execPath,
            },
          },
        );
        expect(() => readFileSync(marker)).toThrow();
        expect(JSON.parse(readFileSync(statePath, "utf8")).calls).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.each([
    ["missing output", []],
    [
      "duplicate output",
      [
        { OutputKey: "TableName", OutputValue: "MonitorTable" },
        { OutputKey: "TableName", OutputValue: "OtherTable" },
      ],
    ],
    ["unsafe output", [{ OutputKey: "TableName", OutputValue: "bad/table" }]],
  ])("rejects %s without Dynamo mutation", (_label, stackOutputs) => {
    const dir = mkdtempSync(`${tmpdir()}\\prestamype-ops-`);
    const statePath = `${dir}\\state.json`;
    const config = {
      ...structuredClone(fullConfig),
      paused_until: { S: "manual" },
      pause_reason: { S: "SessionExpiredError" },
    };
    try {
      writeFileSync(
        statePath,
        JSON.stringify({ config, stackOutputs, calls: [], messages: [] }),
      );
      expect(() => run(shell, "resume-monitor.ps1", statePath)).toThrow();
      const state = JSON.parse(readFileSync(statePath, "utf8"));
      expect(state.config).toEqual(config);
      expect(
        state.calls.filter(
          (call: { args: string[] }) => call.args[0] === "dynamodb",
        ),
      ).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    [
      "incomplete config",
      {
        PK: { S: "CONFIG" },
        SK: { S: "MONITOR" },
        enabled: { BOOL: false },
        paused_until: { S: "manual" },
        pause_reason: { S: "SessionExpiredError" },
      },
    ],
    [
      "wrong Dynamo attribute type",
      {
        ...structuredClone(fullConfig),
        enabled: { S: "false" },
        paused_until: { S: "manual" },
        pause_reason: { S: "SessionExpiredError" },
      },
    ],
    [
      "activation owner",
      {
        ...structuredClone(fullConfig),
        paused_until: { S: "manual" },
        pause_reason: { S: "SessionExpiredError" },
        activation_owner: { S: "foreign" },
      },
    ],
  ])("rejects %s without update or send", (_label, config) => {
    const dir = mkdtempSync(`${tmpdir()}\\prestamype-ops-`);
    const statePath = `${dir}\\state.json`;
    try {
      writeFileSync(
        statePath,
        JSON.stringify({ config, calls: [], messages: [], blacklist: {} }),
      );
      expect(() => run(shell, "resume-monitor.ps1", statePath)).toThrow();
      const state = JSON.parse(readFileSync(statePath, "utf8"));
      expect(state.config).toEqual(config);
      expect(state.messages).toEqual([]);
      expect(
        state.calls.filter(
          (call: { args: string[] }) =>
            call.args[0] === "dynamodb" && call.args[1] === "update-item",
        ),
      ).toEqual([]);
      for (const call of state.calls)
        if (call.inputPath)
          expect(() => readFileSync(call.inputPath)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("supports the safe recovery sequence through one-shot execution and later activation", async () => {
    const dir = mkdtempSync(`${tmpdir()}\\prestamype-ops-`);
    const statePath = `${dir}\\state.json`;
    const config = {
      ...structuredClone(fullConfig),
      enabled: { BOOL: true },
      paused_until: { S: "manual" },
      pause_reason: { S: "SessionExpiredError" },
    };
    try {
      writeFileSync(
        statePath,
        JSON.stringify({
          config,
          messages: [],
          blacklist: {},
          calls: [],
        }),
      );
      run(shell, "deactivate-monitor.ps1", statePath);
      await captureSession({
        key: new Uint8Array(32).fill(4),
        output: vi.fn(),
        store: {
          loadEncryptedSession: vi.fn(async () => null),
          saveEncryptedSession: vi.fn(async (session) => {
            const stored = JSON.parse(readFileSync(statePath, "utf8"));
            stored.session = session;
            writeFileSync(statePath, JSON.stringify(stored));
          }),
        },
        launcher: {
          launch: vi.fn(async () => ({
            newContext: async () => ({
              newPage: async () => ({
                goto: async () => undefined,
                url: () =>
                  "https://www.prestamype.com/app/inversionista/oportunidades",
                waitForSelector: async () => undefined,
                locator: () => ({ isVisible: async () => false }),
              }),
              storageState: async () => ({ cookies: [], origins: [] }),
              close: async () => undefined,
            }),
            close: async () => undefined,
          })),
        },
      });
      let state = JSON.parse(readFileSync(statePath, "utf8"));
      expect(state.config.enabled).toEqual({ BOOL: false });
      expect(state.config.paused_until).toEqual({ S: "manual" });
      expect(state.config.pause_reason).toEqual({ S: "SessionExpiredError" });
      expect(state.session).toBeDefined();
      run(shell, "resume-monitor.ps1", statePath);
      state = JSON.parse(readFileSync(statePath, "utf8"));

      const scheduleNextScan = vi.fn(async () => ({
        messageId: "unused",
        delaySeconds: 75,
        scheduledAt: "2026-09-01T00:01:15.000Z",
      }));
      const runMonitor = vi.fn(async () => ({
        acquired: true,
        evaluated: 0,
        alertsSent: 0,
      }));
      const runtimeConfig = {
        enabled: state.config.enabled.BOOL,
        monitor: {
          allowedRisks: state.config.monitor.M.allowedRisks.L.map(
            (entry: { S: string }) => entry.S,
          ),
          minimumAnnualReturnPct: Number(
            state.config.monitor.M.minimumAnnualReturnPct.N,
          ),
          currency: state.config.monitor.M.currency.S,
          minimumInvestmentCents: Number(
            state.config.monitor.M.minimumInvestmentCents.N,
          ),
          highPriorityScore: Number(state.config.monitor.M.highPriorityScore.N),
          reviewScore: Number(state.config.monitor.M.reviewScore.N),
          detailRefreshIntervalMs: Number(
            state.config.monitor.M.detailRefreshIntervalMs.N,
          ),
        },
        costLimits: {
          configuredMemoryGb: Number(
            state.config.costLimits.M.configuredMemoryGb.N,
          ),
          monthlyGbSecondsLimit: Number(
            state.config.costLimits.M.monthlyGbSecondsLimit.N,
          ),
        },
      };
      const handler = createScanHandler({
        store: {
          loadConfig: vi.fn(async () => runtimeConfig),
          saveConfig: vi.fn(async () => undefined),
          incrementMonthlyUsage: vi.fn(async () => ({
            invocations: 1,
            durationMs: 0,
            scans: 0,
          })),
          loadEncryptedSession: vi.fn(async () => ({
            version: 1,
            iv: "AA==",
            ciphertext: "AA==",
            authTag: "AA==",
          })),
          claimScheduleSlot: vi.fn(async () => true),
          releaseScheduleSlot: vi.fn(async () => undefined),
        },
        assessCost: vi.fn(() => ({
          action: "CONTINUE" as const,
          projectedGbSeconds: 0,
          utilizationRatio: 0,
          reason: "USAGE" as const,
        })),
        scheduleNextScan,
        loadSecrets: vi.fn(async () => ({ sessionKey: new Uint8Array(32) })),
        decryptSession: vi.fn(() => ({})),
        createMonitorDependencies: vi.fn(async () => ({}) as never),
        runMonitor,
        notifyDiagnostic: vi.fn(async () => undefined),
        clock: () => new Date("2026-09-01T00:00:00.000Z"),
      });
      await handler(
        {
          Records: [
            {
              messageId: "recovery-one-shot",
              body: '{"kind":"scan-once","schemaVersion":1}',
            },
          ],
        },
        { getRemainingTimeInMillis: () => 30_000 },
      );
      expect(runMonitor).toHaveBeenCalledOnce();
      expect(scheduleNextScan).not.toHaveBeenCalled();

      run(shell, "activate-monitor.ps1", statePath);
      state = JSON.parse(readFileSync(statePath, "utf8"));
      expect(state.config.enabled).toEqual({ BOOL: true });
      expect(state.messages).toEqual([
        expect.objectContaining({
          MessageBody: '{"kind":"scan","schemaVersion":1}',
        }),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
