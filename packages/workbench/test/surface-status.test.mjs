import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
// The error toast runs the declared command core.notices.close, so the page exposure is installed before a toast shows.
const { installExposure } = await import("../exposure.js");
const { default: exposureFile } = await import("../exposure.json", { with: { type: "json" } });
installExposure(exposureFile);

test("surface loading status is visible until the module becomes ready", async () => {
  const dom = new JSDOM("<footer class=status></footer>");
  globalThis.document = dom.window.document;
  const { setSurfaceStatus } = await import("../surface-status.js");
  const status = document.querySelector(".status");

  setSurfaceStatus(status, "tab-a", { phase: "loading" });
  const indicator = status.querySelector("[data-surface-status]");
  assert.equal(status.dataset.surfaceStatus, "loading");
  assert.equal(indicator.hidden, false);
  assert.equal(indicator.textContent, "불러오는 중");
  assert.equal(status.getAttribute("aria-busy"), "true");

  setSurfaceStatus(status, "tab-a", { phase: "ready" });
  assert.equal(status.dataset.surfaceStatus, "ready");
  assert.equal(indicator.hidden, true, "ready must hide the loading indicator");
  assert.equal(status.getAttribute("aria-busy"), "false");

  setSurfaceStatus(status, "tab-a", { phase: "error", error: "network" });
  assert.equal(status.dataset.surfaceStatus, "error");
  assert.equal(indicator.hidden, false);
  assert.equal(indicator.textContent, "표면 오류", "the indicator keeps a state label");
  assert.match(document.querySelector(".toast__title").textContent, /network/, "the error text shows in the toast");
  dom.window.close();
});

test("a surface status without a phase or an error state without an error is rejected", async () => {
  const dom = new JSDOM("<footer class=status></footer>");
  globalThis.document = dom.window.document;
  const { setSurfaceStatus } = await import("../surface-status.js");
  const status = document.querySelector(".status");
  assert.throws(() => setSurfaceStatus(status, "tab-a", {}), /invalid surface phase/);
  assert.throws(() => setSurfaceStatus(status, undefined, { phase: "ready" }), /a surface status needs a surface id, not undefined/);
  assert.throws(() => setSurfaceStatus(status, "tab-a", { phase: "error", error: null }), /carries no error/);
  setSurfaceStatus(status, "tab-a", { phase: "error", error: new Error("broken") });
  assert.match(document.querySelector(".toast__title").textContent, /broken/, "the error text shows in the toast");
  dom.window.close();
});

// The close of a tab withdraws its operation error and the error of its stopped surface, because the state that each describes ended
// with the tab (docs/spec/exposure.md#error-presentation).
test("closing a tab withdraws its tab error and its surface error", async () => {
  const dom = new JSDOM("<div data-card-id=card-1><footer class=status></footer></div>");
  globalThis.document = dom.window.document;
  const { setSurfaceStatus, setTabError } = await import("../surface-status.js");
  const { errorToasts } = await import("../shown-errors.js");
  const { recordClosedTabs } = await import("../closed-tabs.js");
  setSurfaceStatus(document.querySelector(".status"), "tab-c", { phase: "error", error: "stopped" });
  setTabError("tab-c", "save failed");
  setTabError("tab-d", "other failed");
  recordClosedTabs(["tab-c"]);
  assert.equal(errorToasts(document).text("tab error tab-c"), null);
  assert.equal(errorToasts(document).text("surface status card-1 tab-c"), null);
  assert.equal(errorToasts(document).text("tab error tab-d"), "other failed");
  dom.window.close();
});
