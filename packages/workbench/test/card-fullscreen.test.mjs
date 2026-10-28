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
    const stableMutations = [];
    const observer = new dom.window.MutationObserver((records) => stableMutations.push(...records));
    observer.observe(toolbar, { attributes: true, subtree: true, attributeFilter: ["disabled", "title", "aria-label"] });
    tools.updateCardTools(toolbar, { canClose: true, canSplitX: true, canSplitY: true, fullscreen: false });
    await Promise.resolve();
    observer.disconnect();
    assert.deepEqual(stableMutations.map(({ attributeName }) => attributeName), [],
      "an unchanged update must not rewrite tool availability or labels");
    const close = toolbar.querySelector('[data-do="close"]');
    const splitX = toolbar.querySelector('[data-do="x"]');
    tools.updateCardTools(toolbar, { canClose: false, canSplitX: false, canSplitY: true, fullscreen: false });
    assert.equal(close.disabled, true, "the close availability change was lost");
    assert.match(close.title, /닫을 수 없다/, "the close explanation did not follow availability");
    assert.equal(splitX.disabled, true, "the split availability change was lost");
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
