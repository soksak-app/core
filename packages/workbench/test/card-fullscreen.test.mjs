import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";

test("the header fullscreen control precedes close and runs its declared command", async () => {
  const dom = new JSDOM("<body></body>");
  globalThis.document = dom.window.document;
  const { registry } = await import("../exposure.js");
  registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
  const calls = [];
  let called;
  const invoked = new Promise((resolve) => { called = resolve; });
  registry.command("core.card.fullscreen", (params) => { calls.push(params); called(); });
  try {
    const tools = await import("../card-tools.js");
    const toolbar = tools.createCardTools("fixture");
    document.body.appendChild(toolbar);
    tools.updateCardTools(toolbar, { canClose: true, canSplitX: true, canSplitY: true, fullscreen: false });
    const button = toolbar.querySelector('[data-expose="core.card.fullscreen"]');
    assert.ok(button);
    assert.equal(button.nextElementSibling.dataset.expose, "core.card.close");
    assert.equal(button.getAttribute("aria-pressed"), "false");
    assert.equal(button.getAttribute("aria-label"), "카드 전체 화면");
    const { audit } = await import("../commands.js");
    assert.deepEqual(audit(toolbar), []);
    button.click();
    await invoked;
    assert.deepEqual(calls, [{ card: "fixture" }]);
    tools.updateCardTools(toolbar, { canClose: true, canSplitX: true, canSplitY: true, fullscreen: true });
    assert.equal(button.getAttribute("aria-pressed"), "true");
    assert.equal(button.getAttribute("aria-label"), "카드 배치 복원");
  } finally { dom.window.close(); }
});

test("fullscreen siblings stay hidden under the workbench card stylesheet", () => {
  const css = readFileSync(new URL("../app.css", import.meta.url), "utf8");
  const dom = new JSDOM(`<style>${css}</style><article class="card" hidden></article>`);
  try {
    assert.equal(dom.window.getComputedStyle(dom.window.document.querySelector(".card")).display, "none");
  } finally { dom.window.close(); }
});
