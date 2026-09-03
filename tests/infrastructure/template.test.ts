import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

// The parsed deployment document is intentionally dynamic at this test boundary.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonObject = Record<string, any>;

const root = resolve(import.meta.dirname, "../..");
const text = readFileSync(resolve(root, "template.yaml"), "utf8");
const template = JSON.parse(text) as JsonObject;
const resources = template.Resources as JsonObject;

function resource(type: string, logicalId: string): JsonObject {
  const value = resources[logicalId] as JsonObject;
  expect(value?.Type).toBe(type);
  return value;
}

function statements(logicalId: string): JsonObject[] {
  const policies = resource("AWS::IAM::Role", `${logicalId}Role`).Properties
    .Policies as JsonObject[];
  return policies.flatMap((policy) => policy.PolicyDocument?.Statement ?? []);
}

describe("SAM infrastructure", () => {
  it("configures bounded Node 22 scan and supervisor functions", () => {
    expect(template.Transform).toBe("AWS::Serverless-2016-10-31");
    for (const logicalId of ["ScanFunction", "SupervisorFunction"]) {
      const properties = resource(
        "AWS::Serverless::Function",
        logicalId,
      ).Properties;
      expect(properties.Runtime).toBe("nodejs22.x");
      expect(properties.Architectures).toEqual(["x86_64"]);
      expect(properties.MemorySize).toBe(
        logicalId === "ScanFunction" ? 2048 : 1024,
      );
      expect(properties.Timeout).toBe(30);
      expect(properties.ReservedConcurrentExecutions).toEqual({
        "Fn::If": ["UseReservedConcurrency", 1, { Ref: "AWS::NoValue" }],
      });
      expect(properties.Role).toEqual({
        "Fn::GetAtt": [`${logicalId}Role`, "Arn"],
      });
      expect(properties.VpcConfig).toBeUndefined();
      expect(properties.Environment.Variables).toMatchObject({
        TABLE_NAME: { Ref: "MonitorTable" },
        QUEUE_URL: { Ref: "ScanQueue" },
      });
      expect(properties.Events.Api).toBeUndefined();
    }

    expect(template.Parameters.EnableReservedConcurrency).toMatchObject({
      Default: "false",
      AllowedValues: ["false", "true"],
    });
    expect(template.Conditions.UseReservedConcurrency).toEqual({
      "Fn::Equals": [{ Ref: "EnableReservedConcurrency" }, "true"],
    });

    expect(resources.ScanFunction.Properties.Handler).toBe("handler.handler");
    expect(resources.ScanFunction.Properties.Layers).toEqual([
      { Ref: "BrowserDependenciesLayer" },
    ]);
    expect(resources.SupervisorFunction.Properties.Handler).toBe(
      "supervisor.supervisorHandler",
    );
    expect(resources.ScanFunction.Properties.Events.ScanQueue).toMatchObject({
      Type: "SQS",
      Properties: {
        BatchSize: 1,
        Queue: { "Fn::GetAtt": ["ScanQueue", "Arn"] },
      },
    });
    expect(
      resources.SupervisorFunction.Properties.Events.Supervisor,
    ).toMatchObject({
      Type: "Schedule",
      Properties: { Schedule: "rate(10 minutes)" },
    });
  });

  it("uses encrypted standard SQS with a DLQ and safe visibility", () => {
    const queue = resource("AWS::SQS::Queue", "ScanQueue").Properties;
    const deadLetter = resource(
      "AWS::SQS::Queue",
      "DeadLetterQueue",
    ).Properties;
    expect(queue.FifoQueue).not.toBe(true);
    expect(queue.VisibilityTimeout).toBeGreaterThanOrEqual(120);
    expect(queue.SqsManagedSseEnabled).toBe(true);
    expect(deadLetter.SqsManagedSseEnabled).toBe(true);
    expect(queue.RedrivePolicy).toEqual({
      deadLetterTargetArn: { "Fn::GetAtt": ["DeadLetterQueue", "Arn"] },
      maxReceiveCount: 5,
    });
  });

  it("defines a minimal provisioned table, TTL, and opportunity GSI", () => {
    const table = resource("AWS::DynamoDB::Table", "MonitorTable").Properties;
    expect(table.BillingMode).toBe("PROVISIONED");
    expect(table.ProvisionedThroughput).toEqual({
      ReadCapacityUnits: 1,
      WriteCapacityUnits: 1,
    });
    expect(table.TimeToLiveSpecification).toEqual({
      AttributeName: "expiresAt",
      Enabled: true,
    });
    expect(table.PointInTimeRecoverySpecification).toBeUndefined();
    expect(table.KeySchema).toEqual([
      { AttributeName: "PK", KeyType: "HASH" },
      { AttributeName: "SK", KeyType: "RANGE" },
    ]);
    expect(table.GlobalSecondaryIndexes).toEqual([
      {
        IndexName: "EntityTypeIndex",
        KeySchema: [
          { AttributeName: "GSI1PK", KeyType: "HASH" },
          { AttributeName: "GSI1SK", KeyType: "RANGE" },
        ],
        Projection: { ProjectionType: "ALL" },
        ProvisionedThroughput: { ReadCapacityUnits: 1, WriteCapacityUnits: 1 },
      },
    ]);
  });

  it("retains both function log groups for seven days", () => {
    for (const logicalId of ["ScanLogGroup", "SupervisorLogGroup"]) {
      expect(
        resource("AWS::Logs::LogGroup", logicalId).Properties.RetentionInDays,
      ).toBe(7);
    }
  });

  it("passes only named SSM paths and scopes every IAM resource", () => {
    expect(template.Parameters).toEqual({
      TelegramTokenParameterPath: expect.objectContaining({ Type: "String" }),
      TelegramChatIdParameterPath: expect.objectContaining({ Type: "String" }),
      SessionKeyParameterPath: expect.objectContaining({ Type: "String" }),
      EnableReservedConcurrency: expect.objectContaining({ Type: "String" }),
    });
    expect(
      resources.ScanFunction.Properties.Environment.Variables,
    ).toMatchObject({
      TELEGRAM_TOKEN_PARAMETER: { Ref: "TelegramTokenParameterPath" },
      TELEGRAM_CHAT_ID_PARAMETER: { Ref: "TelegramChatIdParameterPath" },
      SESSION_KEY_PARAMETER: { Ref: "SessionKeyParameterPath" },
    });
    expect(
      resources.SupervisorFunction.Properties.Environment.Variables,
    ).toEqual({
      TABLE_NAME: { Ref: "MonitorTable" },
      QUEUE_URL: { Ref: "ScanQueue" },
    });

    for (const logicalId of ["ScanFunction", "SupervisorFunction"]) {
      for (const statement of statements(logicalId)) {
        const iamResources = Array.isArray(statement.Resource)
          ? statement.Resource
          : [statement.Resource];
        expect(iamResources).not.toContain("*");
        expect(
          iamResources.every((value: unknown) => value !== undefined),
        ).toBe(true);
        const wildcardResources = iamResources.filter((value) =>
          JSON.stringify(value).includes("*"),
        );
        if (wildcardResources.length > 0) {
          // Lambda creates unpredictable log-stream names, so this is the sole
          // resource-suffix wildcard and remains bound to one function log group.
          expect(statement.Action).toEqual([
            "logs:CreateLogStream",
            "logs:PutLogEvents",
          ]);
          expect(wildcardResources).toHaveLength(1);
          expect(JSON.stringify(wildcardResources[0])).toMatch(
            /log-group:\/aws\/lambda\/.*:\*"/u,
          );
        }
      }
    }
    const scanStatements = statements("ScanFunction");
    const ssm = scanStatements.find((item) =>
      ([] as string[]).concat(item.Action).includes("ssm:GetParameters"),
    );
    expect(ssm?.Resource).toHaveLength(3);
    expect(JSON.stringify(ssm?.Resource)).toContain(
      "parameter${TelegramTokenParameterPath}",
    );
    expect(JSON.stringify(ssm?.Resource)).toContain(
      "parameter${TelegramChatIdParameterPath}",
    );
    expect(JSON.stringify(ssm?.Resource)).toContain(
      "parameter${SessionKeyParameterPath}",
    );
  });

  it("bundles production browser packages with esbuild and valid entrypoints", () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(root, "package.json"), "utf8"),
    ) as JsonObject;
    expect(packageJson.dependencies).toMatchObject({
      "@sparticuz/chromium": expect.any(String),
      esbuild: expect.any(String),
      "playwright-core": expect.any(String),
    });
    expect(packageJson.devDependencies.esbuild).toBeUndefined();
    expect(packageJson.dependencies.playwright).toBeUndefined();

    const browserLayer = resource(
      "AWS::Serverless::LayerVersion",
      "BrowserDependenciesLayer",
    );
    expect(browserLayer.Properties).toMatchObject({
      ContentUri: "layers/browser",
      CompatibleRuntimes: ["nodejs22.x"],
      CompatibleArchitectures: ["x86_64"],
      RetentionPolicy: "Delete",
    });
    expect(browserLayer.Metadata.BuildMethod).toBe("makefile");
    const layerPackage = JSON.parse(
      readFileSync(resolve(root, "layers/browser/package.json"), "utf8"),
    ) as JsonObject;
    expect(layerPackage.dependencies).toEqual({
      "@sparticuz/chromium": packageJson.dependencies["@sparticuz/chromium"],
      "playwright-core": packageJson.dependencies["playwright-core"],
    });
    expect(layerPackage.dependencies.esbuild).toBeUndefined();
    expect(layerPackage.dependencies.playwright).toBeUndefined();
    const layerLock = JSON.parse(
      readFileSync(resolve(root, "layers/browser/package-lock.json"), "utf8"),
    ) as JsonObject;
    expect(layerLock.packages[""].dependencies).toEqual(
      layerPackage.dependencies,
    );
    const layerMakefile = readFileSync(
      resolve(root, "layers/browser/Makefile"),
      "utf8",
    );
    expect(layerMakefile).toContain("npm ci --omit=dev");

    const entrypoints = [
      ["ScanFunction", "src/lambda/handler.ts"],
      ["SupervisorFunction", "src/lambda/supervisor.ts"],
    ] as const;
    for (const [logicalId, entrypoint] of entrypoints) {
      const metadata = resources[logicalId].Metadata;
      expect(metadata.BuildMethod).toBe("esbuild");
      expect(metadata.BuildProperties).toMatchObject({
        Target: "es2022",
        EntryPoints: [entrypoint],
        OutExtension: [".js=.mjs"],
        Banner: [expect.stringContaining("createRequire(import.meta.url)")],
      });
      expect(resources[logicalId].Properties.Handler.split(".")[0]).toBe(
        entrypoint.split("/").at(-1)?.replace(/\.ts$/u, ""),
      );
      expect(metadata.BuildProperties.External ?? []).toEqual(
        logicalId === "ScanFunction"
          ? ["@sparticuz/chromium", "playwright-core"]
          : [],
      );
      expect(readFileSync(resolve(root, entrypoint), "utf8")).toContain(
        logicalId === "ScanFunction"
          ? "export async function handler"
          : "export async function supervisorHandler",
      );
    }
    const browserClient = readFileSync(
      resolve(root, "src/browser/prestamype-client.ts"),
      "utf8",
    );
    expect(browserClient).toContain("createRequire(import.meta.url)");
    expect(browserClient).not.toContain('await import("playwright-core")');
    expect(browserClient).toContain(
      'runtimeRequire.resolve("@sparticuz/chromium")',
    );
  });

  it("pairs Playwright with the Chromium major shipped by Sparticuz", () => {
    const playwrightBrowsers = JSON.parse(
      readFileSync(
        resolve(root, "node_modules/playwright-core/browsers.json"),
        "utf8",
      ),
    ) as JsonObject;
    const chromiumPackage = JSON.parse(
      readFileSync(
        resolve(root, "node_modules/@sparticuz/chromium/package.json"),
        "utf8",
      ),
    ) as JsonObject;
    const chromium = playwrightBrowsers.browsers.find(
      (browser: JsonObject) => browser.name === "chromium",
    );
    expect(chromium?.browserVersion).toMatch(/^\d+\./u);
    expect(String(chromiumPackage.version).split(".")[0]).toBe(
      String(chromium.browserVersion).split(".")[0],
    );
  });

  it("exposes only operational identifiers and contains no prohibited services", () => {
    expect(Object.keys(template.Outputs).sort()).toEqual(
      ["FunctionName", "QueueUrl", "Region", "TableName"].sort(),
    );
    expect(template.Outputs).toEqual({
      FunctionName: { Value: { Ref: "ScanFunction" } },
      TableName: { Value: { Ref: "MonitorTable" } },
      QueueUrl: { Value: { Ref: "ScanQueue" } },
      Region: { Value: { Ref: "AWS::Region" } },
    });
    expect(text).not.toMatch(/AWS::EC2::(VPC|NatGateway)/u);
    expect(text).not.toMatch(/AWS::Serverless::Api|AWS::ApiGateway/u);
    expect(text).not.toMatch(/SecretsManager|SecretString|TelegramToken"\s*:/u);
  });
});

describe("SAM deploy example", () => {
  it("is non-deploying, region-pinned, and contains no secret values", () => {
    const config = readFileSync(
      resolve(root, "samconfig.toml.example"),
      "utf8",
    );
    expect(config).toContain('region = "sa-east-1"');
    expect(config).toContain("parameter_overrides");
    expect(config).toContain("TelegramTokenParameterPath=");
    expect(config).toContain("TelegramChatIdParameterPath=");
    expect(config).toContain("SessionKeyParameterPath=");
    expect(config).not.toMatch(/bot\d+:[A-Za-z0-9_-]{20,}/u);
    expect(config).not.toMatch(/[A-Za-z0-9+/]{43}=/u);
  });
});
