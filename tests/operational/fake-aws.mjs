/* global process */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const statePath = process.env.FAKE_AWS_STATE;
if (!statePath) process.exit(2);
const state = existsSync(statePath)
  ? JSON.parse(readFileSync(statePath, "utf8"))
  : { config: null, messages: [], blacklist: {}, calls: [] };
const inputIndex = args.indexOf("--cli-input-json");
let input = null;
let inputPath = null;
if (inputIndex >= 0) {
  inputPath = args[inputIndex + 1].replace(/^file:\/\//, "");
  input = JSON.parse(readFileSync(inputPath, "utf8"));
}
state.calls.push({ args, input, inputPath });
const save = () => writeFileSync(statePath, JSON.stringify(state));
const service = args[0],
  operation = args[1];
if (service === "cloudformation") {
  save();
  const outputs = state.stackOutputs ?? [
    { OutputKey: "TableName", OutputValue: "MonitorTable" },
    { OutputKey: "FunctionName", OutputValue: "prestamype-monitor-scan" },
  ];
  if (args.join(" ").includes("TableName"))
    process.stdout.write(
      `${outputs.find((entry) => entry.OutputKey === "TableName")?.OutputValue ?? "None"}\n`,
    );
  else if (args.join(" ").includes("FunctionName"))
    process.stdout.write(
      `${outputs.find((entry) => entry.OutputKey === "FunctionName")?.OutputValue ?? "None"}\n`,
    );
  else process.stdout.write(JSON.stringify(outputs));
} else if (service === "dynamodb" && operation === "get-item") {
  save();
  process.stdout.write(
    JSON.stringify(state.config ? { Item: state.config } : {}),
  );
} else if (service === "dynamodb" && operation === "put-item") {
  const key = input.Item.SK.S;
  if (state.blacklist[key]) {
    save();
    process.stderr.write("ConditionalCheckFailedException");
    process.exit(255);
  }
  state.blacklist[key] = input.Item;
  save();
  process.stdout.write("{}");
} else if (service === "dynamodb" && operation === "update-item") {
  const expression = input.UpdateExpression;
  if (expression === "REMOVE paused_until, pause_reason") {
    const expectedReason = input.ExpressionAttributeValues[":reason"]?.S;
    if (
      state.failResumeCondition ||
      // Mirrors attribute_exists(PK): resume does not look at enabled.
      !state.config ||
      state.config?.paused_until?.S !== "manual" ||
      state.config?.pause_reason?.S !== expectedReason
    ) {
      save();
      process.stderr.write("ConditionalCheckFailedException");
      process.exit(255);
    }
    delete state.config.paused_until;
    delete state.config.pause_reason;
  } else if (expression === "SET enabled = :enabled") {
    if (
      !state.config ||
      state.config.enabled?.BOOL !== false ||
      !state.config.monitor ||
      !state.config.costLimits ||
      state.config.paused_until
    ) {
      save();
      process.stderr.write("ConditionalCheckFailedException");
      process.exit(255);
    }
    state.config.enabled = { BOOL: true };
  } else if (expression.includes("monitor = :monitor")) {
    state.config ??= { PK: { S: "CONFIG" }, SK: { S: "MONITOR" } };
    state.config.enabled = { BOOL: false };
    state.config.monitor = input.ExpressionAttributeValues[":monitor"];
    state.config.costLimits = input.ExpressionAttributeValues[":cost"];
    delete state.config.activation_owner;
  } else if (expression.includes("SET enabled = :disabled")) {
    state.config.enabled = { BOOL: false };
  }
  save();
  process.stdout.write("{}");
} else if (service === "lambda" && operation === "invoke") {
  if (state.failSend) {
    save();
    process.exit(9);
  }
  const payloadArgument = args[args.indexOf("--payload") + 1] ?? "";
  state.messages.push({
    MessageBody: payloadArgument.startsWith("fileb://")
      ? readFileSync(payloadArgument.slice("fileb://".length), "utf8")
      : payloadArgument,
  });
  save();
  process.stdout.write('{"StatusCode":202}');
} else {
  save();
  process.exit(3);
}
