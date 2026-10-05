import { TelegramClient } from "./telegram-client.js";

type DiagnosticNotifierOptions = {
  readonly token: string;
  readonly administratorChatId: string;
  readonly fetch?: typeof fetch;
};

export function createAdminDiagnosticNotifier(
  options: DiagnosticNotifierOptions,
): TelegramClient {
  return new TelegramClient({
    token: options.token,
    chatId: options.administratorChatId,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
}
