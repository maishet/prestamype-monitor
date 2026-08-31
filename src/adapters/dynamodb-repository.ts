import { createHash } from "node:crypto";

import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { MonitorRepository, SessionStore } from "../application/ports.js";
import type {
  BlacklistEntry,
  EncryptedSession,
  Evaluation,
  Opportunity,
  OpportunityFingerprintRecord,
  OpportunityPersistenceMetadata,
} from "../domain/types.js";

export type DynamoCommand =
  PutCommand | GetCommand | QueryCommand | UpdateCommand | DeleteCommand;

export interface DynamoDocumentClientLike {
  send(
    command: DynamoCommand,
    options?: { abortSignal?: AbortSignal },
  ): Promise<unknown>;
}

export interface RepositoryLogger {
  info?(message: string): void;
  warn?(message: string): void;
  error?(message: string): void;
}

export interface MonthlyUsageIncrement {
  readonly invocations?: number;
  readonly durationMs?: number;
  readonly scans?: number;
}

export interface MonthlyUsage {
  readonly month: string;
  readonly invocations: number;
  readonly durationMs: number;
  readonly scans: number;
}

export class DynamoRepositoryError extends Error {
  readonly metadata?: DynamoErrorMetadata;

  constructor(metadata?: DynamoErrorMetadata) {
    super("DynamoDB repository operation failed");
    this.name = "DynamoRepositoryError";
    if (metadata !== undefined) this.metadata = Object.freeze({ ...metadata });
  }
}

export interface DynamoErrorMetadata {
  readonly name?: string;
  readonly statusCode?: number;
  readonly requestId?: string;
}

export interface DynamoRepositoryOptions {
  readonly client: DynamoDocumentClientLike;
  readonly tableName: string;
  readonly clock?: () => Date;
  readonly logger?: RepositoryLogger;
  readonly opportunityIndexName?: string;
}

const LOCK_KEY = { PK: "LOCK#SCANNER", SK: "LOCK#SCANNER" } as const;
const SESSION_KEY = { PK: "SESSION", SK: "PRESTAMYPE" } as const;
const CONFIG_KEY = { PK: "CONFIG", SK: "MONITOR" } as const;
const MAX_ID_LENGTH = 1_024;
const MAX_ALERT_KEY_LENGTH = 16_384;
const MAX_OWNER_LENGTH = 512;
const MAX_BLACKLIST_ENTRIES = 10_000;
const MAX_ITEM_BYTES = 380 * 1_024;
const MAX_READ_PAGES = 1_000;
const MAX_PK_BYTES = 2_048;
const MAX_SK_BYTES = 1_024;
const SAFE_AWS_ERROR_NAMES = new Set([
  "AbortError",
  "AccessDeniedException",
  "InternalServerError",
  "ProvisionedThroughputExceededException",
  "ResourceNotFoundException",
  "ThrottlingException",
  "ValidationException",
]);
const RESERVED_ITEM_FIELDS = ["PK", "SK", "GSI1PK", "GSI1SK"] as const;

function invalidInput(): DynamoRepositoryError {
  return new DynamoRepositoryError();
}

function assertBounded(value: string, maximum: number): void {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    Buffer.byteLength(value, "utf8") > maximum
  )
    throw invalidInput();
}

function dynamoKey(PK: string, SK: string): { PK: string; SK: string } {
  assertBounded(PK, MAX_PK_BYTES);
  assertBounded(SK, MAX_SK_BYTES);
  return { PK, SK };
}

function rejectReservedFields(
  value: object,
  fields: readonly string[] = RESERVED_ITEM_FIELDS,
): void {
  for (const field of fields) {
    if (Object.getOwnPropertyDescriptor(value, field) !== undefined)
      throw invalidInput();
  }
}

function assertFinalItemKeys(item: Record<string, unknown>): void {
  if (typeof item.PK !== "string" || typeof item.SK !== "string")
    throw invalidInput();
  dynamoKey(item.PK, item.SK);
  if (item.GSI1PK !== undefined || item.GSI1SK !== undefined) {
    if (typeof item.GSI1PK !== "string" || typeof item.GSI1SK !== "string")
      throw invalidInput();
    dynamoKey(item.GSI1PK, item.GSI1SK);
  }
}

function assertEpoch(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw invalidInput();
}

function assertSerializable(value: unknown, seen = new Set<object>()): void {
  if (
    value === undefined ||
    typeof value === "function" ||
    typeof value === "symbol" ||
    typeof value === "bigint"
  )
    throw invalidInput();
  if (typeof value === "number" && !Number.isFinite(value))
    throw invalidInput();
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) throw invalidInput();
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertSerializable(item, seen);
  } else {
    for (const item of Object.values(value)) assertSerializable(item, seen);
  }
  seen.delete(value);
}

function assertDynamoSerializable(value: unknown): void {
  assertSerializable(value);
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_ITEM_BYTES)
    throw invalidInput();
}

function assertNonnegativeInteger(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw invalidInput();
}

function assertOpportunityIntegers(opportunity: Opportunity): void {
  for (const value of [
    opportunity.totalAmountCents,
    opportunity.fundedAmountCents,
    opportunity.remainingAmountCents,
  ])
    assertNonnegativeInteger(value);
  for (const history of [
    opportunity.debtorHistory,
    opportunity.supplierHistory,
  ]) {
    if (history === null) continue;
    for (const value of [
      history.totalAuctions,
      history.paidOnTime,
      history.paidLate,
      history.currentOnTime,
      history.overdue,
    ])
      assertNonnegativeInteger(value);
    if (history.historicalAmountCents !== null)
      assertNonnegativeInteger(history.historicalAmountCents);
  }
}

function isConditionalFailure(error: unknown): boolean {
  try {
    return (
      typeof error === "object" &&
      error !== null &&
      "name" in error &&
      error.name === "ConditionalCheckFailedException"
    );
  } catch {
    return false;
  }
}

function wrap(error: unknown): never {
  try {
    if (error instanceof DynamoRepositoryError) throw error;
  } catch (candidate) {
    if (candidate instanceof DynamoRepositoryError) throw candidate;
    throw new DynamoRepositoryError();
  }
  const ownData = (
    value: unknown,
    key: string,
  ): { safe: boolean; value?: unknown } => {
    try {
      if (typeof value !== "object" || value === null) return { safe: true };
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined) return { safe: true };
      if (!("value" in descriptor)) return { safe: false };
      return { safe: true, value: descriptor.value };
    } catch {
      return { safe: false };
    }
  };
  const nameRead = ownData(error, "name");
  const metadataRead = ownData(error, "$metadata");
  if (!nameRead.safe || !metadataRead.safe) throw new DynamoRepositoryError();
  const statusRead = ownData(metadataRead.value, "httpStatusCode");
  const requestRead = ownData(metadataRead.value, "requestId");
  if (!statusRead.safe || !requestRead.safe) throw new DynamoRepositoryError();
  const name = nameRead.value;
  const status = statusRead.value;
  const requestId = requestRead.value;
  const metadata: DynamoErrorMetadata = {
    ...(typeof name === "string" && SAFE_AWS_ERROR_NAMES.has(name)
      ? { name }
      : {}),
    ...(typeof status === "number" &&
    Number.isInteger(status) &&
    status >= 100 &&
    status <= 599
      ? { statusCode: status }
      : {}),
    ...(typeof requestId === "string" && /^[A-Za-z0-9-]{1,128}$/.test(requestId)
      ? { requestId }
      : {}),
  };
  throw new DynamoRepositoryError(
    Object.keys(metadata).length ? metadata : undefined,
  );
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function outputItem(value: unknown): Record<string, unknown> | undefined {
  return record(record(value)?.Item);
}

function outputItems(value: unknown): readonly Record<string, unknown>[] {
  const items = record(value)?.Items;
  return Array.isArray(items)
    ? items.flatMap((item) => {
        const candidate = record(item);
        return candidate === undefined ? [] : [candidate];
      })
    : [];
}

function alertKey(alertKey: string): { PK: string; SK: string } {
  assertBounded(alertKey, MAX_ALERT_KEY_LENGTH);
  return dynamoKey(
    "ALERT",
    `KEY#${createHash("sha256").update(alertKey, "utf8").digest("hex")}`,
  );
}

function blacklistEntry(
  item: Record<string, unknown>,
): BlacklistEntry | undefined {
  if (
    !(typeof item.taxId === "string" || item.taxId === null) ||
    typeof item.normalizedName !== "string" ||
    typeof item.reason !== "string" ||
    typeof item.source !== "string" ||
    typeof item.createdAt !== "string" ||
    !(item.status === undefined || typeof item.status === "string") ||
    !(
      item.evidence === undefined ||
      item.evidence === null ||
      typeof item.evidence === "string"
    )
  )
    return undefined;
  return {
    taxId: item.taxId,
    normalizedName: item.normalizedName,
    reason: item.reason,
    source: item.source,
    createdAt: item.createdAt,
    ...(item.status === undefined ? {} : { status: item.status }),
    ...(item.evidence === undefined ? {} : { evidence: item.evidence }),
  };
}

export class DynamoRepository implements MonitorRepository, SessionStore {
  readonly #client: DynamoDocumentClientLike;
  readonly #tableName: string;
  readonly #clock: () => Date;
  readonly #opportunityIndexName: string;

  constructor(options: DynamoRepositoryOptions) {
    if (!/^[A-Za-z0-9_.-]{3,255}$/.test(options.tableName))
      throw invalidInput();
    this.#client = options.client;
    this.#tableName = options.tableName;
    this.#clock = options.clock ?? (() => new Date());
    this.#opportunityIndexName =
      options.opportunityIndexName ?? "EntityTypeIndex";
    if (!/^[A-Za-z0-9_.-]{3,255}$/.test(this.#opportunityIndexName))
      throw invalidInput();
    void options.logger;
  }

  async #send(command: DynamoCommand, signal?: AbortSignal): Promise<unknown> {
    return await this.#client.send(
      command,
      signal === undefined ? undefined : { abortSignal: signal },
    );
  }

  async acquireLock(owner: string, ttlEpochSeconds: number): Promise<boolean> {
    assertBounded(owner, MAX_OWNER_LENGTH);
    assertEpoch(ttlEpochSeconds);
    const now = Math.floor(this.#clock().getTime() / 1_000);
    try {
      await this.#send(
        new PutCommand({
          TableName: this.#tableName,
          Item: { ...LOCK_KEY, owner, expiresAt: ttlEpochSeconds },
          ConditionExpression: "attribute_not_exists(PK) OR expiresAt <= :now",
          ExpressionAttributeValues: { ":now": now },
        }),
      );
      return true;
    } catch (error) {
      if (isConditionalFailure(error)) return false;
      return wrap(error);
    }
  }

  async releaseLock(owner: string): Promise<void> {
    assertBounded(owner, MAX_OWNER_LENGTH);
    try {
      await this.#send(
        new DeleteCommand({
          TableName: this.#tableName,
          Key: LOCK_KEY,
          ConditionExpression: "#owner = :owner",
          ExpressionAttributeNames: { "#owner": "owner" },
          ExpressionAttributeValues: { ":owner": owner },
        }),
      );
    } catch (error) {
      if (isConditionalFailure(error)) return;
      wrap(error);
    }
  }

  async claimScheduleSlot(
    owner: string,
    expiresAtEpochSeconds: number,
  ): Promise<boolean> {
    assertBounded(owner, MAX_OWNER_LENGTH);
    assertEpoch(expiresAtEpochSeconds);
    const now = Math.floor(this.#clock().getTime() / 1_000);
    const digest = createHash("sha256").update(owner, "utf8").digest("hex");
    const key = {
      PK: `SCHEDULE#MESSAGE#${digest}`,
      SK: `SCHEDULE#MESSAGE#${digest}`,
    };
    try {
      await this.#send(
        new PutCommand({
          TableName: this.#tableName,
          Item: { ...key, owner, expiresAt: expiresAtEpochSeconds },
          ConditionExpression: "attribute_not_exists(PK) OR expiresAt <= :now",
          ExpressionAttributeValues: { ":now": now },
        }),
      );
      return true;
    } catch (error) {
      if (isConditionalFailure(error)) return false;
      return wrap(error);
    }
  }

  async releaseScheduleSlot(owner: string): Promise<void> {
    assertBounded(owner, MAX_OWNER_LENGTH);
    const digest = createHash("sha256").update(owner, "utf8").digest("hex");
    const key = {
      PK: `SCHEDULE#MESSAGE#${digest}`,
      SK: `SCHEDULE#MESSAGE#${digest}`,
    };
    try {
      await this.#send(
        new DeleteCommand({
          TableName: this.#tableName,
          Key: key,
          ConditionExpression: "#owner = :owner",
          ExpressionAttributeNames: { "#owner": "owner" },
          ExpressionAttributeValues: { ":owner": owner },
        }),
      );
    } catch (error) {
      if (isConditionalFailure(error)) return;
      wrap(error);
    }
  }

  async getBlacklist(): Promise<readonly BlacklistEntry[]> {
    try {
      const unique = new Map<string, BlacklistEntry>();
      let exclusiveStartKey: Record<string, unknown> | undefined;
      let pageCount = 0;
      do {
        if (++pageCount > MAX_READ_PAGES) throw invalidInput();
        const result = await this.#send(
          new QueryCommand({
            TableName: this.#tableName,
            KeyConditionExpression: "PK = :pk",
            ExpressionAttributeValues: { ":pk": "BLACKLIST" },
            ConsistentRead: false,
            ...(exclusiveStartKey === undefined
              ? {}
              : { ExclusiveStartKey: exclusiveStartKey }),
          }),
        );
        for (const item of outputItems(result)) {
          const entry = blacklistEntry(item);
          if (entry === undefined) continue;
          const identity =
            entry.taxId === null
              ? `NAME#${entry.normalizedName}`
              : `RUC#${entry.taxId}`;
          if (!unique.has(identity)) unique.set(identity, entry);
        }
        exclusiveStartKey = record(record(result)?.LastEvaluatedKey);
      } while (exclusiveStartKey !== undefined);
      return [...unique.values()];
    } catch (error) {
      return wrap(error);
    }
  }

  async addBlacklistEntries(entries: readonly BlacklistEntry[]): Promise<void> {
    if (entries.length > MAX_BLACKLIST_ENTRIES) throw invalidInput();
    try {
      const prepared = entries.map((entry) => {
        rejectReservedFields(entry);
        const payload = { ...entry };
        assertDynamoSerializable(payload);
        assertBounded(entry.normalizedName, MAX_ID_LENGTH);
        const identities = [
          ...(entry.taxId === null ? [] : [`RUC#${entry.taxId}`]),
          `NAME#${entry.normalizedName}`,
        ];
        const items = identities.map((SK) => {
          const item = { ...payload, ...dynamoKey("BLACKLIST", SK) };
          assertDynamoSerializable(item);
          assertFinalItemKeys(item);
          return item;
        });
        return items;
      });
      for (const items of prepared) {
        for (const item of items) {
          assertFinalItemKeys(item);
          await this.#send(
            new PutCommand({
              TableName: this.#tableName,
              Item: item,
              ConditionExpression: "attribute_not_exists(PK)",
            }),
          ).catch((error: unknown) => {
            if (!isConditionalFailure(error)) throw error;
          });
        }
      }
    } catch (error) {
      wrap(error);
    }
  }

  async getOpportunityFingerprints(): Promise<
    Readonly<Record<string, OpportunityFingerprintRecord>>
  > {
    try {
      const fingerprints: Record<string, OpportunityFingerprintRecord> =
        Object.create(null) as Record<string, OpportunityFingerprintRecord>;
      let exclusiveStartKey: Record<string, unknown> | undefined;
      let pageCount = 0;
      do {
        if (++pageCount > MAX_READ_PAGES) throw invalidInput();
        const result = await this.#send(
          new QueryCommand({
            TableName: this.#tableName,
            IndexName: this.#opportunityIndexName,
            KeyConditionExpression: "GSI1PK = :opportunity",
            ExpressionAttributeValues: { ":opportunity": "OPPORTUNITY" },
            ProjectionExpression: "id, visibleFingerprint, detailCheckedAt",
            ...(exclusiveStartKey === undefined
              ? {}
              : { ExclusiveStartKey: exclusiveStartKey }),
          }),
        );
        for (const item of outputItems(result)) {
          if (
            typeof item.id === "string" &&
            typeof item.visibleFingerprint === "string" &&
            typeof item.detailCheckedAt === "string"
          ) {
            fingerprints[item.id] = {
              visibleFingerprint: item.visibleFingerprint,
              detailCheckedAt: item.detailCheckedAt,
            };
          }
        }
        exclusiveStartKey = record(record(result)?.LastEvaluatedKey);
      } while (exclusiveStartKey !== undefined);
      return fingerprints;
    } catch (error) {
      return wrap(error);
    }
  }

  async saveOpportunity(
    opportunity: Opportunity,
    evaluation: Evaluation,
    metadata: OpportunityPersistenceMetadata,
  ): Promise<void> {
    try {
      assertBounded(opportunity.id, MAX_ID_LENGTH);
      assertOpportunityIntegers(opportunity);
      const primaryKey = dynamoKey(
        `OPPORTUNITY#${opportunity.id}`,
        `OPPORTUNITY#${opportunity.id}`,
      );
      const indexKey = dynamoKey("OPPORTUNITY", opportunity.id);
      const item = {
        ...primaryKey,
        GSI1PK: indexKey.PK,
        GSI1SK: indexKey.SK,
        id: opportunity.id,
        opportunity,
        evaluation,
        visibleFingerprint: metadata.visibleFingerprint,
        detailCheckedAt: metadata.detailCheckedAt,
      };
      assertDynamoSerializable(item);
      assertFinalItemKeys(item);
      await this.#send(
        new PutCommand({
          TableName: this.#tableName,
          Item: item,
        }),
      );
    } catch (error) {
      wrap(error);
    }
  }

  async claimAlert(
    key: string,
    owner: string,
    leaseUntilEpochSeconds: number,
  ): Promise<boolean> {
    assertBounded(owner, MAX_OWNER_LENGTH);
    assertEpoch(leaseUntilEpochSeconds);
    const keys = alertKey(key);
    const now = Math.floor(this.#clock().getTime() / 1_000);
    try {
      await this.#send(
        new PutCommand({
          TableName: this.#tableName,
          Item: {
            ...keys,
            alertKey: key,
            owner,
            leaseUntil: leaseUntilEpochSeconds,
          },
          ConditionExpression:
            "attribute_not_exists(PK) OR (attribute_not_exists(completedAt) AND leaseUntil <= :now)",
          ExpressionAttributeValues: { ":now": now },
        }),
      );
      return true;
    } catch (error) {
      if (isConditionalFailure(error)) return false;
      return wrap(error);
    }
  }

  async completeAlert(key: string, owner: string): Promise<void> {
    assertBounded(owner, MAX_OWNER_LENGTH);
    try {
      await this.#send(
        new UpdateCommand({
          TableName: this.#tableName,
          Key: alertKey(key),
          UpdateExpression: "SET completedAt = :completedAt REMOVE leaseUntil",
          ConditionExpression:
            "#owner = :owner AND attribute_not_exists(completedAt)",
          ExpressionAttributeNames: { "#owner": "owner" },
          ExpressionAttributeValues: {
            ":owner": owner,
            ":completedAt": this.#clock().toISOString(),
          },
        }),
      );
    } catch (error) {
      if (isConditionalFailure(error)) return;
      wrap(error);
    }
  }

  async releaseAlertClaim(key: string, owner: string): Promise<void> {
    assertBounded(owner, MAX_OWNER_LENGTH);
    try {
      await this.#send(
        new DeleteCommand({
          TableName: this.#tableName,
          Key: alertKey(key),
          ConditionExpression:
            "#owner = :owner AND attribute_not_exists(completedAt)",
          ExpressionAttributeNames: { "#owner": "owner" },
          ExpressionAttributeValues: { ":owner": owner },
        }),
      );
    } catch (error) {
      if (isConditionalFailure(error)) return;
      wrap(error);
    }
  }

  async loadEncryptedSession(options?: {
    signal: AbortSignal;
  }): Promise<EncryptedSession | null> {
    try {
      const result = await this.#send(
        new GetCommand({
          TableName: this.#tableName,
          Key: SESSION_KEY,
          ConsistentRead: true,
        }),
        options?.signal,
      );
      const item = outputItem(result);
      if (item === undefined) return null;
      if (
        item.schemaVersion !== 1 ||
        typeof item.iv !== "string" ||
        typeof item.ciphertext !== "string" ||
        typeof item.authTag !== "string"
      )
        throw invalidInput();
      return {
        schemaVersion: 1,
        iv: item.iv,
        ciphertext: item.ciphertext,
        authTag: item.authTag,
      };
    } catch (error) {
      return wrap(error);
    }
  }

  async saveEncryptedSession(
    payload: EncryptedSession,
    options?: { signal: AbortSignal },
  ): Promise<void> {
    try {
      rejectReservedFields(payload);
      const sessionPayload = { ...payload };
      assertDynamoSerializable(sessionPayload);
      if (payload.schemaVersion !== 1) throw invalidInput();
      const item = { ...sessionPayload, ...SESSION_KEY };
      assertDynamoSerializable(item);
      assertFinalItemKeys(item);
      await this.#send(
        new PutCommand({
          TableName: this.#tableName,
          Item: item,
        }),
        options?.signal,
      );
    } catch (error) {
      wrap(error);
    }
  }

  async loadConfig<T extends object>(): Promise<T | null> {
    try {
      const item = outputItem(
        await this.#send(
          new GetCommand({ TableName: this.#tableName, Key: CONFIG_KEY }),
        ),
      );
      if (item === undefined) return null;
      const { PK: _pk, SK: _sk, ...config } = item;
      void _pk;
      void _sk;
      return config as T;
    } catch (error) {
      return wrap(error);
    }
  }

  async saveConfig<T extends object>(config: T): Promise<void> {
    try {
      rejectReservedFields(config);
      const configPayload = { ...config };
      assertDynamoSerializable(configPayload);
      const item = { ...configPayload, ...CONFIG_KEY };
      assertDynamoSerializable(item);
      assertFinalItemKeys(item);
      await this.#send(
        new PutCommand({
          TableName: this.#tableName,
          Item: item,
        }),
      );
    } catch (error) {
      wrap(error);
    }
  }

  async incrementMonthlyUsage(
    month: string,
    increment: MonthlyUsageIncrement,
  ): Promise<MonthlyUsage> {
    if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month)) throw invalidInput();
    const invocations = increment.invocations ?? 0;
    const durationMs = increment.durationMs ?? 0;
    const scans = increment.scans ?? 0;
    for (const value of [invocations, durationMs, scans]) assertEpoch(value);
    try {
      const result = record(
        await this.#send(
          new UpdateCommand({
            TableName: this.#tableName,
            Key: { PK: `USAGE#${month}`, SK: `USAGE#${month}` },
            UpdateExpression:
              "ADD invocations :invocations, durationMs :durationMs, scans :scans",
            ExpressionAttributeValues: {
              ":invocations": invocations,
              ":durationMs": durationMs,
              ":scans": scans,
            },
            ReturnValues: "ALL_NEW",
          }),
        ),
      );
      const attributes = record(result?.Attributes) ?? {};
      return {
        month,
        invocations:
          typeof attributes.invocations === "number"
            ? attributes.invocations
            : 0,
        durationMs:
          typeof attributes.durationMs === "number" ? attributes.durationMs : 0,
        scans: typeof attributes.scans === "number" ? attributes.scans : 0,
      };
    } catch (error) {
      return wrap(error);
    }
  }

  async loadMonthlyUsage(month: string): Promise<MonthlyUsage> {
    if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month)) throw invalidInput();
    try {
      const item =
        outputItem(
          await this.#send(
            new GetCommand({
              TableName: this.#tableName,
              Key: { PK: `USAGE#${month}`, SK: `USAGE#${month}` },
            }),
          ),
        ) ?? {};
      return {
        month,
        invocations:
          typeof item.invocations === "number" ? item.invocations : 0,
        durationMs: typeof item.durationMs === "number" ? item.durationMs : 0,
        scans: typeof item.scans === "number" ? item.scans : 0,
      };
    } catch (error) {
      return wrap(error);
    }
  }
}
