// An error toast shows in the window while the settings tab is open, and its close control runs the declared dismissal once
// (docs/spec/notifications.md#settings). The toast is a toast of the window and not of the tab, since the tab is not a dialog.
import assert from "node:assert/strict";
import test from "node:test";
import { startSettingsTab, openSettingsTab } from "./support/settings-tab-window.mjs";

const ctx = await startSettingsTab(null, {});

test("an error toast closes with its own control, which runs core.notices.close once", async () => {
  const { installErrorExposure } = await import("../core-exposure.js");
  const errors = installErrorExposure();
  const message = "The workspace could not be saved";
  errors.show(message, "", "workspace");
  await openSettingsTab(ctx);
  const toast = document.querySelector(".toast");
  assert.ok(toast, "the error toast is not shown while the settings tab is open");
  // The close control is the toast__close button; the actions of the toast come before it (docs/spec/notifications.md#toasts).
  const button = toast.querySelector(".toast__close");
  let dismissals = 0;
  ctx.registry.watch((name) => { if (name === "core.notices.close") dismissals++; });
  button.click();
  await ctx.registry.commandsEnded();
  assert.equal(document.querySelector(".toast"), null);
  assert.equal(dismissals, 1, "one press runs one declared dismissal");
  assert.equal(errors.text("workspace"), message, "dismissing the toast does not recover the workspace");
});
