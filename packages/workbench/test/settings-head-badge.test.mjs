// The page head of 진단 shows the badge 전역 전용 in place of the scope control, because the page has a setting and no setting that a project can
// override (docs/spec/settings.md#page-head).
import assert from "node:assert/strict";
import test from "node:test";
import { startSettingsTab, openSettingsTab } from "./support/settings-tab-window.mjs";

const ctx = await startSettingsTab(null, {
  project: "prj-a",
  setup: async () => ({ common: {}, projects: [{ id: "prj-a", root: "/work/a", title: "a", spaces: [], settings: {} }] }),
});

test("the page head of 진단 shows the badge 전역 전용 and no scope control", async () => {
  await openSettingsTab(ctx);
  await ctx.run("core.settings-tab.nav", { page: "diag" });
  const head = ctx.document.querySelector(".set-head__scope");
  assert.equal(head.textContent, "전역 전용", "the head of 진단 shows the badge");
  assert.equal(head.querySelector('[data-expose="core.settings-tab.scope"]'), null, "the head of 진단 shows no scope control");
});
