import { expect, it, vi } from "vitest";

import { createAdminDiagnosticNotifier } from "../../src/notifications/diagnostic-notifier.js";

it("sends diagnostics to the administrator and not configured opportunity groups", async () => {
  const recipients: string[] = [];
  const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { chat_id: string };
    recipients.push(body.chat_id);
    return new Response('{"ok":true}', { status: 200 });
  });
  const notifier = createAdminDiagnosticNotifier({
    token: "123456:abcdefghijklmnopqrstuvwxyz",
    administratorChatId: "1524876607",
    fetch,
  });

  await notifier.send("PageStructureError");

  expect(recipients).toEqual(["1524876607"]);
});
