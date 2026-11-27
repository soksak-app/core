// The settings tab holds the menu at its left and the content beside it, and a wide row gives its control the whole row, so the theme
// swatches fill the width of the pane (docs/spec/settings.md#menu, docs/spec/settings.md#rows). The stylesheets of index.html are applied
// in their order to the document of the window, and the rules that reach the mounted elements are read from it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createSettingsChip } from "../settings-chip.js";
import { startSettingsTab } from "./support/settings-tab-window.mjs";

const ctx = await startSettingsTab(null);
for (const link of document.querySelectorAll('link[rel="stylesheet"]')) {
  const style = document.createElement("style");
  style.textContent = readFileSync(new URL(`../${link.getAttribute("href")}`, import.meta.url), "utf8");
  link.replaceWith(style);
}
// The chip shows the container of the tab and mounts the content into it, as the tab strip of index.html does.
const chip = createSettingsChip(document.getElementById("settingsChip"), document.getElementById("settingsTab"),
  { mount: ctx.core.mountSettingsTab, front: ctx.core.settingsTabFront, open: ctx.core.settingsTabFront });
await ctx.run("core.settings.open");
assert.equal(chip.draw().front, true, "the settings tab is not in front");
await ctx.run("core.settings-tab.nav", { page: "look" });

test("the settings tab places the menu and the content in two columns", () => {
  const tab = document.getElementById("settingsTab");
  assert.deepEqual([...tab.children].map((el) => el.className), ["set-menu", "set-main"], "the tab does not hold the menu and the content");
  const style = getComputedStyle(tab);
  assert.equal(style.display, "grid", "the tab stacks the menu above the content");
  assert.match(style.gridTemplateColumns, /^\S+\(.*\)\s+\S+\(.*\)$/, `the tab has the columns ${style.gridTemplateColumns}`);
});

test("the control of a wide row takes the whole row", () => {
  const grid = document.querySelector('.set-row[data-row="theme"] .th-grid');
  assert.ok(grid, "the page 모양 has no theme swatch grid");
  const column = grid.parentElement;
  assert.equal(column.className, "set-row__control");
  assert.equal(getComputedStyle(column).maxWidth, "none", "the control column of a wide row keeps the width of the control column");
  // The token fill is the whole length (workbench.json), and the page sets it on the root from that declaration.
  assert.equal(getComputedStyle(grid).flex, "1 1 var(--fill)", "the swatch grid is as wide as its swatches, so it has one column");
  assert.equal(JSON.parse(readFileSync(new URL("../workbench.json", import.meta.url), "utf8")).chrome.fill, "100%");
});
