// A setting write that the host refuses, started by a control of the settings tab through the binder: the control shows the stored value
// again, and the error is shown once through the one error display path (docs/spec/settings.md#performance).
import assert from "node:assert/strict";
import test from "node:test";
import { openSettingsTab, startSettingsTab } from "./support/settings-tab-window.mjs";

const REFUSAL = "the configuration directory is read-only";
const ctx = await startSettingsTab(null, {
  refuse: REFUSAL,
  setup: () => ({ common: { memorySaver: true }, projects: [] }),
});

test("a refused switch restores the stored value in the control and shows its error once", async () => {
  await openSettingsTab(ctx);
  await ctx.run("core.settings-tab.nav", { page: "behavior" });
  const switchOf = () => ctx.document.querySelector('[data-set="memorySaver"]');
  assert.equal(switchOf()?.checked, true, "the switch does not show the stored true");
  switchOf().click();
  await ctx.registry.commandsEnded();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(switchOf()?.checked, true, "the switch shows the value of the refused write");
  assert.equal(ctx.settings.value("memorySaver"), true, "the store kept the value of the refused write");
  const toasts = ctx.document.querySelectorAll(".toast");
  assert.equal(toasts.length, 1, `the shell showed ${toasts.length} error toasts, not one`);
  assert.match(toasts[0].textContent, new RegExp(REFUSAL));
  const errors = (await ctx.status("core.notices")).entries.filter((entry) => entry.kind === "error");
  assert.equal(errors.length, 1, `the notices hold ${errors.length} errors, not one`);
  assert.equal(errors[0].title, REFUSAL);
});
