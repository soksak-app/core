// A value change redraws only the rows of the changed keys (docs/spec/settings.md#performance). The test marks the rows that a change must
// not redraw and checks that each keeps its element; the rows of the changed keys are drawn again.
import assert from "node:assert/strict";
import test from "node:test";
import { startSettingsTab, openSettingsTab } from "./support/settings-tab-window.mjs";

const ctx = await startSettingsTab(null, {});
await openSettingsTab(ctx);

/** The row elements of the pane by their key. */
const rows = () => new Map([...document.querySelectorAll(".set-row[data-row]")].map((el) => [el.dataset.row, el]));

test("a change of a sidebar size redraws the row of that size only", async () => {
  await ctx.run("core.settings-tab.nav", { page: "workspace" });
  const before = rows();
  const kept = before.get("projectTabs");
  const changed = before.get("sidebarMinWidth");
  assert.ok(kept && changed, "the workspace page shows the rows projectTabs and sidebarMinWidth");
  // The minimum width stays below the width of the sidebar, so the change is valid.
  const minimum = ctx.settings.scopedValue("sidebarMinWidth", "common");
  await ctx.run("core.settings.change", { key: "sidebarMinWidth", value: minimum + 1, scope: "common" });
  const after = rows();
  assert.equal(after.get("projectTabs"), kept, "a row of another key was drawn again");
  assert.notEqual(after.get("sidebarMinWidth"), changed, "the row of the changed size was not drawn again");
});

test("a change of the link of a side redraws the sidebar order rows only", async () => {
  // The set is created before the page is shown: creating a set opens its editor on the sets page, which draws that page.
  const { id } = await ctx.run("core.settings.sets.create", { scope: "common" });
  await ctx.run("core.settings-tab.nav", { page: "workspace" });
  const before = rows();
  const kept = before.get("projectTabs");
  const order = before.get("sidebarOrder");
  assert.ok(order, "the workspace page shows the sidebar order");
  // The left side takes another choice than the one it has, so the change is a real change of the links.
  const current = ctx.settings.scopedValue("links", "common").find((link) => link.place === "left" && link.plugin === null)?.set ?? "off";
  const choice = current === "off" ? id : "off";
  await ctx.run("core.settings.link", { place: "left", plugin: null, set: choice, scope: "common" });
  const after = rows();
  assert.equal(after.get("projectTabs"), kept, "a row of another key was drawn again");
  assert.notEqual(after.get("sidebarOrder"), order, "the sidebar order row was not drawn again");
});

test("a change of the theme redraws the theme row only", async () => {
  await ctx.run("core.settings-tab.nav", { page: "look" });
  const before = rows();
  const kept = before.get("focusInd");
  const theme = before.get("theme");
  assert.ok(kept && theme, "the look page shows the rows focusInd and theme");
  const name = ctx.settings.THEMES[1].name ?? ctx.settings.THEMES[1].id;
  await ctx.run("core.settings.theme", { name, scope: "common" });
  const after = rows();
  assert.equal(after.get("focusInd"), kept, "a row of another key was drawn again");
  assert.notEqual(after.get("theme"), theme, "the theme row was not drawn again");
});

test("a change of the title of a set redraws the row of that set only", async () => {
  const first = await ctx.run("core.settings.sets.create", { scope: "common" });
  const second = await ctx.run("core.settings.sets.create", { scope: "common" });
  await ctx.run("core.settings-tab.edit", { set: null });
  await ctx.run("core.settings-tab.nav", { page: "sets" });
  const sets = () => new Map([...document.querySelectorAll(".set-set[data-set]")].map((el) => [el.dataset.set, el]));
  const before = sets();
  const kept = before.get(second.id);
  const changed = before.get(first.id);
  assert.ok(kept && changed, "the sets page shows a row for each set");
  await ctx.run("core.settings.sets.update", { id: first.id, title: "바꾼 세트", scope: "common" });
  const after = sets();
  assert.equal(after.get(second.id), kept, "the row of another set was drawn again");
  assert.notEqual(after.get(first.id), changed, "the row of the changed set was not drawn again");
  assert.equal(after.get(first.id).querySelector(".set-set__title").textContent, "바꾼 세트");
});
