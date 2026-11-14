import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { connect } from "@soksak/client";
import { startCasePlayer } from "@soksak/client/testing";

import { Session } from "../app.mjs";

import { addTabOfPlugin, cardSidebar, placeholderTabs, reading, replacePlaceholders, restoreRegistry, START_PROBE, START_PROBE_ENTRIES, startLayout, startTab,
  useRegistry } from "../start.mjs";

const PLUGIN = "startplugin";
const ENTRIES = Object.freeze([`status ${PLUGIN}.view`]);

// Starts the case player of the case and a real session on the real client of the package connected to it. Closing the player
// throws when the case was not played to its end.
async function workbench(t, name) {
  const server = await startCasePlayer(name);
  t.after(() => server.close());
  const client = await connect({ configDir: server.configDir });
  t.after(() => client.close());
  const configDir = mkdtempSync(join(tmpdir(), "check-start-"));
  t.after(() => rmSync(configDir, { recursive: true, force: true }));
  return { server, s: new Session({ name: "fixture", configDir }, client) };
}

/** The commands that the player received, as [name, params] of each. */
const commands = (server) => server.requests.filter(({ method }) => method === "command.run").map(({ params }) => [params.name, params.params]);

/** The methods of the requests that the player received. */
const methods = (server) => server.requests.map(({ method }) => method);

/** A new-space layout whose environment names plugins that the configuration does not load, so its tabs are placeholders. */
function starterLayout() {
  return {
    grid: { cards: [
      { id: "left", fixed: true, focused: false, active: null },
      { id: "upper", focused: true, active: "t1", tabs: [{ id: "t1", plugin: "starter-a" }] },
      { id: "lower", focused: false, active: "b1", tabs: [{ id: "b1", plugin: "starter-b" }] },
    ] },
    surfaces: [
      { kind: "tab", surface: "t1", plugin: "starter-a", visible: true, placeholder: "missing", status: { phase: "loading" }, exposes: [] },
      { kind: "tab", surface: "b1", plugin: "starter-b", visible: true, placeholder: "missing", status: { phase: "loading" }, exposes: [] },
      { kind: "section", surface: "s1", plugin: PLUGIN, visible: true, placeholder: null, status: { phase: "ready" }, exposes: [] },
    ],
  };
}

test("the placeholder tabs of a layout are the tabs that core.surfaces reports with a placeholder, in card order", () => {
  const { grid, surfaces } = starterLayout();
  assert.deepEqual(placeholderTabs(grid, surfaces), [
    { card: "upper", tab: "t1", plugin: "starter-a" }, { card: "lower", tab: "b1", plugin: "starter-b" }]);
  assert.deepEqual(placeholderTabs(grid, surfaces.map((row) => ({ ...row, placeholder: null }))), []);
  assert.deepEqual(placeholderTabs(null, surfaces), []);
});

test("a start plugin that the start layout names itself keeps its tab, and the placeholders become tabs of the placeholder plugin", async (t) => {
  // The focused card holds an installed tab of the start plugin, so it opens as no placeholder; the other card is a placeholder.
  const { server, s } = await workbench(t, "window-check-start-named-plugin");
  assert.deepEqual(await startLayout(s, { startPlugin: "named", startEntries: ["status named.view"], placeholderPlugin: PLUGIN }),
    { surface: "t1", plugin: "named" });
  assert.deepEqual(commands(server), [["core.card.add-tab", { card: "lower", plugin: PLUGIN }], ["core.tab.close", { tab: "b1" }]]);
  // The unwatch of the last wait is sent after the wait ends.
  await server.played;
});

test("without a placeholder plugin the placeholders become tabs of the start plugin", async (t) => {
  const { server, s } = await workbench(t, "window-check-start-named-plugin-same");
  await startLayout(s, { startPlugin: "named", startEntries: ["status named.view"] });
  assert.deepEqual(commands(server), [["core.card.add-tab", { card: "lower", plugin: "named" }], ["core.tab.close", { tab: "b1" }]]);
  // The unwatch of the last wait is sent after the wait ends.
  await server.played;
});

test("the start state replaces each placeholder by a tab of the given plugin and returns the ready tab of the focused card", async (t) => {
  const { server, s } = await workbench(t, "window-check-start-replace-placeholders");
  assert.deepEqual(await replacePlaceholders(s, PLUGIN), [{ card: "upper", tab: "added-1" }, { card: "lower", tab: "added-2" }]);
  // The new tab is added before the placeholder closes, so a card never loses its last tab.
  assert.deepEqual(commands(server), [
    ["core.card.add-tab", { card: "upper", plugin: PLUGIN }], ["core.tab.close", { tab: "t1" }],
    ["core.card.add-tab", { card: "lower", plugin: PLUGIN }], ["core.tab.close", { tab: "b1" }]]);
});

test("the start probe that the package ships is the start plugin when a check names none", async (t) => {
  const { server, s } = await workbench(t, "window-check-start-probe-tab");
  await replacePlaceholders(s);
  assert.deepEqual(commands(server).filter(([name]) => name === "core.card.add-tab").map(([, params]) => params.plugin), [START_PROBE, START_PROBE]);
  assert.deepEqual(await startTab(s), { surface: "added-1", plugin: START_PROBE });
  // The case registers the view status of the start probe.
  await server.played;
  assert.deepEqual(methods(server).slice(-3), ["status.watch", "status.get", "status.unwatch"]);
  const probe = JSON.parse(readFileSync(new URL("../fixtures/start-probe/plugin.json", import.meta.url), "utf8"));
  assert.equal(probe.id, START_PROBE);
  assert.deepEqual(probe.exposes.status.map((entry) => `status ${entry.name}`), START_PROBE_ENTRIES);
});

test("a tab of the plugin under check is added to the focused card and the start state waits for its ready function", async (t) => {
  const { server, s } = await workbench(t, "window-check-start-plugin-tab");
  await replacePlaceholders(s, PLUGIN);
  const seen = [];
  assert.deepEqual(await addTabOfPlugin(s, { plugin: "checked", ready: async (session, tab) => { seen.push(tab); } }),
    { surface: "added-3", plugin: "checked" });
  assert.deepEqual(seen, ["added-3"]);
  assert.deepEqual(commands(server).at(-1), ["core.card.add-tab", { card: "upper", plugin: "checked" }]);
  assert.deepEqual(await addTabOfPlugin(s, { plugin: "checked", ready: async () => ({ surface: "x", ready: true }) }), { surface: "x", ready: true });
  await assert.rejects(addTabOfPlugin(s, { plugin: "checked" }), /addPluginTab of checked names no ready function/);
  await assert.rejects(addTabOfPlugin(s, { ready: async () => {} }), /addPluginTab names no plugin/);
});

test("a start layout whose focused card holds no ready tab of the plugin fails", async (t) => {
  const { s } = await workbench(t, "window-check-start-tab-no-active");
  await assert.rejects(startTab(s, { startPlugin: PLUGIN, startEntries: ENTRIES }),
    /focused card of the start layout holds no active startplugin tab/);
});

test("a start tab that stays loading does not become ready", async (t) => {
  const { s } = await workbench(t, "window-check-start-tab-not-ready");
  await replacePlaceholders(s, PLUGIN);
  await assert.rejects(startTab(s, { startPlugin: PLUGIN, startEntries: ENTRIES }), /start tab added-1 did not become ready/);
});

test("a ready start tab that registered no entry of the plugin fails", async (t) => {
  const { s } = await workbench(t, "window-check-start-tab-not-registered");
  await replacePlaceholders(s, PLUGIN);
  await assert.rejects(startTab(s, { startPlugin: PLUGIN, startEntries: ENTRIES }), /did not register status startplugin.view/);
});

test("a card sidebar links a named set on the cards of the plugin", async (t) => {
  const { server, s } = await workbench(t, "window-check-start-sidebar-linked");
  await replacePlaceholders(s, PLUGIN);
  assert.deepEqual(await cardSidebar(s, { plugin: PLUGIN, set: `${PLUGIN}.tabs` }), ["upper:left", "lower:left"]);
  assert.deepEqual(commands(server).at(-1),
    ["core.settings.link", { place: "card-left", plugin: PLUGIN, set: `${PLUGIN}.tabs`, scope: "common" }]);
  assert.equal(commands(server).some(([name]) => name === "core.settings.set"), false, "a named set is linked, not stored");
  assert.equal(s.cleanups.length, 1, "the sets and links are restored when the check ends");
  await server.played;
});

test("a card sidebar stores its own common set of the given sections and replaces a set of the same id", async (t) => {
  const { server, s } = await workbench(t, "window-check-start-sidebar-own-set");
  await replacePlaceholders(s, PLUGIN);
  await cardSidebar(s, { plugin: PLUGIN, sections: ["other.alpha", "other.beta"] });
  const stored = () => commands(server).filter(([name]) => name === "core.settings.set").map(([, params]) => params.patch.sets);
  assert.deepEqual(stored(), [[{ id: "check-sections", title: "검사", sections: ["other.alpha", "other.beta"], layout: "list" }]]);
  assert.deepEqual(commands(server).filter(([name]) => name === "core.settings.link").map(([, params]) => params.set), ["check-sections"]);
  // A second sidebar of the same check stores its sections in place of the set with the same id.
  await cardSidebar(s, { plugin: PLUGIN, sections: ["other.beta"] });
  assert.deepEqual(stored().at(-1), [{ id: "check-sections", title: "검사", sections: ["other.beta"], layout: "list" }]);
  await server.played;
  await assert.rejects(cardSidebar(s, { set: "x" }), /a card sidebar names the plugin of its cards/);
  await assert.rejects(cardSidebar(s, { plugin: PLUGIN }), /a card sidebar names a set or the sections of its own set/);
});

test("a card sidebar with the layout tabs stores its set with that layout", async (t) => {
  const { server, s } = await workbench(t, "window-check-start-sidebar-tabs");
  await replacePlaceholders(s, PLUGIN);
  await cardSidebar(s, { plugin: PLUGIN, set: "own-tabs", sections: ["other.alpha"], layout: "tabs" });
  assert.deepEqual(commands(server).find(([name]) => name === "core.settings.set")[1].patch.sets,
    [{ id: "own-tabs", title: "검사", sections: ["other.alpha"], layout: "tabs" }]);
  await server.played;
});

test("a card sidebar of a plugin that no card shows fails", async (t) => {
  const { s } = await workbench(t, "window-check-start-sidebar-no-card");
  await assert.rejects(cardSidebar(s, { plugin: PLUGIN, set: "x" }), /no card shows an active startplugin tab/);
});

test("a registry that a failed restore left is restored from the record of the first run", async (t) => {
  const { server, s } = await workbench(t, "window-check-start-registry");
  await restoreRegistry(s);
  assert.deepEqual(server.requests, [], "a restore without a record sent a request");
  await useRegistry(s, "file:///first/index.json");
  await assert.rejects(restoreRegistry(s), /the registry command failed/);
  await useRegistry(s, "file:///second/index.json");
  await restoreRegistry(s);
  assert.deepEqual(commands(server).map(([, params]) => params.index),
    ["file:///first/index.json", "https://registry.example/index.json", "file:///second/index.json", "https://registry.example/index.json"],
    "a later run restored the registry that the failed restore left");
});

test("a wait declaration reads the record catalog of the configuration folder of the application", (t) => {
  const configDir = mkdtempSync(join(tmpdir(), "check-reading-"));
  t.after(() => rmSync(configDir, { recursive: true, force: true }));
  const { catalog, records } = reading({ configDir }, ["workbench.start"]);
  assert.deepEqual(records, ["workbench.start"]);
  assert.ok(catalog.events["workbench.start"]);
});

test("the start module names no real plugin", () => {
  const source = readFileSync(new URL("../start.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /["'](layoutprobe|terminal|term|browser|files|editor|hwp)["'.]/);
});

test("the start probe that the package ships is a valid plugin release", async () => {
  const { validateManifest } = await import("@soksak/plugin-api");
  const folder = new URL("../fixtures/start-probe/", import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL("plugin.json", folder), "utf8"));
  assert.doesNotThrow(() => validateManifest(manifest));
  const pkg = JSON.parse(readFileSync(new URL("package.json", folder), "utf8"));
  assert.deepEqual(pkg.files, ["plugin.json", "ui"]);
  assert.match(readFileSync(new URL(manifest.surface.composition.page, folder), "utf8"), /<script type="module" src="\.\/app\.js">/);
});
