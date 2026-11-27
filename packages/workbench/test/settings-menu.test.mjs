// The menu of the settings tab follows the menu of the settings design (docs/spec/settings.md#menu): the search field with its icon on top,
// the group labels, one item per page with its icon at the start and its count or badge at the end, and the plugin items with a chevron.
// The stylesheets of index.html are applied in their order, and the rules that reach the mounted menu are read from the document.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createSettingsChip } from "../settings-chip.js";
import { startSettingsTab } from "./support/settings-tab-window.mjs";

const declaration = JSON.parse(readFileSync(new URL("../workbench.json", import.meta.url), "utf8"));
const ctx = await startSettingsTab(null);
for (const link of document.querySelectorAll('link[rel="stylesheet"]')) {
  const style = document.createElement("style");
  style.textContent = readFileSync(new URL(`../${link.getAttribute("href")}`, import.meta.url), "utf8");
  link.replaceWith(style);
}
const chip = createSettingsChip(document.getElementById("settingsChip"), document.getElementById("settingsTab"),
  { mount: ctx.core.mountSettingsTab, front: ctx.core.settingsTabFront, open: ctx.core.settingsTabFront });
await ctx.run("core.settings.open");
assert.equal(chip.draw().front, true, "the settings tab is not in front");
await ctx.run("core.settings-tab.nav", { page: "look" });
const menu = () => document.querySelector("#settingsTab > .set-menu");

test("the menu has the width and the padding of the design and starts at the top of the tab", () => {
  assert.equal(getComputedStyle(document.getElementById("settingsTab")).gridTemplateColumns, "var(--set-menu-w) minmax(0, 1fr)");
  const style = getComputedStyle(menu());
  // jsdom does not expand a shorthand of several var() values, so the rule states each side.
  assert.deepEqual([style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft],
    ["var(--set-menu-pad-y)", "var(--set-menu-pad-x)", "var(--set-menu-pad-y)", "var(--set-menu-pad-x)"]);
  assert.equal(style.gap, "var(--set-menu-gap)");
  assert.equal(style.justifyContent, "flex-start");
  const chrome = declaration.chrome;
  assert.deepEqual(
    ["set-menu-w", "set-menu-pad-y", "set-menu-pad-x", "set-menu-gap", "set-menu-item-h", "set-menu-item-pad-start", "set-menu-icon", "set-search-icon-x", "set-search-pad-start", "set-search-pad-end"].map((name) => chrome[name]),
    ["204px", "10px", "8px", "1px", "30px", "10px", "16px", "9px", "30px", "44px"],
    "the menu tokens are not the lengths of the design",
  );
});

test("the search field stands on top with the search icon inside its start", () => {
  const first = menu().firstElementChild;
  assert.equal(first.className, "set-search", "the search field is not the first element of the menu");
  const glyph = first.querySelector(":scope > svg");
  assert.ok(glyph, "the search field has no icon");
  assert.equal(getComputedStyle(glyph).position, "absolute");
  assert.equal(getComputedStyle(glyph).left, "var(--set-search-icon-x)");
  const field = first.querySelector('input[data-expose="core.settings-tab.find"]');
  assert.equal(field.placeholder, "설정 찾기");
  assert.equal(getComputedStyle(field).height, "var(--field-h)");
  assert.equal(getComputedStyle(field).paddingLeft, "var(--set-search-pad-start)");
});

test("the group labels stand apart from the search field and the items", () => {
  const labels = [...menu().querySelectorAll(".set-menu__label")];
  assert.deepEqual(labels.map((label) => label.textContent), ["설정", "플러그인"]);
  for (const label of labels) {
    const style = getComputedStyle(label);
    assert.equal(style.margin, "0px", "a label keeps the margin of a paragraph");
    assert.deepEqual([style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft],
      ["var(--space-3)", "var(--set-menu-item-pad-start)", "var(--space-1)", "var(--set-menu-item-pad-start)"]);
    assert.equal(style.fontSize, "var(--text-small)");
    assert.equal(style.fontWeight, "600");
  }
});

test("each page item has the height of the design, its page icon at the start and its count at the end", () => {
  const items = [...menu().querySelectorAll('[data-expose="core.settings-tab.nav"]')];
  const pages = [...declaration.rows.pages.map((page) => page.id), "installed", "browse"];
  assert.deepEqual(items.map((item) => item.dataset.key), pages.map((page) => `nav:${page}`));
  for (const item of items) {
    const style = getComputedStyle(item);
    assert.equal(style.height, "var(--set-menu-item-h)", `${item.dataset.key} has no item height`);
    assert.deepEqual([style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft], ["0px", "var(--space-2)", "0px", "var(--set-menu-item-pad-start)"]);
    assert.equal(style.justifyContent, "flex-start", `${item.dataset.key} centers its label`);
    assert.equal(style.borderStyle, "none", `${item.dataset.key} has a border`);
    const glyph = item.firstElementChild;
    assert.equal(glyph?.tagName.toLowerCase(), "svg", `${item.dataset.key} has no icon at its start`);
    assert.equal(getComputedStyle(glyph).width, "var(--set-menu-icon)");
  }
  const look = items.find((item) => item.dataset.key === "nav:look");
  assert.equal(look.dataset.on, "true");
  assert.equal(getComputedStyle(look).fontWeight, "600", "the shown page is not bold");
  const browse = items.find((item) => item.dataset.key === "nav:browse");
  assert.equal(getComputedStyle(browse.lastElementChild).marginLeft, "auto", "the count does not stand at the end");
});

test("the icons of the menu are the declared design icons", () => {
  for (const page of declaration.rows.pages) {
    assert.ok(declaration.icons[page.icon], `the page ${page.id} names no declared icon`);
  }
  for (const name of ["settings-installed", "search", "chevron"]) {
    assert.ok(declaration.icons[name], `the icon ${name} is not declared`);
  }
});
