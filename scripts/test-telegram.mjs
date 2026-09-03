import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";

const region = process.env.AWS_REGION ?? "sa-east-1";
const tokenPath = process.env.TELEGRAM_TOKEN_PARAMETER ?? "/prestamype/prod/telegram-token";
const chatPath = process.env.TELEGRAM_CHAT_ID_PARAMETER ?? "/prestamype/prod/telegram-chat-id";
const text = process.env.TELEGRAM_TEST_MESSAGE ?? "✅ Prestamype monitor: mensaje de prueba Telegram";

const ssm = new SSMClient({ region });
async function parameter(Name) {
  const result = await ssm.send(new GetParameterCommand({ Name, WithDecryption: true }));
  const value = result.Parameter?.Value;
  if (!value) throw new Error(`SSM parameter unavailable: ${Name}`);
  return value;
}

const token = await parameter(tokenPath);
const chatId = await parameter(chatPath);
const chatIds = chatId.split(",").map((id) => id.trim()).filter(Boolean);
for (const destination of chatIds) {
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: destination, text }),
  });
  const payload = await response.json();
  if (!response.ok || payload.ok !== true) {
    const reason = typeof payload.description === "string" ? `: ${payload.description}` : ".";
    throw new Error(`Telegram rechazó el destino ${destination} (HTTP ${response.status})${reason}`);
  }
  console.log(`Telegram respondió correctamente para el destino ${destination}.`);
}
