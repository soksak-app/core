// The bell is the last element of the title bar on each screen: the work screen, the settings tab in front and the project home
// (docs/spec/external-sidebars.md#window-tools).
import assert from "node:assert/strict";
import { test } from "node:test";
import { titleTools } from "../title-tools.js";

const parts = {
  sidebarButtons: ["left", "right", "top", "bottom"], separator: "separator", settingsButton: "settings", bell: "bell",
};

test("the work screen shows the side switches, the separator and the settings button, and the bell last", () => {
  assert.deepEqual(titleTools({ ...parts, front: false, browsing: false }), ["left", "right", "top", "bottom", "separator", "settings", "bell"]);
});

test("the project home shows the settings button and the bell last", () => {
  assert.deepEqual(titleTools({ ...parts, front: false, browsing: true }), ["settings", "bell"]);
});

test("the settings tab in front shows no tool but the bell", () => {
  assert.deepEqual(titleTools({ ...parts, front: true, browsing: false }), ["bell"]);
});
