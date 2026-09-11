// Run with --prepare before deploy, then without it after deploy.
// Secrets remain in memory; do not pass bot tokens on the command line.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  SSMClient,
  GetParameterCommand,
  PutParameterCommand,
} from "@aws-sdk/client-ssm";

const profile = process.env.AWS_PROFILE ?? "prestamype";
const region = "sa-east-1";
const secretName = "/prestamype/prod/webhook-secret";
const owner = "1524876607";
const aws = (args) =>
  JSON.parse(
    execFileSync(
      "aws",
      [...args, "--profile", profile, "--region", region, "--output", "json"],
      { encoding: "utf8", windowsHide: true },
    ),
  );
try {
  const credentials = aws([
    "configure",
    "export-credentials",
    "--format",
    "process",
  ]);
  const ssm = new SSMClient({
    region,
    credentials: {
      accessKeyId: credentials.AccessKeyId,
      secretAccessKey: credentials.SecretAccessKey,
      sessionToken: credentials.SessionToken,
    },
  });
  const token = (
    await ssm.send(
      new GetParameterCommand({
        Name: "/prestamype/prod/telegram-token",
        WithDecryption: true,
      }),
    )
  ).Parameter.Value;
  const telegram = async (method, body = {}) => {
    const response = await fetch(
      `https://api.telegram.org/bot${token}/${method}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: globalThis.AbortSignal.timeout(15000),
      },
    );
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(`Telegram ${method} failed`);
    return data.result;
  };
  let secret;
  try {
    secret = (
      await ssm.send(
        new GetParameterCommand({ Name: secretName, WithDecryption: true }),
      )
    ).Parameter.Value;
  } catch (error) {
    if (error.name !== "ParameterNotFound") throw error;
    secret = randomBytes(32).toString("hex");
    await ssm.send(
      new PutParameterCommand({
        Name: secretName,
        Type: "SecureString",
        Value: secret,
        Overwrite: false,
      }),
    );
  }
  const me = await telegram("getMe");
  if (process.argv.includes("--prepare")) {
    console.log(`Prepared webhook secret. Bot username: ${me.username}`);
  } else {
    const stack = aws([
      "cloudformation",
      "describe-stacks",
      "--stack-name",
      "prestamype-monitor",
    ]);
    const url = stack.Stacks[0].Outputs.find(
      (x) => x.OutputKey === "CommandsUrl",
    )?.OutputValue;
    if (
      !url ||
      !/^https:\/\/[a-z0-9]+\.lambda-url\.sa-east-1\.on\.aws\/$/.test(url)
    )
      throw new Error("Unexpected command URL");
    const prior = await telegram("getWebhookInfo");
    if (prior.url && prior.url !== url)
      throw new Error("An unrelated webhook is already configured");
    const commands = [
      { command: "ayuda", description: "Comandos disponibles" },
      {
        command: "oportunidades",
        description: "Consultar oportunidades guardadas",
      },
      { command: "detalle", description: "Consultar detalle: /detalle ID" },
      { command: "criterios", description: "Filtros y criterios del monitor" },
    ];
    await telegram("setMyCommands", { commands, scope: { type: "default" } });
    await telegram("setMyCommands", {
      commands: [
        ...commands,
        { command: "estado", description: "Estado privado del monitor" },
        { command: "escanear", description: "Solicitar un escaneo limitado" },
        { command: "pausar", description: "Desactivar el monitor" },
        {
          command: "reanudar",
          description: "Activar sin eliminar pausas de seguridad",
        },
        {
          command: "recuperar",
          description: "Quitar pausa recuperable y escanear",
        },
        {
          command: "sesionestado",
          description: "Comprobar estado de la sesión Prestamype",
        },
      ],
      scope: { type: "chat", chat_id: owner },
    });
    await telegram("setWebhook", {
      url,
      secret_token: secret,
      allowed_updates: ["message"],
      max_connections: 1,
    });
    const status = await telegram("getWebhookInfo");
    console.log(
      JSON.stringify({
        configured: status.url === url,
        pendingUpdates: status.pending_update_count,
        maxConnections: status.max_connections,
        botUsername: me.username,
      }),
    );
  }
} catch {
  console.error(
    "Webhook setup failed. Check AWS authentication, stack outputs and existing webhook configuration; no secrets were printed.",
  );
  process.exitCode = 1;
}
