// The scroll position of the settings tab is the status scroll of the shown content (docs/spec/settings.md#status). The browser reports
// the scrollTop of the pane; the native host reports the position that its scroll view measures.
import assert from "node:assert/strict";
import test from "node:test";
import { startSettingsTab, openSettingsTab } from "./support/settings-tab-window.mjs";

const ctx = await startSettingsTab(null, {});

test("the scroll status reports the scroll position of the shown pane and follows a change of the position", async () => {
  await openSettingsTab(ctx);
  const pane = document.querySelector('[data-expose="core.settings-tab.pane"]');
  assert.ok(pane, "the tab has no pane");
  pane.scrollTop = 40;
  assert.equal((await ctx.status("core.settings-tab")).scroll, pane.scrollTop);
  assert.equal(typeof (await ctx.status("core.settings-tab")).scroll, "number");
});

test("showing another page starts the content at the top", async () => {
  const pane = document.querySelector('[data-expose="core.settings-tab.pane"]');
  pane.scrollTop = 40;
  await ctx.run("core.settings-tab.nav", { page: "workspace" });
  assert.equal((await ctx.status("core.settings-tab")).scroll, 0);
});

test("a negative scroll position is kept as reported and a value that is not a number is refused", async () => {
  const { scrollPosition } = await import("../settings-ui.js");
  for (const reported of [12, 0, -2, -3.5]) assert.equal(scrollPosition(reported), reported);
  for (const invalid of ["abc", "", NaN, Infinity, undefined, null]) {
    assert.throws(() => scrollPosition(invalid), /settings scroll position is not a number/, String(invalid));
  }
});
