import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const scripts = [
  "bootstrap-parameters.ps1",
  "seed-blacklist.ps1",
  "invoke-once.ps1",
  "activate-monitor.ps1",
  "deactivate-monitor.ps1",
  "resume-monitor.ps1",
  "status-monitor.ps1",
  "configure-monitor.ps1",
] as const;
const shells = ["pwsh", "powershell"].map((name) => ({
  name,
  path: execFileSync("where.exe", [name], { encoding: "utf8" })
    .trim()
    .split(/\r?\n/)[0]!,
}));

function source(name: string): string {
  return readFileSync(resolve("scripts", name), "utf8");
}

describe("operational PowerShell scripts", () => {
  it.each(shells.flatMap((shell) => scripts.map((name) => ({ shell, name }))))(
    "$name validates in $shell.name without AWS or prompts",
    ({ shell, name }) => {
      const output = execFileSync(
        shell.path,
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          resolve("scripts", name),
          "-ValidateOnly",
        ],
        {
          encoding: "utf8",
          env: { ...process.env, PATH: "" },
          timeout: 10_000,
          windowsHide: true,
        },
      );
      expect(output).toContain("local correcta");
    },
  );

  it.each(scripts)(
    "%s is strict and supports effect-free validation",
    (name) => {
      const text = source(name);
      expect(text).toContain("Set-StrictMode -Version Latest");
      expect(text).toContain('$ErrorActionPreference = "Stop"');
      expect(text).toMatch(/\[switch\]\$ValidateOnly/);
    },
  );

  it("does not accept bootstrap secrets or activation confirmation as arguments", () => {
    const bootstrapParameters = source("bootstrap-parameters.ps1").split(
      ")\nSet-StrictMode",
      1,
    )[0]!;
    const activationParameters = source("activate-monitor.ps1").split(
      ")\nSet-StrictMode",
      1,
    )[0]!;
    expect(bootstrapParameters).not.toMatch(
      /\$(TelegramToken|TelegramChatId|SessionKey)\b/i,
    );
    expect(activationParameters).not.toMatch(/\$(Confirm|Confirmation)\b/i);
    const resumeParameters = source("resume-monitor.ps1").split(
      ")\nSet-StrictMode",
      1,
    )[0]!;
    expect(resumeParameters).not.toMatch(/\$(Confirm|Confirmation)\b/i);
  });

  it("keeps one-shot and chained scan bodies distinct and blacklist writes immutable", () => {
    expect(source("invoke-once.ps1")).toContain(
      '{"kind":"scan-once","schemaVersion":1}',
    );
    expect(source("activate-monitor.ps1")).toContain(
      '{"kind":"scan","schemaVersion":1}',
    );
    const seed = source("seed-blacklist.ps1");
    expect(seed).toContain("CORPORACION LERIBE SAC");
    expect(seed).toContain("20517854523");
    expect(seed).toContain("attribute_not_exists(PK)");
  });

  it("streams bootstrap secrets only to the authorized child stdin", () => {
    const bootstrap = source("bootstrap-parameters.ps1");
    expect(bootstrap).toContain("RedirectStandardInput = $true");
    expect(bootstrap).toContain("StandardInput.Write($request)");
    expect(
      bootstrap.slice(bootstrap.indexOf('Read-Host "Token')),
    ).not.toContain("GetRandomFileName");
    expect(bootstrap).not.toMatch(/EnvironmentVariables|--value/i);
    expect(bootstrap).toContain("Arguments = '\"' + $helper");
    expect(bootstrap.indexOf("StandardOutput.ReadToEndAsync()")).toBeLessThan(
      bootstrap.indexOf("WaitForExit()"),
    );
    expect(bootstrap.indexOf("StandardError.ReadToEndAsync()")).toBeLessThan(
      bootstrap.indexOf("WaitForExit()"),
    );
    expect(bootstrap).toContain("$process.Dispose()");
  });

  it("uses owner-conditional idempotent activation and rollback", () => {
    const activation = source("activate-monitor.ps1");
    expect(activation).not.toContain("attribute_not_exists(enabled)");
    expect(activation).toContain("attribute_exists(monitor)");
    expect(activation).toContain("attribute_exists(costLimits)");
    expect(activation).toContain("enabled = :disabled");
    expect(activation).toContain(
      "activation_owner = :owner AND enabled = :enabled",
    );
    expect(activation).toContain("ConditionalCheckFailedException");
    expect(activation).toContain("REMOVE activation_owner");
  });

  it("bootstraps the complete disabled runtime config before prompting for secrets", () => {
    const bootstrap = source("bootstrap-parameters.ps1");
    for (const value of [
      "allowedRisks",
      "minimumAnnualReturnPct",
      "minimumInvestmentCents",
      "highPriorityScore",
      "reviewScore",
      "detailRefreshIntervalMs",
      "configuredMemoryGb",
      "monthlyGbSecondsLimit",
    ])
      expect(bootstrap).toContain(value);
    expect(bootstrap.indexOf("update-item")).toBeLessThan(
      bootstrap.indexOf('Read-Host "Token'),
    );
    expect(bootstrap).toContain("BOOL = $false");
  });

  it("passes operational payloads through cli input files, not inline JSON", () => {
    for (const name of [
      "seed-blacklist.ps1",
      "invoke-once.ps1",
      "activate-monitor.ps1",
      "deactivate-monitor.ps1",
      "resume-monitor.ps1",
    ]) {
      const text = source(name);
      expect(text).toContain("--cli-input-json");
      expect(text).not.toMatch(
        /& aws[^\r\n]+(?:--key|--message-body|--expression-attribute-values)/,
      );
    }
  });

  it("resumes only an exact disabled recoverable manual pause without enqueueing", () => {
    const resume = source("resume-monitor.ps1");
    expect(resume).toContain('Read-Host "Escribe exactamente REANUDAR');
    expect(resume).toContain('$confirmation -cne "REANUDAR"');
    expect(resume).toContain('paused_until.S -cne "manual"');
    for (const reason of [
      "SessionExpiredError",
      "SessionChallengeError",
      "PageStructureError",
    ])
      expect(resume).toContain(reason);
    expect(resume).toContain("ConsistentRead = $true");
    expect(resume).toContain("enabled = :disabled");
    expect(resume).toContain("paused_until = :manual");
    expect(resume).toContain("pause_reason = :reason");
    expect(resume).toContain("REMOVE paused_until, pause_reason");
    expect(resume).not.toContain("sqs send-message");
    expect(resume).not.toContain("SET enabled = :enabled");
  });
});
