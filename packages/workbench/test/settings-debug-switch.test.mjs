import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";

// The diagnostics row of the general section draws one debug switch that runs core.settings.debug and is on only when the debug state holds
// (docs/spec/settings.md, the section of core.settings.debug).
test("the debug switch runs core.settings.debug and is on only when the trace and every class are at trace", async (t) => {
  const dom = new JSDOM("<body><div id=plane></div></body>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  globalThis.CSS = dom.window.CSS ?? { escape: (text) => text };
  globalThis.addEventListener = dom.window.addEventListener.bind(dom.window);
  t.mock.module("../compositor.js", { exports: {
    ...await import("../compositor.js"), standIn: () => {},
  } });
  t.mock.module("../environment.js", { exports: { pluginUnits: () => [] } });
  const memory = { common: {}, projects: [] };
  const settings = await import("../settings.js");
  await settings.connectSettings({
    snapshot: async () => structuredClone(memory),
    settings: async (id, values) => { memory.common = { ...memory.common, ...values }; },
    onChange: () => () => {},
  });
  const { registry } = await import("../exposure.js");
  registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
  const ui = await import("../settings-ui.js");
  const debugSwitch = () => document.querySelector('[data-command="core.settings.debug"]');
  ui.openSettings();
  ui.showSection("general");
  const off = debugSwitch();
  assert.ok(off, "the 진단 row draws no 디버그 switch");
  assert.deepEqual([off.tagName, off.type, off.dataset.value], ["INPUT", "checkbox", "on"]);
  assert.equal(off.checked, false, "the switch is on by default");

  await settings.setDebug(true, "core.settings.debug");
  ui.openSettings();
  ui.showSection("general");
  assert.equal(debugSwitch().checked, true, "the switch is off after the debug state was set");

  // A policy that names only some classes at trace is not the debug state.
  await settings.set({ "diagnostics.log": { call: "trace" } }, "common", "test");
  ui.openSettings();
  ui.showSection("general");
  assert.equal(debugSwitch().checked, false, "the switch is on while one class is not at trace");
});
