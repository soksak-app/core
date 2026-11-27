// The summary of the agent group shows the warning icon beside its count (docs/spec/settings.md#agents).
import assert from "node:assert/strict";
import test from "node:test";
import { selectPageWire } from "@soksak/runtime";
import { startSettingsTab, openSettingsTab } from "./support/settings-tab-window.mjs";

/** Settles the reads and the draws that a command or the showing started. */
const settled = () => new Promise((resolve) => setImmediate(resolve));

test("the summary of the agent group is a warn badge with the warning icon", { timeout: 10000 }, async (t) => {
  selectPageWire("setup-parts-settings");
  const ctx = await startSettingsTab(t, { connect: false });
  const { installSetupExposure } = await import("../setup-exposure.js");
  installSetupExposure({ showError: () => {}, changed: () => ctx.core.redrawSettings() });
  await openSettingsTab(ctx);
  await ctx.run("core.settings-tab.nav", { page: "agents" });
  await settled();
  await settled();
  const summary = ctx.document.querySelector(".set-actions .set-badge--warn");
  assert.equal(summary?.textContent, "4개 중 4개가 다름", "the summary shows the count of the parts that differ or are missing");
  const icon = summary.querySelector("svg");
  assert.ok(icon, "the summary badge has the warning icon");
  assert.deepEqual([icon.getAttribute("width"), icon.getAttribute("height"), icon.getAttribute("viewBox")], ["16", "16", "0 0 16 16"], "the icon is the 16-point badge icon of settings-36 page 5");
});
