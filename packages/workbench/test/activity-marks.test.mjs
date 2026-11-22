// Each activity icon is the declared share of the text size of its name, the gap to the name is the declared share of that size in
// every holder, and each activity has its own color, none of which is the error color (docs/spec/activity.md#drawing).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const css = await readFile(new URL("../app.css", import.meta.url), "utf8");
const settings = await readFile(new URL("../settings.js", import.meta.url), "utf8");

test("the icon and its gap are shares of the text size of the name in every holder", { timeout: 5000 }, () => {
  assert.match(css, /\.activity\{[^}]*width:var\(--activity-icon-em\)/, "the icon width is no share of the text size");
  assert.match(css, /\.activity\{[^}]*margin-right:calc\(var\(--activity-gap-em\) - var\(--activity-holder-gap\)\)/,
    "the gap of the icon is no share of the text size");
  for (const holder of [".tab", ".group__head", ".bar-tab"]) {
    assert.ok(css.includes(`${holder} .activity{--activity-text:`), `${holder} gives the icon no text size of its name`);
  }
});

test("each activity has its own color and none is the error color", { timeout: 5000 }, () => {
  const colors = Object.fromEntries([...css.matchAll(/\.activity\[data-activity=(\w+)\]\{color:var\((--[\w-]+)\)\}/g)].map((m) => [m[1], m[2]]));
  assert.deepEqual(colors, { attention: "--focus", failed: "--fail", running: "--rail", idle: "--muted" });
  assert.match(settings, /"--fail": c\.fail/, "the theme gives the page no fail color");
});
