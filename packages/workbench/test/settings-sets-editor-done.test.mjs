// The editor of an edited set ends with the button 완료, and the row of that set shows 완료 in place of 편집
// (docs/spec/settings.md#stored-sets-and-links).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { installExposure } from "../exposure.js";
import { beginSettings, setPluginSettings, setSidebarDefaults } from "../settings.js";
import { state } from "../settings-state.js";
import { setsPage } from "../settings-sets.js";

installExposure(JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")));

test("the editor of an edited set has the button 완료, and its row shows 완료 in place of 편집", (t) => {
  const dom = new JSDOM("<body></body>");
  t.after(() => dom.window.close());
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  setPluginSettings([]);
  const set = { id: "one", title: "One", layout: "list", sections: [] };
  setSidebarDefaults({ sets: [set], links: [] });
  beginSettings({ common: { sets: [set], links: [] }, projects: [] }, null);
  state.editing = "one";
  const root = dom.window.document.createElement("div");
  root.append(...setsPage());
  const row = root.querySelector('.set-set[data-set="one"]');
  const editor = root.querySelector('.set-editor[data-set="one"]');
  assert.ok(row && editor, "the row and the editor of the set are drawn");
  const rowLabels = [...row.querySelectorAll("button")].map((button) => button.textContent);
  assert.equal(rowLabels.includes("완료"), true, "the row shows 완료 while the set is edited");
  assert.equal(rowLabels.includes("편집"), false, "the row shows no 편집 while the set is edited");
  const editorLabels = [...editor.querySelectorAll("button")].map((button) => button.textContent);
  assert.equal(editorLabels.includes("완료"), true, "the editor ends with the button 완료");
});
