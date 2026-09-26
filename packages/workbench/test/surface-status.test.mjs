import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

test("surface loading status is visible until the module becomes ready", async () => {
  const dom = new JSDOM("<footer class=status></footer>");
  globalThis.document = dom.window.document;
  const { setSurfaceStatus } = await import("../surface-status.js");
  const status = document.querySelector(".status");

  setSurfaceStatus(status, { phase: "loading" });
  const indicator = status.querySelector("[data-surface-status]");
  assert.equal(status.dataset.surfaceStatus, "loading");
  assert.equal(indicator.hidden, false);
  assert.equal(indicator.textContent, "불러오는 중");
  assert.equal(status.getAttribute("aria-busy"), "true");

  setSurfaceStatus(status, { phase: "ready" });
  assert.equal(status.dataset.surfaceStatus, "ready");
  assert.equal(indicator.hidden, true, "ready must hide the loading indicator");
  assert.equal(status.getAttribute("aria-busy"), "false");

  setSurfaceStatus(status, { phase: "error", error: "network" });
  assert.equal(status.dataset.surfaceStatus, "error");
  assert.equal(indicator.hidden, false);
  assert.match(indicator.textContent, /network/);
  dom.window.close();
});

test("a surface status without a phase or an error state without an error is rejected", async () => {
  const dom = new JSDOM("<footer class=status></footer>");
  globalThis.document = dom.window.document;
  const { setSurfaceStatus } = await import("../surface-status.js");
  const status = document.querySelector(".status");
  assert.throws(() => setSurfaceStatus(status, {}), /invalid surface phase/);
  assert.throws(() => setSurfaceStatus(status, { phase: "error", error: null }), /carries no error/);
  setSurfaceStatus(status, { phase: "error", error: new Error("broken") });
  assert.match(status.querySelector("[data-surface-status]").textContent, /broken/);
  dom.window.close();
});
