import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";

import {
  DynamoRepositoryError,
  DynamoRepository,
} from "../../src/adapters/dynamodb-repository.js";
import type { DynamoCommand } from "../../src/adapters/dynamodb-repository.js";
import type {
  BlacklistEntry,
  EncryptedSession,
  Evaluation,
  Opportunity,
} from "../../src/domain/types.js";

const tableName = "PrestamypeState";

function client(...responses: unknown[]) {
  return {
    send: vi.fn(
      async (
        _command: DynamoCommand,
        _options?: { abortSignal?: AbortSignal },
      ) => {
        void _command;
        void _options;
        return responses.shift() ?? {};
      },
    ),
  };
}

function conditionalFailure(): Error {
  return Object.assign(new Error("secret conditional detail"), {
    name: "ConditionalCheckFailedException",
  });
}

const opportunity: Opportunity = {
  id: "opp-1",
  auctionCode: "M5dGmP0G",
  commercialName: "CLIENTE",
  investmentType: "Factoring",
  url: "https://prestamype.com/opportunities/opp-1",
  supplier: { legalName: "Proveedor SAC", taxId: "20123456789" },
  debtor: { legalName: "Deudor SAC", taxId: "20987654321" },
  risk: "A",
  currency: "PEN",
  annualReturnPct: 18.5,
  monthlyReturnPct: 1.4,
  totalAmountCents: 100_00,
  fundedAmountCents: 30_00,
  remainingAmountCents: 70_00,
  closesAt: "2026-09-01T00:00:00.000Z",
  dueAt: null,
  debtorHistory: null,
  supplierHistory: null,
  collectionProblem: false,
};
const evaluation: Evaluation = {
  decision: "INVEST",
  score: 81,
  components: { return: 20 },
  reasons: ["Buen retorno"],
  warnings: [],
};

describe("DynamoRepository", () => {
  it("acquires an absent or expired lock with a real PutCommand", async () => {
    const aws = client({});
    const repository = new DynamoRepository({
      client: aws,
      tableName,
      clock: () => new Date("2026-08-30T12:00:00.000Z"),
    });

    await expect(
      repository.acquireLock("worker-1", 2_000_000_000),
    ).resolves.toBe(true);
    const command = aws.send.mock.calls[0]![0];
    expect(command).toBeInstanceOf(PutCommand);
    expect(command.input).toMatchObject({
      TableName: tableName,
      Item: {
        PK: "LOCK#SCANNER",
        SK: "LOCK#SCANNER",
        owner: "worker-1",
        expiresAt: 2_000_000_000,
      },
      ConditionExpression: "attribute_not_exists(PK) OR expiresAt <= :now",
      ExpressionAttributeValues: { ":now": 1_788_091_200 },
    });
  });

  it("returns false only for a conditional lock collision and wraps other errors", async () => {
    const collision = client();
    collision.send.mockRejectedValueOnce(conditionalFailure());
    await expect(
      new DynamoRepository({ client: collision, tableName }).acquireLock(
        "a",
        2,
      ),
    ).resolves.toBe(false);

    const failed = client();
    const canary = "CANARY-table-ciphertext-cookie";
    const cause = Object.assign(new Error(canary), {
      name: "ResourceNotFoundException",
      secret: canary,
      $metadata: { httpStatusCode: 404, requestId: "req-123" },
    });
    failed.send.mockRejectedValueOnce(cause);
    const failure = await new DynamoRepository({
      client: failed,
      tableName,
    })
      .acquireLock("a", 2)
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({
      name: "DynamoRepositoryError",
      message: "DynamoDB repository operation failed",
      metadata: {
        name: "ResourceNotFoundException",
        statusCode: 404,
        requestId: "req-123",
      },
    });
    expect(
      [
        String(failure),
        JSON.stringify(failure),
        JSON.stringify((failure as DynamoRepositoryError).metadata),
      ].join(" "),
    ).not.toContain(canary);
    expect((failure as Error).cause).toBeUndefined();
    await expect(
      new DynamoRepository({ client: failed, tableName }).acquireLock("a", 2),
    ).resolves.toBe(true);
  });

  it("returns false for a conditional alert duplicate and wraps other claim errors", async () => {
    const aws = client();
    aws.send.mockRejectedValueOnce(conditionalFailure());
    const repository = new DynamoRepository({ client: aws, tableName });
    await expect(
      repository.claimAlert("alert", "owner", 2_000_000_000),
    ).resolves.toBe(false);

    const cause = new Error("sensitive backend detail");
    aws.send.mockRejectedValueOnce(cause);
    const failure = await repository
      .claimAlert("alert", "owner", 2_000_000_000)
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({
      name: "DynamoRepositoryError",
      message: "DynamoDB repository operation failed",
    });
    expect((failure as Error).cause).toBeUndefined();
  });

  it("releases only its own lock and treats owner mismatch as a no-op", async () => {
    const aws = client({});
    const repository = new DynamoRepository({ client: aws, tableName });
    await repository.releaseLock("worker-1");
    const command = aws.send.mock.calls[0]![0];
    expect(command).toBeInstanceOf(DeleteCommand);
    expect(command.input).toMatchObject({
      Key: { PK: "LOCK#SCANNER", SK: "LOCK#SCANNER" },
      ConditionExpression: "#owner = :owner",
      ExpressionAttributeNames: { "#owner": "owner" },
      ExpressionAttributeValues: { ":owner": "worker-1" },
    });

    aws.send.mockRejectedValueOnce(conditionalFailure());
    await expect(repository.releaseLock("other")).resolves.toBeUndefined();
  });

  it.each(["top", "name", "metadata", "status", "request"] as const)(
    "wraps hostile Dynamo error getters on %s without leaking or masking",
    async (kind) => {
      const canary = `SECRET-${kind}`;
      let hostile: object;
      if (kind === "top") {
        hostile = new Proxy(
          {},
          {
            getOwnPropertyDescriptor() {
              throw new Error(canary);
            },
            getPrototypeOf() {
              throw new Error(canary);
            },
          },
        );
      } else if (kind === "name") {
        hostile = {};
        Object.defineProperty(hostile, "name", {
          get() {
            throw new Error(canary);
          },
        });
      } else {
        const metadata = {};
        const field = kind === "status" ? "httpStatusCode" : "requestId";
        if (kind === "metadata")
          Object.defineProperty(metadata, "unused", { value: true });
        else
          Object.defineProperty(metadata, field, {
            get() {
              throw new Error(canary);
            },
          });
        hostile = {};
        if (kind === "metadata")
          Object.defineProperty(hostile, "$metadata", {
            get() {
              throw new Error(canary);
            },
          });
        else Object.defineProperty(hostile, "$metadata", { value: metadata });
      }
      const aws = client();
      aws.send.mockRejectedValue(hostile);
      const repository = new DynamoRepository({ client: aws, tableName });
      const failures = await Promise.all([
        repository
          .acquireLock("owner-1", 2_000_000_000)
          .catch((error: unknown) => error),
        repository.releaseLock("owner-1").catch((error: unknown) => error),
        repository.getBlacklist().catch((error: unknown) => error),
        repository
          .claimAlert("alert-1", "owner-1", 2_000_000_000)
          .catch((error: unknown) => error),
        repository
          .completeAlert("alert-1", "owner-1")
          .catch((error: unknown) => error),
      ]);
      for (const failure of failures) {
        expect(failure).toBeInstanceOf(DynamoRepositoryError);
        expect((failure as Error).cause).toBeUndefined();
        expect((failure as DynamoRepositoryError).metadata).toBeUndefined();
        expect(JSON.stringify(failure)).not.toContain(canary);
      }
    },
  );

  it("queries the deterministic blacklist partition and maps exact records", async () => {
    const entry: BlacklistEntry = {
      taxId: "20123456789",
      normalizedName: "LERIBE",
      reason: "Cobranza",
      source: "portfolio",
      createdAt: "2026-08-30T00:00:00.000Z",
      status: "late",
      evidence: "invoice 1",
    };
    const aws = client({
      Items: [{ PK: "BLACKLIST", SK: "RUC#20123456789", ...entry }],
    });
    const repository = new DynamoRepository({ client: aws, tableName });
    await expect(repository.getBlacklist()).resolves.toEqual([entry]);
    const command = aws.send.mock.calls[0]![0];
    expect(command).toBeInstanceOf(QueryCommand);
    expect(command.input).toMatchObject({
      KeyConditionExpression: "PK = :pk",
      ExpressionAttributeValues: { ":pk": "BLACKLIST" },
      ConsistentRead: false,
    });
  });

  it("adds blacklist identities idempotently without dropping evidence", async () => {
    const aws = client({}, {});
    const repository = new DynamoRepository({ client: aws, tableName });
    const entry: BlacklistEntry = {
      taxId: "20123456789",
      normalizedName: "LERIBE",
      reason: "Cobranza",
      source: "portfolio",
      createdAt: "2026-08-30T00:00:00.000Z",
      evidence: "evidence",
    };
    await repository.addBlacklistEntries([entry]);
    expect(aws.send).toHaveBeenCalledTimes(2);
    for (const [call] of aws.send.mock.calls) {
      expect(call).toBeInstanceOf(PutCommand);
      expect((call as PutCommand).input.ConditionExpression).toBe(
        "attribute_not_exists(PK)",
      );
      expect((call as PutCommand).input.Item).toMatchObject({
        PK: "BLACKLIST",
        evidence: "evidence",
      });
    }
    expect(
      aws.send.mock.calls.map(
        ([command]) => (command as PutCommand).input.Item?.SK,
      ),
    ).toEqual(["RUC#20123456789", "NAME#LERIBE"]);
  });

  it("stores GSI keys and queries paginated structured opportunity fingerprints without scanning", async () => {
    const aws = client(
      {},
      {
        Items: [
          {
            PK: "OPPORTUNITY#opp-1",
            SK: "OPPORTUNITY#opp-1",
            id: "opp-1",
            visibleFingerprint: "fp",
            detailCheckedAt: "2026-08-30T00:00:00.000Z",
          },
        ],
        LastEvaluatedKey: { PK: "OPPORTUNITY#opp-1", SK: "OPPORTUNITY#opp-1" },
      },
      { Items: [] },
    );
    const repository = new DynamoRepository({ client: aws, tableName });
    await repository.saveOpportunity(opportunity, evaluation, {
      visibleFingerprint: "fp",
      detailCheckedAt: "2026-08-30T00:00:00.000Z",
    });
    expect(aws.send.mock.calls[0]![0]).toBeInstanceOf(PutCommand);
    expect((aws.send.mock.calls[0]![0] as PutCommand).input.Item).toMatchObject(
      {
        PK: "OPPORTUNITY#opp-1",
        SK: "OPPORTUNITY#opp-1",
        GSI1PK: "OPPORTUNITY",
        GSI1SK: "opp-1",
        opportunity,
        evaluation,
        visibleFingerprint: "fp",
      },
    );
    await expect(repository.getOpportunityFingerprints()).resolves.toEqual({
      "opp-1": {
        visibleFingerprint: "fp",
        detailCheckedAt: "2026-08-30T00:00:00.000Z",
        // Written before the field existed, so it reads as never alerted and
        // simply earns one more detail read.
        alerted: false,
      },
    });
    const firstQuery = aws.send.mock.calls[1]![0];
    expect(firstQuery).toBeInstanceOf(QueryCommand);
    expect((firstQuery as QueryCommand).input).toMatchObject({
      IndexName: "EntityTypeIndex",
      KeyConditionExpression: "GSI1PK = :opportunity",
      ExpressionAttributeValues: { ":opportunity": "OPPORTUNITY" },
    });
    expect(
      (aws.send.mock.calls[2]![0] as QueryCommand).input.ExclusiveStartKey,
    ).toEqual({
      PK: "OPPORTUNITY#opp-1",
      SK: "OPPORTUNITY#opp-1",
    });
  });

  it("claims only absent or expired alerts, including expiry exactly at now", async () => {
    const aws = client({});
    const repository = new DynamoRepository({
      client: aws,
      tableName,
      clock: () => new Date("2026-08-30T12:00:00Z"),
    });
    await expect(
      repository.claimAlert("opaque/# key", "worker", 2_000_000_000),
    ).resolves.toBe(true);
    const command = aws.send.mock.calls[0]![0];
    expect(command).toBeInstanceOf(PutCommand);
    const input = (command as PutCommand).input;
    expect(input.Item?.PK).toBe("ALERT");
    expect(input.Item?.SK).toMatch(/^KEY#[a-f0-9]{64}$/);
    expect(input.Item?.alertKey).toBe("opaque/# key");
    expect(input.ConditionExpression).toContain("attribute_not_exists(PK)");
    expect(input.ConditionExpression).toBe(
      "attribute_not_exists(PK) OR (attribute_not_exists(completedAt) AND leaseUntil <= :now)",
    );
    expect(input.ExpressionAttributeNames).toBeUndefined();
    expect(input.ExpressionAttributeValues).toEqual({ ":now": 1_788_091_200 });
  });

  it("blocks redelivery during a live lease even for the same owner", async () => {
    const aws = client();
    aws.send.mockRejectedValueOnce(conditionalFailure());
    const repository = new DynamoRepository({ client: aws, tableName });
    await expect(
      repository.claimAlert("same-alert", "same-owner", 2_000_000_000),
    ).resolves.toBe(false);
    const command = aws.send.mock.calls[0]![0] as PutCommand;
    expect(command.input.ConditionExpression).not.toContain("owner");
  });

  it("completes and releases alerts only for the owner", async () => {
    const aws = client({}, {});
    const repository = new DynamoRepository({ client: aws, tableName });
    await repository.completeAlert("key", "worker");
    expect(aws.send.mock.calls[0]![0]).toBeInstanceOf(UpdateCommand);
    expect(
      (aws.send.mock.calls[0]![0] as UpdateCommand).input.ConditionExpression,
    ).toContain("#owner = :owner");
    await repository.releaseAlertClaim("key", "worker");
    expect(aws.send.mock.calls[1]![0]).toBeInstanceOf(DeleteCommand);
    expect(
      (aws.send.mock.calls[1]![0] as DeleteCommand).input.ConditionExpression,
    ).toContain("attribute_not_exists(completedAt)");
  });

  it("loads and saves encrypted sessions consistently, forwards abort, and never logs ciphertext", async () => {
    const payload: EncryptedSession = {
      schemaVersion: 1,
      iv: "aXY=",
      ciphertext: "SECRET",
      authTag: "dGFn",
    };
    const aws = client(
      { Item: { PK: "SESSION", SK: "PRESTAMYPE", ...payload } },
      {},
    );
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
    const repository = new DynamoRepository({ client: aws, tableName, logger });
    const controller = new AbortController();
    await expect(
      repository.loadEncryptedSession({ signal: controller.signal }),
    ).resolves.toEqual(payload);
    expect(aws.send.mock.calls[0]![0]).toBeInstanceOf(GetCommand);
    expect(aws.send.mock.calls[0]![0].input).toMatchObject({
      ConsistentRead: true,
      Key: { PK: "SESSION", SK: "PRESTAMYPE" },
    });
    expect(aws.send.mock.calls[0]![1]).toEqual({
      abortSignal: controller.signal,
    });
    await repository.saveEncryptedSession(payload, {
      signal: controller.signal,
    });
    expect(aws.send.mock.calls[1]![1]).toEqual({
      abortSignal: controller.signal,
    });
    expect(
      JSON.stringify([
        logger.error.mock.calls,
        logger.warn.mock.calls,
        logger.info.mock.calls,
      ]),
    ).not.toContain("SECRET");
  });

  it("reads/writes config and atomically increments typed monthly usage", async () => {
    const aws = client(
      { Item: { PK: "CONFIG", SK: "MONITOR", enabled: true } },
      {},
      {
        Attributes: {
          invocations: 2,
          durationMs: 1500,
          scans: 1,
          commandGbSeconds: 2.5,
        },
      },
    );
    const repository = new DynamoRepository({ client: aws, tableName });
    await expect(
      repository.loadConfig<{ enabled: boolean }>(),
    ).resolves.toEqual({ enabled: true });
    await repository.saveConfig({ enabled: false });
    const usage = await repository.incrementMonthlyUsage("2026-08", {
      invocations: 1,
      durationMs: 1500,
      scans: 1,
    });
    expect(usage).toEqual({
      commandGbSeconds: 2.5,
      month: "2026-08",
      invocations: 2,
      durationMs: 1500,
      scans: 1,
    });
    const update = aws.send.mock.calls[2]![0];
    expect(update).toBeInstanceOf(UpdateCommand);
    expect((update as UpdateCommand).input.UpdateExpression).toContain(
      "ADD invocations :invocations",
    );
    expect((update as UpdateCommand).input.ReturnValues).toBe("ALL_NEW");
  });

  it("rejects unsafe identifiers and non-finite persisted numbers before AWS calls", async () => {
    const aws = client();
    expect(
      () => new DynamoRepository({ client: aws, tableName: "" }),
    ).toThrow();
    const repository = new DynamoRepository({ client: aws, tableName });
    await expect(
      repository.saveOpportunity(
        { ...opportunity, annualReturnPct: Number.NaN },
        evaluation,
        { visibleFingerprint: "fp", detailCheckedAt: "x" },
      ),
    ).rejects.toBeInstanceOf(DynamoRepositoryError);
    await expect(
      repository.saveOpportunity(
        { ...opportunity, totalAmountCents: 1.5 },
        evaluation,
        { visibleFingerprint: "fp", detailCheckedAt: "x" },
      ),
    ).rejects.toBeInstanceOf(DynamoRepositoryError);
    expect(aws.send).not.toHaveBeenCalled();
  });

  it("enforces Dynamo PK/SK UTF-8 byte limits after adding prefixes", async () => {
    const prefixBytes = Buffer.byteLength("OPPORTUNITY#", "utf8");
    const maximumAsciiId = "a".repeat(1_024 - prefixBytes);
    const aws = client({});
    const repository = new DynamoRepository({ client: aws, tableName });
    await repository.saveOpportunity(
      { ...opportunity, id: maximumAsciiId },
      evaluation,
      { visibleFingerprint: "fp", detailCheckedAt: "x" },
    );
    expect(aws.send).toHaveBeenCalledTimes(1);

    aws.send.mockClear();
    for (const id of [
      `${maximumAsciiId}a`,
      "é".repeat(Math.floor((1_024 - prefixBytes) / 2) + 1),
    ]) {
      await expect(
        repository.saveOpportunity({ ...opportunity, id }, evaluation, {
          visibleFingerprint: "fp",
          detailCheckedAt: "x",
        }),
      ).rejects.toBeInstanceOf(DynamoRepositoryError);
    }
    await expect(
      repository.addBlacklistEntries([
        {
          taxId: "9".repeat(1_021),
          normalizedName: "SAFE",
          reason: "reason",
          source: "source",
          createdAt: "2026-08-30T00:00:00.000Z",
        },
      ]),
    ).rejects.toBeInstanceOf(DynamoRepositoryError);
    expect(aws.send).not.toHaveBeenCalled();
  });

  it("rejects own reserved keys in blacklist, session, and config payloads before send", async () => {
    const aws = client();
    const repository = new DynamoRepository({ client: aws, tableName });
    const maliciousBlacklist = JSON.parse(
      JSON.stringify({
        taxId: "20123456789",
        normalizedName: "SAFE",
        reason: "reason",
        source: "source",
        createdAt: "2026-08-30T00:00:00.000Z",
        PK: "ATTACKER",
      }),
    ) as BlacklistEntry;
    const maliciousSession = {
      schemaVersion: 1,
      iv: "aXY=",
      ciphertext: "ciphertext",
      authTag: "dGFn",
      SK: "ATTACKER",
    } as EncryptedSession;

    await expect(
      repository.addBlacklistEntries([maliciousBlacklist]),
    ).rejects.toBeInstanceOf(DynamoRepositoryError);
    await expect(
      repository.saveEncryptedSession(maliciousSession),
    ).rejects.toBeInstanceOf(DynamoRepositoryError);
    await expect(
      repository.saveConfig({
        enabled: true,
        GSI1PK: "ATTACKER",
        GSI1SK: "ATTACKER",
      }),
    ).rejects.toBeInstanceOf(DynamoRepositoryError);
    expect(aws.send).not.toHaveBeenCalled();
  });

  it("does not evaluate inherited reserved-field getters and still derives final keys", async () => {
    const getter = vi.fn(() => {
      throw new Error("prototype getter must not run");
    });
    const prototype = Object.defineProperty({}, "PK", { get: getter });
    const config = Object.assign(
      Object.create(prototype) as { enabled: boolean },
      {
        enabled: true,
      },
    );
    const aws = client({});
    const repository = new DynamoRepository({ client: aws, tableName });

    await repository.saveConfig(config);

    expect(getter).not.toHaveBeenCalled();
    expect((aws.send.mock.calls[0]![0] as PutCommand).input.Item).toEqual({
      enabled: true,
      PK: "CONFIG",
      SK: "MONITOR",
    });
  });
});
