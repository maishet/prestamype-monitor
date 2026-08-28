import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import type { Opportunity, PortfolioSnapshot } from "../../src/domain/types.js";
import { encryptSession } from "../../src/security/session-crypto.js";
import {
  DryRunError,
  redactDryRunOutput,
  resolveDryRunAdapterSpecifier,
  runDryRun,
  runDryRunCli,
} from "../../src/cli/dry-run.js";

const fixtureDirectory = resolve("tests/fixtures");

describe("runDryRun", () => {
  it("evaluates the sanitized local fixtures without loading live modules", async () => {
    const output: string[] = [];
    const moduleLoader = vi.fn(async () => {
      throw new Error("network/module loading must be impossible");
    });

    await expect(
      runDryRun(["--fixture"], {
        output: (line) => output.push(line),
        moduleLoader,
        fixtureDirectory,
      }),
    ).resolves.toEqual({ mode: "fixture", evaluated: 1 });

    expect(moduleLoader).not.toHaveBeenCalled();
    expect(output.join("\n")).toContain("Decisión:");
    expect(output.join("\n")).toContain("Score:");
    expect(output.join("\n")).not.toMatch(/\b\d{11}\b/);
    expect(output.join("\n")).not.toMatch(/cookie|authorization|token/i);
  });

  it.each([[[]], [["--fixture", "--live"]], [["--wat"]]])(
    "rejects invalid modes without loading anything: %j",
    async (args) => {
      const moduleLoader = vi.fn();
      await expect(runDryRun(args, { moduleLoader })).rejects.toBeInstanceOf(
        DryRunError,
      );
      expect(moduleLoader).not.toHaveBeenCalled();
    },
  );

  it("refuses fixture files outside the known sanitized directory", async () => {
    await expect(
      runDryRun(["--fixture"], { fixtureDirectory: resolve("src") }),
    ).rejects.toThrow("Fixture directory is not allowed");
  });

  it("rejects a fixture symlink before reading it", async () => {
    const root = resolve("tests/fixtures");
    const fixtureFs = {
      lstat: vi.fn(async (path: string) => ({
        isSymbolicLink: () => path.endsWith("opportunities.html"),
        isDirectory: () => path === root,
        isFile: () => path !== root,
      })),
      realpath: vi.fn(async (path: string) => path),
      readFile: vi.fn(async () => "never"),
    };
    await expect(
      runDryRun(["--fixture"], { fixtureDirectory: root, fixtureFs }),
    ).rejects.toThrow("Fixture path is not allowed");
    expect(fixtureFs.readFile).not.toHaveBeenCalled();
  });

  it("runs live read-only, prints prospective messages, and always closes", async () => {
    const key = new Uint8Array(32).fill(7);
    const output: string[] = [];
    const source = {
      getPortfolio: vi.fn(async () => portfolio),
      listEligibleOpportunities: vi.fn(async () => [opportunity]),
      close: vi.fn(async () => undefined),
    };
    const loadEncryptedSession = vi.fn(async () =>
      encryptSession({ cookies: [], origins: [] }, key),
    );
    const createDryRunDependencies = vi.fn(async () => ({
      store: { loadEncryptedSession, saveEncryptedSession: vi.fn() },
      key,
      launcher: { launch: vi.fn() },
      config: DEFAULT_CONFIG,
      blacklist: [],
    }));
    const loader = vi.fn(async () => ({ createDryRunDependencies }));

    await expect(
      runDryRun(["--live"], {
        environment: { PRESTAMYPE_DRY_RUN_ADAPTER: "./safe-adapter.js" },
        moduleLoader: loader,
        output: (line) => output.push(line),
        createClient: () => source,
      }),
    ).resolves.toEqual({ mode: "live", evaluated: 1 });

    expect(loader).toHaveBeenCalledWith(
      pathToFileURL(resolve("safe-adapter.js")).href,
    );
    expect(loadEncryptedSession).toHaveBeenCalledWith({
      signal: expect.any(AbortSignal),
    });
    expect(source.listEligibleOpportunities).toHaveBeenCalledWith(
      DEFAULT_CONFIG,
      {},
    );
    expect(source.close).toHaveBeenCalledOnce();
    expect(output.join("\n")).toContain("[NO ENVIADO]");
    expect(output.join("\n")).not.toContain("20123456789");
  });

  it.each([
    ["./adapter.js", pathToFileURL(resolve("adapter.js")).href],
    ["../adapter.js", pathToFileURL(resolve("../adapter.js")).href],
    [resolve("adapter.js"), pathToFileURL(resolve("adapter.js")).href],
    ["file:///safe/adapter.js", "file:///safe/adapter.js"],
    ["node:fs", "node:fs"],
    [
      "data:text/javascript,export default 1",
      "data:text/javascript,export default 1",
    ],
    ["safe-package", "safe-package"],
  ])("resolves an adapter specifier %s", (input, expected) => {
    expect(resolveDryRunAdapterSpecifier(input, process.cwd())).toBe(expected);
  });

  it.each([
    "https://example.test/a.js",
    "http://example.test/a.js",
    "ftp://example.test/a.js",
  ])("rejects network adapter URL %s", (specifier) => {
    expect(() => resolveDryRunAdapterSpecifier(specifier)).toThrow(
      "specifier is not allowed",
    );
  });

  it.each([
    "\\\\host\\share\\adapter.js",
    "//host/share/adapter.js",
    "\\\\host/share/adapter.js",
    "//host\\share/adapter.js",
    "file://attacker/share/adapter.js",
    "file://localhost/C:/adapter.js",
  ])(
    "rejects UNC or authoritative file adapter %s before loading",
    async (specifier) => {
      expect(() => resolveDryRunAdapterSpecifier(specifier)).toThrow(
        DryRunError,
      );
      const loader = vi.fn();
      await expect(
        runDryRun(["--live"], {
          environment: { PRESTAMYPE_DRY_RUN_ADAPTER: specifier },
          moduleLoader: loader,
        }),
      ).rejects.toBeInstanceOf(DryRunError);
      expect(loader).not.toHaveBeenCalled();
    },
  );

  it.each(["file:///C:/safe/adapter.js", "file:///tmp/safe-adapter.js"])(
    "allows a hostless file adapter %s",
    (specifier) => {
      expect(resolveDryRunAdapterSpecifier(specifier)).toBe(specifier);
    },
  );

  it.each([
    "file:%2f%2fhost/share/adapter.js",
    "file:/%2F%2Fhost/share/adapter.js",
    "file:%5c%5chost\\share\\adapter.js",
    "file:%252f%252fhost/share/adapter.js",
    "file:%255C%255Chost/share/adapter.js",
  ])("rejects encoded file separators %s before loading", async (specifier) => {
    expect(() => resolveDryRunAdapterSpecifier(specifier)).toThrow(DryRunError);
    const loader = vi.fn();
    await expect(
      runDryRun(["--live"], {
        environment: { PRESTAMYPE_DRY_RUN_ADAPTER: specifier },
        moduleLoader: loader,
      }),
    ).rejects.toBeInstanceOf(DryRunError);
    expect(loader).not.toHaveBeenCalled();
  });

  it("redacts known sensitive patterns line-by-line", () => {
    const input = [
      "Authorization: Basic dXNlcjpwYXNz extra words",
      "Cookie=session=canary-cookie; preference=yes",
      "api_key = canary api key with spaces",
      "note Bearer canary-bearer-token suffix",
      "jwt eyJhbGciOiJIUzI1NiJ9.eyJjYW5hcnkiOnRydWV9.signature-canary",
      "RUC 20123456789",
      "ok decision INVEST",
    ].join("\n");
    const output = redactDryRunOutput(input);
    expect(output).toContain("Authorization: [REDACTADO]");
    expect(output).toContain("Cookie=[REDACTADO]");
    expect(output).toContain("api_key = [REDACTADO]");
    expect(output).toContain("ok decision INVEST");
    expect(output).not.toMatch(/canary|20123456789|dXNlcjpwYXNz/);
  });

  it("sanitizes malicious live domain strings before formatting", async () => {
    const key = new Uint8Array(32).fill(3);
    const output: string[] = [];
    const malicious = {
      ...opportunity,
      supplier: {
        ...opportunity.supplier,
        legalName: "Proveedor\nAuthorization: Basic name-canary",
      },
      debtor: {
        ...opportunity.debtor,
        legalName: "Cookie: compound=debtor-canary; x=y",
      },
      url: `${opportunity.url}?token=url-canary`,
    };
    await runDryRun(["--live"], {
      environment: { PRESTAMYPE_DRY_RUN_ADAPTER: "adapter" },
      moduleLoader: async () => ({
        createDryRunDependencies: async () => ({
          store: {
            loadEncryptedSession: async () =>
              encryptSession({ cookies: [], origins: [] }, key),
            saveEncryptedSession: vi.fn(),
          },
          key,
          launcher: { launch: vi.fn() },
          blacklist: [
            {
              taxId: opportunity.supplier.taxId,
              normalizedName: "x",
              reason: "api_key: blacklist-canary with spaces",
              source: "test",
              createdAt: "2026-01-01",
            },
          ],
        }),
      }),
      createClient: () => ({
        getPortfolio: async () => portfolio,
        listEligibleOpportunities: async () => [malicious],
        close: async () => undefined,
      }),
      output: (line) => output.push(line),
    });
    expect(output.join("\n")).not.toMatch(
      /name-canary|debtor-canary|url-canary|blacklist-canary/,
    );
  });

  it("closes live resources and exposes only a safe error", async () => {
    const key = new Uint8Array(32).fill(9);
    const close = vi.fn(async () => undefined);
    const loader = vi.fn(async () => ({
      createDryRunDependencies: async () => ({
        store: {
          loadEncryptedSession: async () =>
            encryptSession({ cookies: [], origins: [] }, key),
          saveEncryptedSession: vi.fn(),
        },
        key,
        launcher: { launch: vi.fn() },
      }),
    }));
    const source = {
      getPortfolio: async () => {
        throw new Error("Bearer raw-secret-token 20123456789");
      },
      listEligibleOpportunities: vi.fn(),
      close,
    };

    const error = await runDryRun(["--live"], {
      environment: { PRESTAMYPE_DRY_RUN_ADAPTER: "adapter" },
      moduleLoader: loader,
      createClient: () => source,
    }).catch((caught: unknown) => caught);
    expect(close).toHaveBeenCalledOnce();
    expect(error).toBeInstanceOf(DryRunError);
    expect(String(error)).not.toMatch(/raw-secret|20123456789/);
  });

  it("returns a safe CLI status and never emits raw exceptions", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    await expect(
      runDryRunCli(
        ["--live"],
        {},
        {
          output: (line) => stdout.push(line),
          errorOutput: (line) => stderr.push(line),
        },
      ),
    ).resolves.toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["Live dry-run is not configured"]);
  });

  it("runs the CLI composition with a relative local adapter file URL", async () => {
    const key = new Uint8Array(32).fill(4);
    const loader = vi.fn(async () => ({
      createDryRunDependencies: async () => ({
        store: {
          loadEncryptedSession: async () =>
            encryptSession({ cookies: [], origins: [] }, key),
          saveEncryptedSession: vi.fn(),
        },
        key,
        launcher: { launch: vi.fn() },
      }),
    }));
    await expect(
      runDryRunCli(
        ["--live"],
        { PRESTAMYPE_DRY_RUN_ADAPTER: "./local-adapter.js" },
        {
          moduleLoader: loader,
          createClient: () => ({
            getPortfolio: async () => portfolio,
            listEligibleOpportunities: async () => [],
            close: async () => undefined,
          }),
          output: vi.fn(),
          errorOutput: vi.fn(),
        },
      ),
    ).resolves.toBe(0);
    expect(loader).toHaveBeenCalledWith(
      pathToFileURL(resolve("local-adapter.js")).href,
    );
  });

  it("aborts a live session load at the configured timeout", async () => {
    const signalSeen: AbortSignal[] = [];
    const loader = vi.fn(async () => ({
      createDryRunDependencies: async () => ({
        store: {
          loadEncryptedSession: ({ signal }: { signal: AbortSignal }) => {
            signalSeen.push(signal);
            return new Promise(() => undefined);
          },
          saveEncryptedSession: vi.fn(),
        },
        key: new Uint8Array(32),
        launcher: { launch: vi.fn() },
      }),
    }));
    await expect(
      runDryRun(["--live"], {
        environment: { PRESTAMYPE_DRY_RUN_ADAPTER: "adapter" },
        moduleLoader: loader,
        timeoutMs: 5,
      }),
    ).rejects.toThrow("timed out safely");
    expect(signalSeen[0]?.aborted).toBe(true);
  });
});

const opportunity: Opportunity = {
  id: "opp-safe-1",
  url: "https://prestamype.com/app/inversionista/oportunidades/opp-safe-1",
  supplier: { legalName: "Proveedor Demo S.A.C.", taxId: "20123456789" },
  debtor: { legalName: "Pagador Demo S.A.", taxId: "20987654321" },
  risk: "A",
  currency: "PEN",
  annualReturnPct: 18,
  monthlyReturnPct: 1.4,
  totalAmountCents: 200_000,
  fundedAmountCents: 50_000,
  remainingAmountCents: 150_000,
  closesAt: null,
  dueAt: null,
  debtorHistory: null,
  supplierHistory: null,
  collectionProblem: false,
};

const portfolio: PortfolioSnapshot = {
  availableBalanceCents: 0,
  activeTotalCents: 0,
  exposureByTaxId: {},
};
