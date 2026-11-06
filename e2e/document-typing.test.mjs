// A document region takes typed text on the virtual key window: the window takes the press and the keys without activation, and
// each character key states its text, which the web view of the region inserts through its text input, so the application and
// the input source of the person stay as they are (docs/spec/exposure.md#virtual-key-window).
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";

/** A document with one text field at the top left whose title shows the keys, the typed text and the focus. */
async function serve(s) {
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end('<!doctype html><title>type</title><style>body { margin:0; }</style><input id="field" style="position:absolute;left:0;top:0;width:200px;height:40px">'
      + '<script>let keys = ""; const show = () => { document.title = `keys:${keys} typed:${field.value} focus:${document.activeElement && document.activeElement.id} has:${document.hasFocus()}`; };'
      + 'addEventListener("keydown", (event) => { keys += event.key; show(); }, true); field.addEventListener("input", show); field.addEventListener("focus", show); addEventListener("focus", show); show();</script>');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  s.cleanup(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: the virtual key window gives a document region typed text`, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    const base = await serve(s);
    await s.until("core.surfaces", (list) => list.some((x) => x.visible && x.plugin === "browser" && x.exposes.includes("status browser.location")),
      "no visible browser surface registered browser.location");
    const active = new Set((await s.get("core.grid")).cards.map((card) => card.active).filter(Boolean));
    const surface = (await s.get("core.surfaces")).find((x) => x.visible && x.plugin === "browser" && active.has(x.surface)).surface;
    await s.run("browser.navigate", { url: `${base}/` }, surface);
    await s.until("browser.location", (at) => at.url === `${base}/` && !at.loading && at.error === null && at.title.startsWith("keys:"),
      "the document did not load", { surface });
    await s.presented();
    const rect = await s.rect("browser.document", undefined, surface);
    const region = { x: rect.document.x + rect.x, y: rect.document.y + rect.y };
    // A pointer move that presses nothing makes the window the virtual key window.
    await s.pointer(region.x + 100, region.y + 20, "move");
    await s.until("host.window", (state) => state.virtualKey, "the window did not become the virtual key window");
    await s.click(region.x + 100, region.y + 20);
    await s.until("host.window", (value) => value.documents.some((item) => item.surface === surface && item.focused),
      "a press on the field did not give the region the keyboard focus");
    await s.press("x", { text: "x" });
    await s.press("y", { text: "y" });
    try {
      await s.until("browser.location", (value) => / typed:xy /.test(value.title), "typed keys did not reach the field", { surface });
    } catch (error) {
      const { key, virtualKey, active, responder, documents, input } = await s.get("host.window");
      error.message += `; title ${JSON.stringify((await s.get("browser.location", surface)).title)}; host.window ${JSON.stringify({ key, virtualKey, active, responder, documents, input })}`;
      throw error;
    }
    assert.ok(true);
  });
}
