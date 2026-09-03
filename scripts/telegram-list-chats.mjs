import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";

const region = process.env.AWS_REGION ?? "sa-east-1";
const tokenPath =
  process.env.TELEGRAM_TOKEN_PARAMETER ?? "/prestamype/prod/telegram-token";
const ssm = new SSMClient({ region });
const result = await ssm.send(
  new GetParameterCommand({ Name: tokenPath, WithDecryption: true }),
);
const token = result.Parameter?.Value;
if (!token) throw new Error("No se encontró el token de Telegram en SSM.");

const response = await fetch(`https://api.telegram.org/bot${token}/getUpdates`);
const payload = await response.json();
if (!response.ok || payload.ok !== true)
  throw new Error(`Telegram rechazó la consulta (HTTP ${response.status}).`);

const chats = new Map();
for (const update of payload.result ?? []) {
  const message = update.message ?? update.my_chat_member?.chat;
  const chat = message?.chat;
  if (chat?.id !== undefined)
    chats.set(String(chat.id), {
      id: chat.id,
      type: chat.type,
      title: chat.title ?? chat.username ?? "(privado)",
    });
}
if (chats.size === 0) {
  console.log(
    "No hay chats recientes. Envía /start al bot en privado o dentro del grupo y vuelve a ejecutar este comando.",
  );
} else {
  for (const chat of chats.values())
    console.log(`${chat.id}\t${chat.type}\t${chat.title}`);
}
