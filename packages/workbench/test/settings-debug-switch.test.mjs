// The diagnostics page of the settings tab draws the switch 디버그 기록 that runs core.settings.debug. The switch is on only when the
// performance trace and every class of the log policy are at trace (docs/spec/settings.md#진단).
import assert from "node:assert/strict";
import test from "node:test";
import { startSettingsTab, openSettingsTab } from "./support/settings-tab-window.mjs";

const ctx = await startSettingsTab(null, {});

test("the debug switch runs core.settings.debug and is on only when the trace and every class are at trace", async () => {
  await openSettingsTab(ctx);
  await ctx.run("core.settings-tab.nav", { page: "diag" });
  const debugSwitch = () => document.querySelector('[data-expose="core.settings-tab.debug"]');
  const off = debugSwitch();
  assert.ok(off, "the 진단 page draws no debug switch");
  assert.deepEqual([off.tagName, off.type, off.dataset.command], ["INPUT", "checkbox", "core.settings.debug"]);
  assert.equal(off.checked, false, "the switch is on by default");

  await ctx.run("core.settings.debug", { on: true });
  await ctx.run("core.settings-tab.nav", { page: "diag" });
  assert.equal(debugSwitch().checked, true, "the switch is off after the debug state was set");

  // A policy that names only some classes at trace is not the debug state.
  await ctx.run("core.settings.change", { key: "diagnostics.log", value: { call: "trace" }, scope: "common" });
  await ctx.run("core.settings-tab.nav", { page: "diag" });
  assert.equal(debugSwitch().checked, false, "the switch is on while one class is not at trace");
});

// The stored sidebars of a project that is not selected follow from its own overrides (docs/spec/projects.md#settings).
test("the sidebars of a project are its own overrides over the common settings", async () => {
  const settings = await import("../settings.js");
  const sets = [{ id: "mine", title: "mine", sections: [], layout: "list" }];
  const common = settings.projectSidebars({});
  assert.ok(Array.isArray(common.sets) && Array.isArray(common.links), "a project without overrides has the common sets and links");
  assert.deepEqual(settings.projectSidebars({ settings: { sets, links: [] } }), { sets, links: [] });
});
