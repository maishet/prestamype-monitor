/* global process, Buffer, AbortController */
import { pathToFileURL } from "node:url";

const PATH = /^\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/;
const REGION = /^[a-z]{2}-[a-z]+-\d$/;

export async function putSecureParameters(input, client) {
  if (!input || typeof input !== "object" || !REGION.test(input.region ?? ""))
    throw new Error("Invalid secure parameter request");
  if (!Array.isArray(input.parameters) || input.parameters.length !== 3)
    throw new Error("Invalid secure parameter request");
  const names = new Set();
  for (const parameter of input.parameters) {
    if (
      !PATH.test(parameter?.name ?? "") ||
      typeof parameter?.value !== "string" ||
      parameter.value.length === 0 ||
      names.has(parameter.name)
    )
      throw new Error("Invalid secure parameter request");
    names.add(parameter.name);
  }
  for (const parameter of input.parameters) {
    try {
      await client.put({
        Name: parameter.name,
        Value: parameter.value,
        Type: "SecureString",
        Overwrite: true,
      });
    } catch {
      throw new Error("Secure parameter update failed");
    }
  }
}

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const { SSMClient, PutParameterCommand } =
    await import("@aws-sdk/client-ssm");
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  const sdk = new SSMClient({ region: input.region });
  try {
    await putSecureParameters(input, {
      put: (request) =>
        sdk.send(new PutParameterCommand(request), {
          abortSignal: controller.signal,
        }),
    });
    process.stdout.write("Secure parameters updated.\n");
  } finally {
    sdk.destroy();
    for (const parameter of input.parameters ?? []) parameter.value = "";
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch(() => {
    process.stderr.write("Secure parameter update failed.\n");
    process.exitCode = 1;
  });
}
