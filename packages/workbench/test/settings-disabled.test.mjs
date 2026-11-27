// The status core.settings-tab reports each control with its disabled state: a dependent setting is disabled while its parent is off,
// and a common-only setting is disabled in the project scope (docs/spec/settings.md#status).
import assert from "node:assert/strict";
import test from "node:test";
import { startSettingsTab, openSettingsTab } from "./support/settings-tab-window.mjs";

const ctx = await startSettingsTab(null, {
  project: "prj-a",
  setup: async () => ({ common: { memorySaver: true, autoDismissProblemToasts: true }, projects: [{ id: "prj-a", root: "/work/a", title: "a", spaces: [], settings: {} }] }),
});

/** The status entry of the control of a key. */
async function controlOf(key) {
  const { controls } = await ctx.status("core.settings-tab");
  const entry = controls.find((control) => control.key === key);
  assert.ok(entry, `no control for ${key}`);
  return entry;
}

test("a dependent setting is disabled in the status while its parent is off", async () => {
  await openSettingsTab(ctx);
  await ctx.run("core.settings-tab.nav", { page: "behavior" });
  assert.equal((await controlOf("memorySaverDelay")).disabled, false, "the delay is disabled while memorySaver is on");
  await ctx.run("core.settings.change", { key: "memorySaver", value: false, scope: "common" });
  assert.equal((await controlOf("memorySaverDelay")).disabled, true, "the delay is not disabled while memorySaver is off");
  await ctx.run("core.settings.change", { key: "memorySaver", value: true, scope: "common" });
  assert.equal((await controlOf("memorySaverDelay")).disabled, false);
});

test("a stepper of a dependent setting follows the switch of its parent", async () => {
  await ctx.run("core.settings.change", { key: "autoDismissProblemToasts", value: false, scope: "common" });
  await ctx.run("core.settings-tab.nav", { page: "behavior" });
  assert.equal((await controlOf("problemToastDismissSeconds")).disabled, true);
  await ctx.run("core.settings.change", { key: "autoDismissProblemToasts", value: true, scope: "common" });
  assert.equal((await controlOf("problemToastDismissSeconds")).disabled, false);
});

test("a common-only setting is disabled in the status in the project scope only", async () => {
  await ctx.run("core.settings-tab.nav", { page: "look" });
  await ctx.run("core.settings-tab.scope", { scope: "common" });
  assert.equal((await controlOf("textSize")).disabled, false, "the common scope disables a common-only setting");
  await ctx.run("core.settings-tab.scope", { scope: "project" });
  assert.equal((await controlOf("textSize")).disabled, true, "the project scope does not disable a common-only setting");
});
