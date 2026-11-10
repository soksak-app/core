import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { cardSidebar, paintProbeDocument, placeholderTabs, pluginChangeStarted, probeListSections, probeSidebarSets, replacePlaceholders, restoreRegistry, settingsClosed, settingsShown, START_ENTRIES, START_PLUGIN, startTab, useRegistry } from "../fixture.mjs";

test("a registry that a failed restore left is restored from the record of the first run", async (t) => {
  const configDir = mkdtempSync(join(tmpdir(), "check-registry-"));
  t.after(() => rmSync(configDir, { recursive: true, force: true }));
  let registry = "https://registry.example/index.json";
  let failing = false;
  const s = {
    app: { configDir },
    get: async (name) => {
      assert.equal(name, "core.plugins");
      return { registry };
    },
    run: async (name, { index }) => {
      assert.equal(name, "core.plugins.registry");
      if (failing) throw new Error("the registry command failed");
      registry = index;
    },
  };

  await restoreRegistry(s);
  assert.equal(registry, "https://registry.example/index.json", "a restore without a held registry changed the registry");
  await useRegistry(s, "file:///first/index.json");
  assert.equal(registry, "file:///first/index.json");
  failing = true;
  await assert.rejects(restoreRegistry(s), /the registry command failed/);
  failing = false;

  await useRegistry(s, "file:///second/index.json");
  assert.equal(registry, "file:///second/index.json");
  await restoreRegistry(s);
  assert.equal(registry, "https://registry.example/index.json", "a later run restored the registry that the failed restore left");
  await restoreRegistry(s);
  assert.equal(registry, "https://registry.example/index.json");
  await useRegistry(s, "file:///third/index.json");
  await restoreRegistry(s);
  assert.equal(registry, "https://registry.example/index.json", "the record of an ended run was used again");
});

/**
 * A fake session over a workbench state: core.grid, core.surfaces, core.settings and core.sidebars are read from `state`, the
 * commands that fresh and cardSidebar run change it, `until` and `registered` check the current state once, and every call is
 * recorded.
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
          status: { phase: "ready" }, exposes: [...START_ENTRIES] });
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

/** A new-space layout whose environment names plugins that the fixture pack does not install, so its tabs are placeholders. */
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
      { kind: "section", surface: "s1", plugin: "layoutprobe", visible: true, placeholder: null, status: { phase: "ready" }, exposes: [] },
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

test("the start layout replaces each placeholder by a layout probe tab of its card and returns the ready tab of the focused card", async () => {
  const s = workbench(starterLayout());
  assert.deepEqual(await replacePlaceholders(s), [{ card: "upper", tab: "added-1" }, { card: "lower", tab: "added-2" }]);
  // The new tab is added before the placeholder closes, so a card never loses its last tab.
  assert.deepEqual(s.calls.filter(([kind]) => kind === "run").map(([, name, params]) => [name, params]), [
    ["core.card.add-tab", { card: "upper", plugin: START_PLUGIN }], ["core.tab.close", { tab: "t1" }],
    ["core.card.add-tab", { card: "lower", plugin: START_PLUGIN }], ["core.tab.close", { tab: "b1" }]]);
  assert.deepEqual(s.state.grid.cards.map((card) => card.tabs?.map((tab) => tab.plugin)), [undefined, [START_PLUGIN], [START_PLUGIN]]);
  assert.deepEqual(await startTab(s), { surface: "added-1", plugin: START_PLUGIN });
  assert.deepEqual(s.calls.at(-1), ["registered", "added-1", START_ENTRIES]);
  assert.equal(START_PLUGIN, "layoutprobe");
});

test("a start layout whose focused card holds no ready layout probe tab fails", async () => {
  await assert.rejects(startTab(workbench(starterLayout())), /focused card of the start layout holds no active layoutprobe tab/);
  const layout = starterLayout();
  const s = workbench(layout);
  await replacePlaceholders(s);
  layout.surfaces.find((row) => row.surface === "added-1").status.phase = "loading";
  await assert.rejects(startTab(s), /start tab added-1 did not become ready/);
  layout.surfaces.find((row) => row.surface === "added-1").status.phase = "ready";
  layout.surfaces.find((row) => row.surface === "added-1").exposes = ["status layoutprobe.view"];
  await assert.rejects(startTab(s), /did not register status layoutprobe.view, status layoutprobe.surface/);
});

test("a card sidebar stores its own set of the layout probe list sections, or of the given sections, and links it to the cards of the plugin", async () => {
  const listed = JSON.parse(readFileSync(new URL("../fixtures/layout-probe/layoutprobe/plugin.json", import.meta.url), "utf8"))
    .sidebars.sets.find((item) => item.id === "list").sections;
  assert.deepEqual(probeListSections(), listed);
  const s = workbench(starterLayout());
  await replacePlaceholders(s);
  assert.deepEqual(await cardSidebar(s), ["upper:left", "lower:left"]);
  assert.deepEqual(s.state.settings.values.sets, [{ id: "check-sections", title: "검사", sections: listed, layout: "list" }]);
  assert.deepEqual(s.calls.filter(([kind]) => kind === "run").at(-1),
    ["run", "core.settings.link", { place: "card-left", plugin: START_PLUGIN, set: "check-sections", scope: "common" }]);
  assert.ok(s.state.sidebars.every((item) => item.set === "check-sections"));
  assert.equal(s.cleanups.length, 1, "the sets and links are restored when the check ends");

  const tabs = workbench(starterLayout());
  await replacePlaceholders(tabs);
  await cardSidebar(tabs, { set: "check-tabs", sections: ["layoutprobe.alpha", "layoutprobe.beta"], layout: "tabs" });
  assert.deepEqual(tabs.state.settings.values.sets,
    [{ id: "check-tabs", title: "검사", sections: ["layoutprobe.alpha", "layoutprobe.beta"], layout: "tabs" }]);
  assert.ok(tabs.state.sidebars.every((item) => item.set === "check-tabs"));

  const own = workbench(starterLayout());
  await replacePlaceholders(own);
  own.state.settings.values.sets = [{ id: "check-sections", title: "old", sections: ["layoutprobe.beta"], layout: "list" }];
  await cardSidebar(own, { sections: ["layoutprobe.alpha", "layoutprobe.fill"] });
  assert.deepEqual(own.state.settings.values.sets, [{ id: "check-sections", title: "검사", sections: ["layoutprobe.alpha", "layoutprobe.fill"], layout: "list" }]);
  assert.ok(own.state.sidebars.every((item) => item.set === "check-sections"));
  await assert.rejects(cardSidebar(workbench(starterLayout())), /no card shows an active layoutprobe tab/);
});

test("the start layout module names no real plugin and imports no terminal helper", () => {
  const source = readFileSync(new URL("../fixture.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /terminal-screen|terminal-processes|terminal-ime-document|prepare-terminal|check-shell|check-zsh/);
  assert.doesNotMatch(source, /["'](terminal|term|browser|files|editor|hwp)["'.]/);
});

test("the sidebar sets of the configuration take the sections of the layout probe set of their layout and keep their ids", async () => {
  const s = workbench(starterLayout());
  s.state.settings.values.sets = [
    { id: "set-install", title: "탐색기", sections: ["files.tree", "files.bookmarks"], layout: "list" },
    { id: "set-browser", title: "브라우저", sections: ["browser.tabs", "browser.history"], layout: "tabs" },
  ];
  const declared = JSON.parse(readFileSync(new URL("../fixtures/layout-probe/layoutprobe/plugin.json", import.meta.url), "utf8")).sidebars.sets;
  const [list, tabs] = ["list", "tabs"].map((layout) => declared.find((set) => set.layout === layout).sections);
  assert.notDeepEqual(list, tabs, "the two layouts show different sections");
  assert.ok([...list, ...tabs].every((section) => section.startsWith(`${START_PLUGIN}.`)));
  const want = [
    { id: "set-install", title: "탐색기", sections: list, layout: "list" },
    { id: "set-browser", title: "브라우저", sections: tabs, layout: "tabs" },
  ];
  assert.deepEqual(await probeSidebarSets(s), want);
  assert.deepEqual(s.state.settings.values.sets, want);
  assert.deepEqual(s.calls.filter(([kind]) => kind === "run").at(-1), ["run", "core.settings.set", { patch: { sets: want }, scope: "common" }]);
  assert.equal(s.cleanups.length, 1, "the sets are restored when the check ends");

  const grid = workbench(starterLayout());
  grid.state.settings.values.sets = [{ id: "set-grid", title: "격자", sections: ["files.tree"], layout: "grid" }];
  await assert.rejects(probeSidebarSets(grid), /the layout probe declares no set of the layout grid of the set set-grid/);
  await assert.rejects(probeSidebarSets(workbench(starterLayout())), /the configuration holds no sidebar set/);
});

test("the settings dialog is shown when the modal web view of a main page shows it, and on the mygo host when core.modal names it", async () => {
  const shown = (state) => {
    const waited = [];
    const s = {
      get: async (name) => { if (name !== "host.window") throw new Error(`unexpected status ${name}`); return state["host.window"]; },
      until: async (name, predicate, message) => {
        waited.push(name);
        if (!predicate(state[name])) throw new Error(message);
        return state[name];
      },
    };
    return { s, waited };
  };
  const page = shown({ "host.window": { pageProcess: 7, modal: { id: "settings", shown: true } } });
  await settingsShown(page.s, "not shown");
  assert.deepEqual(page.waited, ["host.window"]);
  await assert.rejects(settingsShown(shown({ "host.window": { pageProcess: 7, modal: { id: "settings", shown: false } } }).s, "not shown"), /not shown/);

  const mygo = shown({ "host.window": { pageProcess: null, modal: null }, "core.modal": { id: "settings", mode: "dialog", document: null } });
  await settingsShown(mygo.s, "not shown");
  assert.deepEqual(mygo.waited, ["core.modal"]);
  await assert.rejects(settingsShown(shown({ "host.window": { pageProcess: null, modal: null }, "core.modal": null }).s, "not shown"), /not shown/);
});

test("the settings dialog is closed when the main page has no modal web view, and on the mygo host when core.modal is empty", async () => {
  const closed = (state) => {
    const waited = [];
    const s = {
      get: async (name) => { if (name !== "host.window") throw new Error(`unexpected status ${name}`); return state["host.window"]; },
      until: async (name, predicate, message) => {
        waited.push(name);
        if (!predicate(state[name])) throw new Error(message);
        return state[name];
      },
    };
    return { s, waited };
  };
  const page = closed({ "host.window": { pageProcess: 7, modal: null } });
  await settingsClosed(page.s, "not closed");
  assert.deepEqual(page.waited, ["host.window"]);
  await assert.rejects(settingsClosed(closed({ "host.window": { pageProcess: 7, modal: { id: "settings", shown: true } } }).s, "not closed"), /not closed/);

  const mygo = closed({ "host.window": { pageProcess: null, modal: null }, "core.modal": null });
  await settingsClosed(mygo.s, "not closed");
  assert.deepEqual(mygo.waited, ["core.modal"]);
  await assert.rejects(settingsClosed(closed({ "host.window": { pageProcess: null, modal: null }, "core.modal": { id: "settings", mode: "dialog", document: null } }).s, "not closed"), /not closed/);
});

test("the document region of a layout probe tab is painted after its document reports and is ready once it reports the colour", async () => {
  const calls = [];
  const document = { reported: false, color: null };
  let applies = true;
  const s = {
    until: async (name, predicate, message, params) => {
      calls.push(["until", name, params]);
      assert.equal(name, "layoutprobe.document");
      document.reported = true;
      if (!predicate(document)) throw new Error(message);
    },
    run: async (name, params, surface) => {
      calls.push(["run", name, params, surface]);
      assert.ok(document.reported, "the colour was posted before the document reported");
      if (applies) document.color = params.color;
    },
  };
  await paintProbeDocument(s, "probe-1", "rgb(25, 27, 36)");
  assert.deepEqual(calls, [
    ["until", "layoutprobe.document", { surface: "probe-1" }],
    ["run", "layoutprobe.document.color", { color: "rgb(25, 27, 36)" }, "probe-1"],
    ["until", "layoutprobe.document", { surface: "probe-1" }],
  ]);
  assert.equal(document.color, "rgb(25, 27, 36)");
  applies = false;
  await assert.rejects(paintProbeDocument(s, "probe-1", "rgb(250, 250, 250)"),
    /probe-1 did not paint its document region rgb\(250, 250, 250\)/);
});

test("a plugin change waits for the new start in the event log and reads the workbench only when the page is ready again", async (t) => {
  const configDir = mkdtempSync(join(tmpdir(), "check-plugin-change-"));
  t.after(() => rmSync(configDir, { recursive: true, force: true }));
  mkdirSync(join(configDir, "logs"));
  writeFileSync(join(configDir, "log-policy.json"),
    JSON.stringify({ schema: 1, classes: { lifecycle: "trace", input: "trace", call: "trace", io: "trace", frame: "trace" } }));
  const log = join(configDir, "logs", "host-1-10.jsonl");
  let seq = 0;
  const write = (event, fields) => appendFileSync(log,
    `${JSON.stringify({ ts_us: 1791000000000000 + ++seq, seq, level: "info", layer: "workbench", event, fields })}\n`);
  write("log.open", { schema: 3 });
  // The page starts again after the command answers. Until the host reports it ready, a page status refuses as the host does
  // (1003), so a watch of core.window.workbench ends with that refusal, which ended the cleanup of the outdated-service check.
  let workbench = { start: "old", readyState: "complete" };
  let ready = true;
  const notReady = () => Object.assign(new Error("the main page is not ready"), { code: 1003 });
  const calls = [];
  const s = {
    app: { configDir },
    // The connection of the fixture stays open, so the event line wait ends only by its line.
    client: { ended: new Promise(() => {}) },
    get: async (name) => {
      calls.push(["get", name]);
      if (name !== "core.window.workbench") throw new Error(`unexpected status ${name}`);
      if (!ready) throw notReady();
      return workbench;
    },
    until: async (name) => { calls.push(["until", name]); throw notReady(); },
    windows: async () => {
      calls.push(["windows"]);
      workbench = { start: "new", readyState: "complete" };
      ready = true;
    },
  };
  const change = async () => {
    calls.push(["run"]);
    ready = false;
    write("workbench.start", { url: "app://new" });
    return { reloaded: true };
  };
  const { workbench: started, result } = await pluginChangeStarted(s, change, "disabling probe");
  assert.deepEqual(started, { start: "new", readyState: "complete" });
  assert.deepEqual(result, { reloaded: true });
  assert.deepEqual(calls, [["get", "core.window.workbench"], ["run"], ["windows"], ["get", "core.window.workbench"]]);

  // A change that does not start the workbench again fails with its action.
  workbench = { start: "same", readyState: "complete" };
  const same = { ...s, windows: async () => {} };
  await assert.rejects(pluginChangeStarted(same, async () => { write("workbench.start", { url: "app://same" }); }, "enabling probe"),
    /enabling probe did not start the workbench again/);
});
