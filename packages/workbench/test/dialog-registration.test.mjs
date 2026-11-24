// Checks the registration of the dialogs of plugin.json (docs/spec/plugins.md#dialogs): the environment registers each declared
// dialog of a plugin with a surface or with sections, the surface of a dialog starts with the start value dialog {name, opener}, an
// origin without a directory and no section, and the id of a dialog surface is neither a tab nor a section.
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<body></body>", { url: "https://example.test/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;

const environmentDocument = {
  runtime: "runtime",
  workspace: { focus: "main", grid: { root: { card: "main", tabs: [{ plugin: "card", title: "c 1" }] } } },
};
const card = {
  id: "card", name: "Card", description: "검사용 카드.", mark: "c", icon: "<path/>",
  surface: { composition: { kind: "view", page: "ui/page.html" } },
  dialogs: { edit: { page: "ui/edit.html" } },
};
const side = {
  id: "side", name: "Side", description: "검사용 섹션.",
  exposes: { status: [{ name: "side.list", description: "검사용 상태.", schema: { type: "object" } }] },
  sections: [{ id: "side.list", name: "List", composition: { kind: "view", page: "ui/list.html" }, height: "fill" }],
  dialogs: { confirm: { page: "ui/confirm.html" } },
};
const installed = { plugins: [
  { id: "card", package: "@fixture/card", version: "0.0.1", folder: "/installed/plugin", manifest: card },
  { id: "side", package: "@fixture/side", version: "0.0.1", folder: "/installed/plugin", manifest: side },
] };

const { installEnvironment } = await import("../environment.js");
const registry = await import("../registry.js");
const { viewStartValues } = await import("../surface-modules.js");
const { isDialogSurface, isSectionSurface } = await import("../exposure.js");

installEnvironment(structuredClone(environmentDocument), structuredClone(installed));

test("the environment registers the dialogs of a plugin with a surface and of a plugin with sections", () => {
  assert.equal(registry.dialog("card", "edit").page, "ui/edit.html");
  assert.equal(registry.dialog("side", "confirm").page, "ui/confirm.html");
  assert.equal(registry.dialog("card", "confirm"), null, "a name that the plugin does not declare is no dialog");
  assert.equal(registry.dialog("other", "edit"), null, "a plugin that is not registered has no dialog");
});

test("the surface of a dialog names the page, the plugin declarations and the start value dialog", () => {
  const surface = registry.dialog("side", "confirm").surface("spc-aaaaaa/left/side.list", { row: 3 });
  assert.equal(surface.surfaceId, "dialog/side/confirm");
  assert.equal(surface.pluginId, "side");
  assert.deepEqual(surface.composition, { kind: "view", page: "ui/confirm.html" });
  assert.deepEqual(surface.params, { row: 3 });
  assert.equal(surface.section, null);
  assert.deepEqual(surface.dialog, { name: "confirm", opener: "spc-aaaaaa/left/side.list" });
  assert.deepEqual(surface.declarations.status.map(({ name }) => name), ["side.list"]);
});

test("a dialog surface starts with its params, an origin without a directory, no section and its dialog", () => {
  const surface = registry.dialog("card", "edit").surface("tab-aaaaaa", null);
  const start = viewStartValues(surface, { id: "p1", root: "/work/p1", title: "p1" });
  assert.equal(start.params, null);
  assert.deepEqual(start.origin, { directory: null });
  assert.deepEqual(start.project, { id: "p1", root: "/work/p1" });
  assert.equal(start.section, null);
  assert.deepEqual(start.dialog, { name: "edit", opener: "tab-aaaaaa" });
});

test("the id of a dialog surface names a dialog, and a section id and a tab id do not", () => {
  assert.equal(isDialogSurface("dialog/card/edit"), true);
  assert.equal(isSectionSurface("dialog/card/edit"), false);
  assert.equal(isDialogSurface("spc-aaaaaa/left/side.list"), false);
  assert.equal(isSectionSurface("spc-aaaaaa/left/side.list"), true);
  assert.equal(isDialogSurface("tab-aaaaaa"), false);
});
