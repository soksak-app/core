// Every control of a setting shows the applied value and the scope that the value comes from, and writes to that scope; only the
// project tab adds or removes a project value (docs/spec/settings.md#scope-of-a-control).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";

test("a control of a setting changes the value that it shows in the scope that the value comes from", async (t) => {
  const dom = new JSDOM("<body><div id=plane></div></body>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  globalThis.CSS = dom.window.CSS ?? { escape: (text) => text };
  globalThis.addEventListener = dom.window.addEventListener.bind(dom.window);
  t.after(() => dom.window.close());
  t.mock.module("../compositor.js", { exports: { ...await import("../compositor.js"), standIn: () => {} } });
  t.mock.module("../environment.js", { exports: { pluginUnits: () => [] } });
  const settings = await import("../settings.js");
  settings.beginSettings({ common: { top: false, mode: "dark" }, projects: [{ id: "prj-a", root: "/work/a", settings: { top: true, mode: "light" } }] }, "prj-a");
  const { registry } = await import("../exposure.js");
  registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
  const ui = await import("../settings-ui.js");

  // The chrome switches and the fold control write the scope that the applied value of their key comes from.
  assert.equal(settings.sourceScope("top"), "project");
  assert.equal(settings.sourceScope("left"), "common");
  assert.deepEqual(settings.appliedPatch("left", false), { patch: { left: false }, scope: "common" });
  assert.deepEqual(settings.appliedPatch("top", false), { patch: { top: false }, scope: "project" });
  const page = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.match(page, /"core\.settings\.set", \(\) => appliedPatch\(side, !value\(side\)\)/, "a side switch of the chrome writes another scope");
  assert.match(page, /"core\.settings\.set", \(\) => appliedPatch\("mode", /, "the mode switch of the chrome writes another scope");
  const plane = readFileSync(new URL("../plane.js", import.meta.url), "utf8");
  assert.match(plane, /bind\(fold, "core\.settings\.set", \(\) => appliedPatch\(side, false\)\)/, "the fold control writes another scope");

  ui.openSettings();
  ui.showSection("general");
  const control = (key) => ui.settingsModalState().controls.find((item) => item.key === key);
  // The common tab shows the project value of top with its mark, and writes the project scope.
  assert.equal(control("top").on, true);
  assert.equal(control("top").command.params.scope, "project");
  const mark = control("applied:top");
  assert.deepEqual([mark?.name, mark?.label], ["core.settings-modal.applied", "프로젝트 값"]);
  assert.equal(control("mode").value, "light");
  assert.equal(control("mode").command.params.scope, "project");
  // A setting without a project value shows and writes the common value, without a mark.
  assert.equal(control("left").command.params.scope, "common");
  assert.equal(control("applied:left"), undefined);
  assert.equal(ui.settingsModalState().controls.filter((item) => item.name === "core.settings-modal.reset").length, 0,
    "the common tab removes a project value");
  ui.closeSettings?.();
});
