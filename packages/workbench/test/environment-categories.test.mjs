// Checks that a plugin which requires a plugin category that no loaded plugin serves is not loaded, that the other plugins start, and that the
// status of the plugin categories lists the loaded plugins of each category in the order of their ids (docs/spec/plugins.md#plugin-categories).
import assert from "node:assert/strict";
import test from "node:test";

const surface = { composition: { kind: "view", page: "ui/page.html", regions: [{ name: "page", kind: "document", input: "native" }], overlays: [] } };
const environmentFile = {
  runtime: "runtime",
  workspace: { focus: "main", grid: { root: { card: "main", tabs: [{ plugin: "lone-beta", title: "b" }] } } },
  sidebars: { sets: [], links: [] },
};
const plugin = (id, extra = {}) => ({ id, package: `@fixture/${id}`, version: "0.0.1", folder: "/installed/plugin",
  manifest: { id, name: id, description: `${id} 설명.`, mark: "p", icon: "<path/>", surface, ...extra } });

test("a plugin whose required category no loaded plugin serves is not loaded, with its error, and the other plugins start", async () => {
  const { installEnvironment, pluginUnits, pluginCategories, unmetPlugins } = await import("../environment.js?test=requires-unserved");
  const errors = installEnvironment(environmentFile, { plugins: [
    plugin("lone-gamma", { requires: ["terminal"] }),
    plugin("lone-beta"),
  ] });
  assert.deepEqual(errors, ["plugin lone-gamma requires a terminal plugin, and no loaded plugin is one"]);
  assert.deepEqual(pluginUnits().map((unit) => unit.id), ["lone-beta"]);
  assert.equal(unmetPlugins().get("lone-gamma"), "terminal");
  assert.deepEqual(pluginCategories(), { terminal: [] });
});

test("a plugin that requires a category is loaded when a loaded plugin serves it, and the status lists the served plugins by id", async () => {
  const { installEnvironment, pluginUnits, pluginCategories, unmetPlugins } = await import("../environment.js?test=requires-served");
  const errors = installEnvironment(environmentFile, { plugins: [
    plugin("term-two", { categories: ["terminal"] }),
    plugin("term-one", { categories: ["terminal"] }),
    plugin("lone-cli", { requires: ["terminal"] }),
    plugin("served-beta"),
  ] });
  assert.deepEqual(errors, []);
  assert.deepEqual(pluginUnits().map((unit) => unit.id).sort(), ["lone-cli", "served-beta", "term-one", "term-two"]);
  assert.equal(unmetPlugins().size, 0);
  assert.deepEqual(pluginCategories(), { terminal: [{ id: "term-one", name: "term-one" }, { id: "term-two", name: "term-two" }] });
});

test("the status of the plugin categories is declared in exposure.json", async () => {
  const { readFileSync } = await import("node:fs");
  const exposure = JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8"));
  const entry = exposure.exposes.status.find(({ name }) => name === "core.plugin-categories");
  assert.ok(entry, "core.plugin-categories is not declared");
  assert.equal(entry.schema.type, "object");
});
