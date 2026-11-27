// The core rows that a search matches are the same on both hosts: the Go host reads the same cases file (settings_search_test.go).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ALL_ROWS, PAGES } from "../settings-rows.js";
import { matchSettings } from "../settings-match.js";
import { pluginRows } from "../plugin-operations.js";

const cases = JSON.parse(readFileSync(new URL("./settings-search-cases.json", import.meta.url), "utf8")).cases;
// The host answer of the fixture is read by the production web reader of the plugin rows (pluginRows), so the plugin inputs of the
// matcher are the rows and units that a window builds from the answer.
const answer = JSON.parse(readFileSync(new URL("./fixtures/plugin-host-answer.json", import.meta.url), "utf8"));
const pluginUnits = answer.installed.plugins.map((item) => ({ id: item.id, name: item.manifest.name, description: item.manifest.description, version: item.version }));
const settingDefs = Object.fromEntries(answer.installed.plugins.flatMap((item) => Object.entries(item.manifest.settings ?? {})
  .map(([local, def]) => [`${item.id}.${local}`, { plugin: item.id, label: def.label, description: def.description }])));
const plugins = pluginRows(pluginUnits, answer.pluginsState, new Set());

test("a query matches the settings, the installed plugins and the catalog of the host answer in the declared order", () => {
  for (const { query, settings, plugins: pluginIds, catalog } of cases) {
    const got = matchSettings({ query, rows: ALL_ROWS, pluginUnits, settingDefs, plugins });
    assert.deepEqual(got.settings, settings, `settings of ${query}`);
    assert.deepEqual(got.pluginIds, pluginIds, `plugins of ${query}`);
    assert.equal(got.catalogCount, catalog, `catalog of ${query}`);
  }
});

test("the table is read from the rows section of the workbench declaration", () => {
  assert.equal(PAGES.length, 6);
  // The group Notifications has five rows, which replace the two problem toast rows of the earlier declaration, and the group 프로젝트 폴더 has the folder row.
  assert.equal(ALL_ROWS.length, 28);
});
