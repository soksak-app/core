// The search of the settings matches a plugin by the name of its plugin category (docs/spec/settings.md#plugins).
import test from "node:test";
import assert from "node:assert/strict";
import { matchSettings } from "../settings-match.js";

test("a query matches a catalog plugin by the name of its plugin category", () => {
  const plugins = [{ id: "alpha", name: "알파", description: "", state: "available" }];
  const pluginUnits = [{ id: "alpha", name: "알파", description: "", categories: ["terminal"] }];
  const got = matchSettings({ query: "terminal", rows: [], pluginUnits, settingDefs: {}, plugins });
  assert.deepEqual(got.catalog.map((item) => item.id), ["alpha"]);
});

test("a query matches an installed plugin by the name of its plugin category", () => {
  const plugins = [{ id: "beta", name: "베타", description: "", state: "enabled" }];
  const pluginUnits = [{ id: "beta", name: "베타", description: "", categories: ["terminal"] }];
  const got = matchSettings({ query: "terminal", rows: [], pluginUnits, settingDefs: {}, plugins });
  assert.deepEqual(got.installed.map((item) => item.id), ["beta"]);
});
