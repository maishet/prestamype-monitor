import { chromium } from "playwright";
import { expect, it } from "vitest";
import { PrestamypeClient, type PageLike } from "../../src/browser/prestamype-client.js";

it.each(["stacked", "sequential"])("closes %s campaigns without following a different visible modal", async (mode) => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<style>.generic-modal-overlay {position:fixed;inset:0;background:#ddd} button {margin:100px}</style>
      <div class="generic-modal-overlay" id="first"><button onclick="document.getElementById('second')?.style.removeProperty('display');this.parentElement.remove()"><i class="icon-close">X</i></button></div>
      <div class="generic-modal-overlay" id="second" style="${mode === "sequential" ? "display:none" : ""}"><button onclick="this.parentElement.remove()"><i class="icon-close">X</i></button></div>`);
    const client = new PrestamypeClient({ storageState: {} });
    const dismiss = client as unknown as { dismissOverlay(page: PageLike, deadline: number): Promise<void> };
    await dismiss.dismissOverlay(page as unknown as PageLike, Date.now() + 15000);
    expect(await page.locator(".generic-modal-overlay").count()).toBe(0);
  } finally { await browser.close(); }
}, 20000);

it("tries the icon when clicking its wrapper succeeds without closing", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div class="generic-modal-overlay" style="position:fixed;inset:0">
      <button style="position:absolute;left:100px;top:100px;width:200px;height:80px">
        <i class="icon-close" style="position:absolute;left:0;top:0" onclick="document.querySelector('.generic-modal-overlay').remove()">X</i>
      </button></div>`);
    const client = new PrestamypeClient({ storageState: {} });
    const dismiss = client as unknown as { dismissOverlay(page: PageLike, deadline: number): Promise<void> };
    await dismiss.dismissOverlay(page as unknown as PageLike, Date.now() + 15000);
    expect(await page.locator(".generic-modal-overlay").count()).toBe(0);
  } finally { await browser.close(); }
}, 20000);

it("clicks the campaign backdrop instead of a nested inert dialog", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div class="generic-modal-overlay" style="position:fixed;inset:0" onclick="if(event.target===this)this.remove()">
      <div role="dialog" aria-modal="true" style="position:absolute;inset:80px;background:white">
        <button><i class="icon-close">X</i></button>
      </div></div>`);
    const client = new PrestamypeClient({ storageState: {} });
    const dismiss = client as unknown as { dismissOverlay(page: PageLike, deadline: number): Promise<void> };
    await dismiss.dismissOverlay(page as unknown as PageLike, Date.now() + 15000);
    expect(await page.locator(".generic-modal-overlay").count()).toBe(0);
  } finally { await browser.close(); }
}, 20000);
