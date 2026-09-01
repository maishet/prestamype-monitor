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
  if (args.join(" ").includes("TableName"))
    process.stdout.write("MonitorTable\n");
  else if (args.join(" ").includes("QueueUrl"))
    process.stdout.write(
      "https://sqs.sa-east-1.amazonaws.com/123456789012/scan\n",
    );
  else
    process.stdout.write(
      JSON.stringify([
        { OutputKey: "TableName", OutputValue: "MonitorTable" },
        {
          OutputKey: "QueueUrl",
          OutputValue: "https://sqs.sa-east-1.amazonaws.com/123456789012/scan",
        },
      ]),
    );
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
  if (
    expression.includes("activation_owner = :owner") &&
    expression.includes("SET enabled = :enabled")
  ) {
    if (
      !state.config ||
      state.config.enabled?.BOOL !== false ||
      !state.config.monitor ||
      !state.config.costLimits ||
      state.config.activation_owner
    ) {
      save();
      process.stderr.write("ConditionalCheckFailedException");
      process.exit(255);
    }
    state.config.enabled = { BOOL: true };
    state.config.activation_owner = input.ExpressionAttributeValues[":owner"];
  } else if (expression.includes("monitor = :monitor")) {
    state.config ??= { PK: { S: "CONFIG" }, SK: { S: "MONITOR" } };
    state.config.enabled = { BOOL: false };
    state.config.monitor = input.ExpressionAttributeValues[":monitor"];
    state.config.costLimits = input.ExpressionAttributeValues[":cost"];
    delete state.config.activation_owner;
  } else if (expression.includes("SET enabled = :disabled")) {
    if (
      input.ConditionExpression &&
      state.config?.activation_owner?.S !==
        input.ExpressionAttributeValues[":owner"]?.S
    ) {
      save();
      process.stderr.write("ConditionalCheckFailedException");
      process.exit(255);
    }
    state.config.enabled = { BOOL: false };
    delete state.config.activation_owner;
  } else if (expression === "REMOVE activation_owner")
    delete state.config.activation_owner;
  save();
  process.stdout.write("{}");
} else if (service === "sqs" && operation === "send-message") {
  if (state.failSend) {
    save();
    process.exit(9);
  }
  state.messages.push(input);
  save();
  process.stdout.write('{"MessageId":"fake"}');
} else {
  save();
  process.exit(3);
}
