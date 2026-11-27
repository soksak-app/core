// The set line of the settings page shows the warning line of each plugin of its sections that cannot be loaded, and its chips of those
// sections are dashed and struck through (docs/spec/plugins.md#missing-plugins). The rows read the plugin states of the window.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { installExposure } from "../exposure.js";
import { beginSettings, setPluginSettings, setSidebarDefaults } from "../settings.js";
import { setsPage } from "../settings-sets.js";

installExposure(JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")));

test("a set line with a section of a plugin that is not loaded shows the warning line of that plugin and a dashed chip", (t) => {
  const dom = new JSDOM("<body></body>");
  t.after(() => dom.window.close());
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  setPluginSettings([]);
  const set = { id: "mixed", title: "Mixed", layout: "list", sections: ["gone.a", "gone.b"] };
  setSidebarDefaults({ sets: [set], links: [] });
  beginSettings({ common: { sets: [set], links: [] }, projects: [] }, null);
  const root = dom.window.document.createElement("div");
  root.append(...setsPage());
  const row = root.querySelector('.set-set[data-set="mixed"]');
  assert.ok(row, "the set row is drawn");
  const lines = [...row.querySelectorAll('[data-expose="core.sidebar.missing"]')];
  assert.equal(lines.length, 1, "one warning line for the plugin, however many of its sections the set holds");
  assert.equal(lines[0].dataset.plugin, "gone");
  assert.equal(lines[0].textContent, "gone(gone) 플러그인이 없어 섹션 2개를 못 보여 준다.");
  const chips = [...row.querySelectorAll(".set-chip--missing")];
  assert.deepEqual(chips.map((chip) => chip.textContent), ["gone.a", "gone.b"]);
  assert.equal(chips[0].title, "gone(gone) 플러그인 필요");
  assert.equal(row.textContent.includes("불러오지 않음"), false);
});
