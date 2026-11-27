// The side shortcuts show or hide a window sidebar on the work screen (docs/spec/external-sidebars.md#window-tools): ⌘B the left side,
// ⌥⌘B the right side, ⇧⌘J the top side and ⌘J the bottom side.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import shortcutTable from "../shortcuts.json" with { type: "json" };
import { JSDOM } from "jsdom";
import { sideShortcut, textInputFocused } from "../window-sidebars.js";

const rows = [
  { key: "cmd+b", side: "left" },
  { key: "opt+cmd+b", side: "right" },
  { key: "shift+cmd+j", side: "top" },
  { key: "cmd+j", side: "bottom" },
];

test("the shortcut table holds one row of core.sidebar.toggle for each side, with its side parameter", () => {
  for (const { key, side } of rows) {
    const row = shortcutTable.shortcuts.find((entry) => entry.key === key && entry.owner === "workbench");
    assert.equal(row?.command, "core.sidebar.toggle", `the workbench row ${key} does not name core.sidebar.toggle`);
    assert.deepEqual(row.params, { side }, `the workbench row ${key} does not pass the side ${side}`);
    // The When column of docs/spec/exposure.md#keyboard-shortcuts states the parameter of a row with parameters.
    assert.equal(row.when, `The work screen is shown and no text input has focus; the command gets side ${side}`, `the workbench row ${key} has another condition`);
  }
});

test("the command of each side key toggles the side of its row, and the modifiers select the side", () => {
  const event = (code, { metaKey = true, altKey = false, shiftKey = false } = {}) => ({ code, key: code.slice(3).toLowerCase(), metaKey, altKey, shiftKey });
  assert.equal(sideShortcut(event("KeyB")), "left");
  assert.equal(sideShortcut(event("KeyB", { altKey: true })), "right");
  assert.equal(sideShortcut(event("KeyJ", { shiftKey: true })), "top");
  assert.equal(sideShortcut(event("KeyJ")), "bottom");
  assert.equal(sideShortcut(event("KeyB", { metaKey: false })), null, "B without the command key selects no side");
  assert.equal(sideShortcut(event("KeyK")), null, "a key without a side row selects no side");
});

test("the window page takes the side keys with the same table, and no side key is listed twice", () => {
  const source = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.match(source, /sideShortcut\(event\)/, "the window keydown handler does not read the side keys through sideShortcut");
  const keys = rows.map((row) => row.key);
  assert.equal(new Set(keys).size, keys.length);
});

test("a text input that has focus keeps the side keys for its own typing, and another element does not", (t) => {
  const dom = new JSDOM('<body><input id="field"><textarea id="area"></textarea><div id="edit" contenteditable="true"></div><button id="button">b</button></body>');
  t.after(() => dom.window.close());
  const { document } = dom.window;
  for (const id of ["field", "area", "edit"]) assert.equal(textInputFocused(document.getElementById(id)), true, `${id} is a text input`);
  assert.equal(textInputFocused(document.getElementById("button")), false, "a button takes no typed keys");
  assert.equal(textInputFocused(null), false, "no focused element takes no typed keys");
});
