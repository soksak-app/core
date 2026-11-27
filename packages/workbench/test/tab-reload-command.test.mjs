// Checks that the core.tab.reload command sends viewReload with its tab to the host and answers the tab, and that the control of a
// failed surface runs that command (docs/spec/native-surfaces.md#view-surfaces). The host call is the page-wire case of the test.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { selectPageWire } from "@soksak/runtime";
import { pageMemorySaver } from "./support/memory-saver.mjs";

test("core.tab.reload restarts the view of its tab through the host and the failed surface runs it", { timeout: 5000 }, async (t) => {
  const wire = selectPageWire("tab-reload-command");
  const dom = new JSDOM(readFileSync(new URL("../index.html", import.meta.url), "utf8"), { url: "http://localhost/" });
  dom.window.matchMedia = (query) => ({ media: query, matches: true, addEventListener: () => {}, removeEventListener: () => {} });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.CSS = dom.window.CSS;
  globalThis.PointerEvent = dom.window.PointerEvent;
  globalThis.MouseEvent = dom.window.MouseEvent;
  globalThis.addEventListener = dom.window.addEventListener.bind(dom.window);
  t.after(() => dom.window.close());
  const { registry } = await import("../exposure.js");
  registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
  const { installCoreExposure } = await import("../core-exposure.js");
  const parts = { home: { state: () => null }, renames: { state: () => null }, chrome: () => null, drawn: async () => {} };
  // The case has no log calls, so the classes of the page log are off while the command runs.
  const { logGate } = await import("../log-gate.js");
  logGate.set({ lifecycle: "off", input: "off", call: "off", io: "off", frame: "off" });
  await installCoreExposure({ ...parts, memorySaver: await pageMemorySaver() });
  const answer = await registry.run("core.tab.reload", { tab: "tab-reload-probe" });
  assert.deepEqual(answer, { tab: "tab-reload-probe" });
  wire.finish();
});

test("a failed surface shows the reload control, which carries the declared command of its tab", async (t) => {
  const dom = new JSDOM(`<section data-card-id="card-1"><div data-native-surface-id="probe-surface"></div><footer class="status"></footer></section>`);
  globalThis.document = dom.window.document;
  t.after(() => dom.window.close());
  const { setSurfaceStatus } = await import("../surface-status.js?reload");
  const status = document.querySelector(".status");
  const { viewStopState } = await import("@soksak/plugin-api/view-answer");
  setSurfaceStatus(status, "probe-surface", viewStopState({ surface: "probe-surface", plugin: "probe", reason: "the view failed" }));
  const control = status.querySelector("[data-surface-reload]");
  assert.ok(control, "the failed surface shows no reload control");
  assert.equal(control.dataset.expose, "core.tab.reload");
  assert.equal(control.textContent, "다시 불러오기");
  setSurfaceStatus(status, "probe-surface", { phase: "loading" });
  assert.equal(status.querySelector("[data-surface-reload]"), null, "a loading surface keeps the reload control");
});
