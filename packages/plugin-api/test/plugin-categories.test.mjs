// Compares the plugin categories of core that the validator holds with the case file that the validators of sok in Go and
// Rust are tested against (docs/spec/plugins.md#plugin-categories).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as api from "../index.js";

const CASES = JSON.parse(readFileSync(new URL("../../../docs/spec/cases/plugin-categories.json", import.meta.url), "utf8"));

test("plugin categories of the validator match the case file", () => {
  assert.deepEqual(api.PLUGIN_CATEGORIES, CASES.categories);
});

test("an environment value of a plugin setting must be a plugin id", () => {
  const environment = (value) => ({
    runtime: "runtime",
    workspace: { focus: "main", grid: { root: { card: "main", tabs: [{ plugin: "card", title: "c" }] } } },
    sidebars: { sets: [], links: [] },
    settings: { card: { terminal: value } },
  });
  const card = { id: "card", name: "Card", mark: "c", icon: "<path/>",
    surface: { composition: { kind: "view", page: "ui/page.html", regions: [{ name: "page", kind: "document", input: "native" }], overlays: [] } },
    settings: { terminal: { type: "plugin", category: "terminal", label: "Terminal" } } };
  api.checkReferences(environment("term"), [card]);
  for (const value of ["", "Term", 3, null]) {
    assert.throws(() => api.checkReferences(environment(value), [card]), { message: "environment.json: settings card.terminal: plugin value must be a plugin id" });
  }
});
