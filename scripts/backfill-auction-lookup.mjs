// One-off for records saved before these keys existed. Safe to re-run.
//  1. Writes the AUCTION#<code> -> id pointers that /analizar reads.
//  2. Moves still-open opportunities to the "C#<close date>#<id>" index sort
//     key that /oportunidades queries (closed ones never show there anyway). The table has 1 RCU / 1 WCU and the scan
// Lambda already uses most of the index reads, so this paces itself: small
// read pages with pauses, and about one write per second. ~15 min for ~900.
import { execFileSync } from "node:child_process";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

const region = "sa-east-1";
const functionName = "prestamype-monitor-commands";
const profileArgs = process.env.AWS_PROFILE
  ? ["--profile", process.env.AWS_PROFILE]
  : [];
const aws = (args) =>
  JSON.parse(
    execFileSync(
      "aws",
      [...args, ...profileArgs, "--region", region, "--output", "json"],
      { encoding: "utf8", windowsHide: true },
    ),
  );
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const AUCTION_CODE = /^[A-Za-z0-9]{4,32}$/;
const limaToday = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Lima",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());

const credentials = aws([
  "configure",
  "export-credentials",
  "--format",
  "process",
]);
const tableName = aws([
  "lambda",
  "get-function-configuration",
  "--function-name",
  functionName,
]).Environment.Variables.TABLE_NAME;
const db = DynamoDBDocumentClient.from(
  new DynamoDBClient({
    region,
    maxAttempts: 8,
    credentials: {
      accessKeyId: credentials.AccessKeyId,
      secretAccessKey: credentials.SecretAccessKey,
      sessionToken: credentials.SessionToken,
    },
  }),
);

let cursor;
let written = 0;
let skipped = 0;
let reindexed = 0;
do {
  const page = await db.send(
    new QueryCommand({
      TableName: tableName,
      IndexName: "EntityTypeIndex",
      KeyConditionExpression: "GSI1PK = :type",
      ExpressionAttributeValues: { ":type": "OPPORTUNITY" },
      ProjectionExpression:
        "PK, SK, GSI1SK, id, opportunity.auctionCode, opportunity.closesAt",
      ExclusiveStartKey: cursor,
      Limit: 25,
    }),
  );
  for (const item of page.Items ?? []) {
    const closeDate = /^\d{4}-\d{2}-\d{2}/.exec(
      item.opportunity?.closesAt ?? "",
    )?.[0];
    if (
      typeof item.id === "string" &&
      closeDate !== undefined &&
      closeDate >= limaToday &&
      !String(item.GSI1SK).startsWith("C#")
    ) {
      await db.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { PK: item.PK, SK: item.SK },
          UpdateExpression: "SET GSI1SK = :sk",
          ConditionExpression: "GSI1SK = :old",
          ExpressionAttributeValues: {
            ":sk": `C#${closeDate}#${item.id}`,
            ":old": item.GSI1SK,
          },
        }),
      );
      reindexed += 1;
      await sleep(4_000); // full-item write: a few WCU on the table and index
    }
    const code = item.opportunity?.auctionCode;
    if (
      typeof item.id !== "string" ||
      typeof code !== "string" ||
      !AUCTION_CODE.test(code)
    ) {
      skipped += 1;
      continue;
    }
    await db.send(
      new PutCommand({
        TableName: tableName,
        Item: { PK: `AUCTION#${code}`, SK: `AUCTION#${code}`, id: item.id },
      }),
    );
    written += 1;
    await sleep(1_100);
  }
  console.log(`pointers=${written} skipped=${skipped} reindexed=${reindexed}`);
  cursor = page.LastEvaluatedKey;
  if (cursor) await sleep(5_000);
} while (cursor);
console.log("Done.");
