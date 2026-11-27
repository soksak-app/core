// The folder caption of the project scope shows the whole path inside the width of the pane: a line breaks after a space, a hyphen and a
// path separator, and a name wider than the line breaks at the end of the line (docs/spec/settings.md#page-head). The caption is never
// shortened, and the other captions keep their line breaking.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { startSettingsTab, openSettingsTab } from "./support/settings-tab-window.mjs";

const ROOT = "/Users/someone/work-tree/a b/name\\with/" + "abcdefgh".repeat(14);
const ctx = await startSettingsTab(null, {
  project: "fixture",
  setup: async () => ({ common: {}, projects: [{ id: "fixture", root: ROOT, title: "fixture", spaces: [], settings: {} }] }),
});

test("the folder caption shows the whole path with a break after each space, hyphen and separator", async () => {
  await openSettingsTab(ctx);
  await ctx.run("core.settings-tab.scope", { scope: "project" });
  const folder = document.querySelector('[data-expose="core.settings-tab.folder"]');
  assert.ok(folder, "the project scope has no element core.settings-tab.folder");
  assert.equal(folder.textContent, ROOT, "the caption does not show the whole path");
  const breaks = [...folder.childNodes].map((node, index) => (node.nodeName === "WBR" ? folder.childNodes[index - 1]?.textContent.at(-1) : null))
    .filter((text) => text !== null);
  const wanted = [...ROOT].filter((char) => char === "/" || char === "\\" || char === "-" || char === " ");
  assert.deepEqual(breaks, wanted, `the caption breaks after ${JSON.stringify(breaks)}`);
});

test("the caption breaks a name wider than the line and is never shortened or cut off", () => {
  const css = readFileSync(new URL("../settings.css", import.meta.url), "utf8");
  const rule = (selector) => css.match(new RegExp(`(?:^|\\})\\s*${selector.replace(".", "\\.")}\\s*\\{([^}]*)\\}`, "m"))?.[1];
  const own = rule(".set-folder");
  assert.ok(own, "settings.css has no rule .set-folder");
  assert.match(own, /overflow-wrap:\s*anywhere/, "a name wider than the line does not break at the end of the line");
  assert.doesNotMatch(own, /white-space|text-overflow|overflow:/, "the caption is shortened, kept on one line or cut off");
});
