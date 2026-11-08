import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { addTabOfPlugin, cardSidebar, placeholderTabs, reading, replacePlaceholders, restoreRegistry, START_PROBE, START_PROBE_ENTRIES, startLayout, startTab,
  useRegistry } from "../start.mjs";

const PLUGIN = "startplugin";
const ENTRIES = Object.freeze([`status ${PLUGIN}.view`]);

/**
 * A fake session over a workbench state: core.grid, core.surfaces, core.settings and core.sidebars are read from `state`, the
 * commands that the start state runs change it, `until` and `registered` check the current state once, and every call is recorded.
 */
function workbench(state) {
  const calls = [];
  let next = 0;
  const s = {
    calls, state, cleanups: [],
    cleanup: (work) => s.cleanups.push(work),
    get: async (name) => {
      calls.push(["get", name]);
      if (name === "core.grid") return structuredClone(state.grid);
      if (name === "core.surfaces") return structuredClone(state.surfaces);
      if (name === "core.settings") return structuredClone(state.settings);
      if (name === "core.sidebars") return structuredClone(state.sidebars);
      throw new Error(`unexpected status ${name}`);
    },
    run: async (name, params) => {
      calls.push(["run", name, params]);
      if (name === "core.card.add-tab") {
        const tab = `added-${++next}`;
        const card = state.grid.cards.find((item) => item.id === params.card);
        card.tabs.push({ id: tab, plugin: params.plugin });
        card.active = tab;
        state.surfaces.push({ kind: "tab", surface: tab, plugin: params.plugin, visible: true, placeholder: null,
          status: { phase: "ready" }, exposes: [...ENTRIES] });
        return { tab };
      }
      if (name === "core.tab.close") {
        for (const card of state.grid.cards) if (card.tabs) card.tabs = card.tabs.filter((tab) => tab.id !== params.tab);
        state.surfaces = state.surfaces.filter((row) => row.surface !== params.tab);
        return null;
      }
      if (name === "core.settings.set") { state.settings.values.sets = params.patch.sets; return null; }
      if (name === "core.settings.link") {
        for (const card of state.grid.cards) {
          if (card.tabs?.find((tab) => tab.id === card.active)?.plugin === params.plugin) {
            state.sidebars.push({ sidebar: `${card.id}:left`, set: params.set });
          }
        }
        return null;
      }
      throw new Error(`unexpected command ${name}`);
    },
    until: async (name, predicate, message) => {
      calls.push(["until", name]);
      if (!predicate(await s.get(name))) throw new Error(message);
    },
    registered: async (surface, entries) => {
      calls.push(["registered", surface, entries]);
      const row = state.surfaces.find((item) => item.surface === surface);
      if (!entries.every((entry) => row?.exposes.includes(entry))) throw new Error(`surface ${surface} did not register ${entries.join(", ")}`);
    },
  };
  return s;
}

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
    settings: { common: {}, values: { sets: [] } },
    sidebars: [],
  };
}

test("the placeholder tabs of a layout are the tabs that core.surfaces reports with a placeholder, in card order", () => {
  const { grid, surfaces } = starterLayout();
  assert.deepEqual(placeholderTabs(grid, surfaces), [
    { card: "upper", tab: "t1", plugin: "starter-a" }, { card: "lower", tab: "b1", plugin: "starter-b" }]);
  assert.deepEqual(placeholderTabs(grid, surfaces.map((row) => ({ ...row, placeholder: null }))), []);
  assert.deepEqual(placeholderTabs(null, surfaces), []);
});

test("a start plugin that the start layout names itself keeps its tab, and the placeholders become tabs of the placeholder plugin", async () => {
  // The focused card holds an installed tab of the start plugin, so it opens as no placeholder; the other card is a placeholder.
  const layout = starterLayout();
  layout.grid.cards[1].tabs = [{ id: "t1", plugin: "named" }];
  layout.surfaces[0] = { kind: "tab", surface: "t1", plugin: "named", visible: true, placeholder: null, status: { phase: "ready" },
    exposes: ["status named.view"] };
  const s = workbench(layout);
  assert.deepEqual(await startLayout(s, { startPlugin: "named", startEntries: ["status named.view"], placeholderPlugin: PLUGIN }),
    { surface: "t1", plugin: "named" });
  assert.deepEqual(layout.grid.cards.slice(1).map((card) => card.tabs.map((tab) => tab.plugin)), [["named"], [PLUGIN]]);

  // Without a placeholder plugin the placeholders become tabs of the start plugin.
  const same = starterLayout();
  same.grid.cards[1].tabs = [{ id: "t1", plugin: "named" }];
  same.surfaces[0] = { ...layout.surfaces[0] };
  await startLayout(workbench(same), { startPlugin: "named", startEntries: ["status named.view"] });
  assert.deepEqual(same.grid.cards.slice(1).map((card) => card.tabs.map((tab) => tab.plugin)), [["named"], ["named"]]);
});

test("the start state replaces each placeholder by a tab of the given plugin and returns the ready tab of the focused card", async () => {
  const s = workbench(starterLayout());
  assert.deepEqual(await replacePlaceholders(s, PLUGIN), [{ card: "upper", tab: "added-1" }, { card: "lower", tab: "added-2" }]);
  // The new tab is added before the placeholder closes, so a card never loses its last tab.
  assert.deepEqual(s.calls.filter(([kind]) => kind === "run").map(([, name, params]) => [name, params]), [
    ["core.card.add-tab", { card: "upper", plugin: PLUGIN }], ["core.tab.close", { tab: "t1" }],
    ["core.card.add-tab", { card: "lower", plugin: PLUGIN }], ["core.tab.close", { tab: "b1" }]]);
  assert.deepEqual(await startTab(s, { startPlugin: PLUGIN, startEntries: ENTRIES }), { surface: "added-1", plugin: PLUGIN });
  assert.deepEqual(s.calls.at(-1), ["registered", "added-1", ENTRIES]);
});

test("the start probe that the package ships is the start plugin when a check names none", async () => {
  const s = workbench(starterLayout());
  await replacePlaceholders(s);
  assert.deepEqual(s.state.grid.cards.map((card) => card.tabs?.map((tab) => tab.plugin)), [undefined, [START_PROBE], [START_PROBE]]);
  // The fake registers the entries of the test plugin; the start probe registers its own view status.
  for (const row of s.state.surfaces) row.exposes = [...START_PROBE_ENTRIES];
  assert.deepEqual(await startTab(s), { surface: "added-1", plugin: START_PROBE });
  assert.deepEqual(s.calls.at(-1), ["registered", "added-1", ["status startprobe.view"]]);
  const probe = JSON.parse(readFileSync(new URL("../fixtures/start-probe/plugin.json", import.meta.url), "utf8"));
  assert.equal(probe.id, START_PROBE);
  assert.deepEqual(probe.exposes.status.map((entry) => `status ${entry.name}`), START_PROBE_ENTRIES);
});

test("a tab of the plugin under check is added to the focused card and the start state waits for its ready function", async () => {
  const s = workbench(starterLayout());
  await replacePlaceholders(s, PLUGIN);
  const seen = [];
  assert.deepEqual(await addTabOfPlugin(s, { plugin: "checked", ready: async (session, tab) => { seen.push(tab); } }),
    { surface: "added-3", plugin: "checked" });
  assert.deepEqual(seen, ["added-3"]);
  assert.deepEqual(s.calls.filter(([kind]) => kind === "run").at(-1), ["run", "core.card.add-tab", { card: "upper", plugin: "checked" }]);
  assert.deepEqual(await addTabOfPlugin(s, { plugin: "checked", ready: async () => ({ surface: "x", ready: true }) }), { surface: "x", ready: true });
  await assert.rejects(addTabOfPlugin(s, { plugin: "checked" }), /addPluginTab of checked names no ready function/);
  await assert.rejects(addTabOfPlugin(s, { ready: async () => {} }), /addPluginTab names no plugin/);
});

test("a start layout whose focused card holds no ready tab of the plugin fails", async () => {
  await assert.rejects(startTab(workbench(starterLayout()), { startPlugin: PLUGIN, startEntries: ENTRIES }),
    /focused card of the start layout holds no active startplugin tab/);
  const layout = starterLayout();
  const s = workbench(layout);
  await replacePlaceholders(s, PLUGIN);
  layout.surfaces.find((row) => row.surface === "added-1").status.phase = "loading";
  await assert.rejects(startTab(s, { startPlugin: PLUGIN, startEntries: ENTRIES }), /start tab added-1 did not become ready/);
  layout.surfaces.find((row) => row.surface === "added-1").status.phase = "ready";
  layout.surfaces.find((row) => row.surface === "added-1").exposes = [];
  await assert.rejects(startTab(s, { startPlugin: PLUGIN, startEntries: ENTRIES }), /did not register status startplugin.view/);
});

test("a card sidebar links a named set or stores its own common set of the given sections on the cards of the plugin", async () => {
  const linked = workbench(starterLayout());
  await replacePlaceholders(linked, PLUGIN);
  assert.deepEqual(await cardSidebar(linked, { plugin: PLUGIN, set: `${PLUGIN}.tabs` }), ["upper:left", "lower:left"]);
  assert.deepEqual(linked.calls.filter(([kind]) => kind === "run").at(-1),
    ["run", "core.settings.link", { place: "card-left", plugin: PLUGIN, set: `${PLUGIN}.tabs`, scope: "common" }]);
  assert.equal(linked.calls.some(([, name]) => name === "core.settings.set"), false, "a named set is linked, not stored");
  assert.equal(linked.cleanups.length, 1, "the sets and links are restored when the check ends");

  const own = workbench(starterLayout());
  await replacePlaceholders(own, PLUGIN);
  await cardSidebar(own, { plugin: PLUGIN, sections: ["other.alpha", "other.beta"] });
  assert.deepEqual(own.state.settings.values.sets, [{ id: "check-sections", title: "검사", sections: ["other.alpha", "other.beta"], layout: "list" }]);
  assert.ok(own.state.sidebars.every((item) => item.set === "check-sections"));
  // A second sidebar of the same check stores its sections in place of the set with the same id.
  await cardSidebar(own, { plugin: PLUGIN, sections: ["other.beta"] });
  assert.deepEqual(own.state.settings.values.sets, [{ id: "check-sections", title: "검사", sections: ["other.beta"], layout: "list" }]);

  const tabs = workbench(starterLayout());
  await replacePlaceholders(tabs, PLUGIN);
  await cardSidebar(tabs, { plugin: PLUGIN, set: "own-tabs", sections: ["other.alpha"], layout: "tabs" });
  assert.deepEqual(tabs.state.settings.values.sets, [{ id: "own-tabs", title: "검사", sections: ["other.alpha"], layout: "tabs" }]);

  await assert.rejects(cardSidebar(workbench(starterLayout()), { plugin: PLUGIN, set: "x" }), /no card shows an active startplugin tab/);
  await assert.rejects(cardSidebar(own, { set: "x" }), /a card sidebar names the plugin of its cards/);
  await assert.rejects(cardSidebar(own, { plugin: PLUGIN }), /a card sidebar names a set or the sections of its own set/);
});

test("a registry that a failed restore left is restored from the record of the first run", async (t) => {
  const configDir = mkdtempSync(join(tmpdir(), "check-registry-"));
  t.after(() => rmSync(configDir, { recursive: true, force: true }));
  let registry = "https://registry.example/index.json";
  let failing = false;
  const s = {
    app: { configDir },
    get: async (name) => { assert.equal(name, "core.plugins"); return { registry }; },
    run: async (name, { index }) => {
      assert.equal(name, "core.plugins.registry");
      if (failing) throw new Error("the registry command failed");
      registry = index;
    },
  };
  await restoreRegistry(s);
  assert.equal(registry, "https://registry.example/index.json");
  await useRegistry(s, "file:///first/index.json");
  failing = true;
  await assert.rejects(restoreRegistry(s), /the registry command failed/);
  failing = false;
  await useRegistry(s, "file:///second/index.json");
  assert.equal(registry, "file:///second/index.json");
  await restoreRegistry(s);
  assert.equal(registry, "https://registry.example/index.json", "a later run restored the registry that the failed restore left");
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
