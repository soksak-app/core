// The settings tab contract (docs/spec/settings.md): the status core.settings-tab, the commands and the rows of the tab, the undo toast,
// the search, the sets and the sidebar orders of a plugin. The window starts from index.html and the core commands run through the registry.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { pageMemorySaver } from "./support/memory-saver.mjs";

const dom = new JSDOM(readFileSync(new URL("../index.html", import.meta.url), "utf8"), { url: "http://localhost/" });
dom.window.matchMedia = (query) => ({ media: query, matches: true, addEventListener: () => {}, removeEventListener: () => {} });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.CSS = dom.window.CSS;
globalThis.Element = dom.window.Element;
globalThis.addEventListener = dom.window.addEventListener.bind(dom.window);
globalThis.PointerEvent = dom.window.PointerEvent;
globalThis.MouseEvent = dom.window.MouseEvent;

const memory = { common: {}, projects: [], refusals: 0 };
const settings = await import("../settings.js");
settings.setPluginSettings([{ id: "demo", surface: {} }]);
await settings.connectSettings({
  snapshot: async () => structuredClone(memory),
  settings: async (id, values) => { memory.common = { ...memory.common, ...values }; },
  onChange: () => () => {},
});
const { registry } = await import("../exposure.js");
registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
const { installCoreExposure } = await import("../core-exposure.js");
await installCoreExposure({
  memorySaver: await pageMemorySaver(),
  home: { state: () => null }, renames: { state: () => null }, chrome: () => null, drawn: async () => {},
});
const core = await import("../core-exposure.js");
const container = document.getElementById("settingsTab");

/** Reads a core status through the registry the way a surface does. */
const statusOf = (name) => registry.handle({ id: 1, method: "status.get", params: { name } }).then((reply) => {
  if (reply.error) throw new Error(reply.error.message);
  return reply.result;
});

/** Runs a command and returns its result; a refusal rejects with its message. */
const run = (name, params = {}) => registry.run(name, params);

const FIELDS = ["page", "scope", "find", "query", "filter", "browse", "listed", "actions", "plugin", "back", "editing", "rows", "controls",
  "scroll", "undo", "confirm", "errors", "results", "missing"];

test("the status core.settings-tab is null while the window has no settings tab", async () => {
  assert.equal(await statusOf("core.settings-tab"), null);
});

test("the tab is mounted once, and its status has every field of the table", async () => {
  await run("core.settings.open");
  core.mountSettingsTab(container);
  const status = await statusOf("core.settings-tab");
  assert.deepEqual(Object.keys(status).sort(), [...FIELDS].sort());
  assert.equal(status.page, "look");
  assert.equal(status.scope, "common");
  assert.equal(status.undo, null);
  assert.deepEqual(status.errors, []);
  assert.equal(status.results, null);
  assert.deepEqual(status.missing, []);
  assert.throws(() => core.mountSettingsTab(document.createElement("div")), /already mounted/);
});

test("the open and close commands bring the tab to the front and publish the front", async () => {
  await run("core.settings.close");
  const fronts = [];
  core.onSettingsTabFront((front) => fronts.push(front));
  await run("core.settings.open");
  assert.equal(core.settingsTabFront(), true);
  await run("core.settings.close");
  assert.equal(core.settingsTabFront(), false);
  assert.deepEqual(fronts, [true, false], "each change of the front is published once");
});

test("the nav command shows the page and the find command filters the menu", async () => {
  await run("core.settings-tab.nav", { page: "workspace" });
  assert.equal((await statusOf("core.settings-tab")).page, "workspace");
  await run("core.settings-tab.nav", { page: "behavior" });
  assert.equal((await statusOf("core.settings-tab")).page, "behavior");
  await run("core.settings-tab.find", { query: "사이드" });
  const status = await statusOf("core.settings-tab");
  assert.equal(status.find, "사이드");
  assert.ok(status.results.settings.includes("sidebarOrder"), "the search finds the sidebar order");
  await run("core.settings-tab.find", { query: "" });
});

test("a value change redraws only the row of the changed key, and the undo toast shows the change", async () => {
  await run("core.settings.open");
  await run("core.settings-tab.nav", { page: "look" });
  const rowOf = (key) => document.querySelector(`.set-row[data-row="${key}"]`);
  const other = rowOf("dim");
  const changed = rowOf("focusInd");
  assert.ok(other && changed, "the look page shows the rows dim and focusInd");
  await run("core.settings.change", { key: "focusInd", value: "corner", scope: "common" });
  assert.equal(rowOf("dim"), other, "a row of another key keeps its element");
  assert.notEqual(rowOf("focusInd"), changed, "the row of the changed key is drawn again");
  const status = await statusOf("core.settings-tab");
  assert.equal(status.undo.key, "focusInd");
  assert.equal(status.undo.new, "corner");
  await run("core.settings-tab.undo");
  assert.equal((await statusOf("core.settings-tab")).undo, null, "pressing the undo button removes the toast");
});

test("a set name of spaces only is refused with the text of the settings tab", async () => {
  await assert.rejects(run("core.settings.sets.update", { id: "set-1", title: "   " }), /이름이 필요하다\./);
});

test("the sidebar orders of a plugin are validated as orders, with the default order", async () => {
  await run("core.settings.change", { key: "demo.win.order", value: ["right", "left", "top", "bottom"], scope: "common" });
  await assert.rejects(
    run("core.settings.change", { key: "demo.card.order", value: ["left", "left", "top", "bottom"], scope: "common" }),
    /Invalid setting demo\.card\.order/,
  );
});
