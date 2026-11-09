import assert from "node:assert/strict";
import test from "node:test";
import { chromeSwitches } from "../window-sidebars.js";

// The window chrome has one switch per side in the fixed order left, right, top, bottom (docs/spec/external-sidebars.md#window-controls).
test("the chrome has a switch for each window side, named for showing its sidebar", () => {
  assert.deepEqual(chromeSwitches(), [
    { side: "left", icon: "panel-left", title: "왼쪽 사이드바 보이기", expose: "core.chrome.left" },
    { side: "right", icon: "panel-right", title: "오른쪽 사이드바 보이기", expose: "core.chrome.right" },
    { side: "top", icon: "panel-top", title: "위 사이드바 보이기", expose: "core.chrome.top" },
    { side: "bottom", icon: "panel-bottom", title: "아래 사이드바 보이기", expose: "core.chrome.bottom" },
  ]);
});

// The chrome reads its buttons by name, not by a position in a list, so a new switch moves no other button (docs/spec/external-sidebars.md).
test("the page script reads no chrome button by its position", async () => {
  const { readFile } = await import("node:fs/promises");
  const page = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.doesNotMatch(page, /chromeButtons\[\d+\]/, "index.html reads a chrome button by its index");
  assert.doesNotMatch(page, /chromeButtons\.slice\(\d+\)/, "index.html leaves out chrome buttons by their index");
});
