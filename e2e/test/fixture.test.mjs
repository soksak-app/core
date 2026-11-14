import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { connect } from "@soksak/client";
import { startCasePlayer } from "@soksak/client/testing";
import { Session } from "@soksak/window-check/app.mjs";

import { cardSidebar, paintProbeDocument, placeholderTabs, pluginChangeStarted, probeListSections, probeSidebarSets, replacePlaceholders, restoreRegistry, settingsClosed, settingsShown, START_ENTRIES, START_PLUGIN, startTab, useRegistry } from "../fixture.mjs";

/** A disposable configuration folder of an application; `log` is true for a check that reads its event log. */
function configFolder(t, log = false) {
  const configDir = mkdtempSync(join(tmpdir(), "check-fixture-"));
  t.after(() => rmSync(configDir, { recursive: true, force: true }));
  if (log) {
    mkdirSync(join(configDir, "logs"));
    writeFileSync(join(configDir, "log-policy.json"),
      JSON.stringify({ schema: 1, classes: { lifecycle: "trace", input: "trace", call: "trace", io: "trace", frame: "trace" } }));
  }
  return configDir;
}

/** The check session on a client that is connected to the case player of the case `name`; closing the player fails when the case was not played. */
async function play(t, name, configDir = configFolder(t)) {
  const server = await startCasePlayer(`fixture-${name}`);
  t.after(() => server.close());
  const client = await connect({ configDir: server.configDir });
  t.after(() => client.close());
  return { s: new Session({ name: "fixture", configDir }, client), server };
}

/** The commands that the player received, as [name, params] of each. */
const commands = (server) => server.requests.filter(({ method }) => method === "command.run").map(({ params }) => [params.name, params.params]);

/** The statuses that the player received a watch of, in order. */
const watched = (server) => server.requests.filter(({ method }) => method === "status.watch").map(({ params }) => params.name);

test("a registry that a failed restore left is restored from the record of the first run", async (t) => {
  const { s, server } = await play(t, "registry");
  await restoreRegistry(s);
  assert.deepEqual(server.requests, [], "a restore without a held registry sent a request");
  await useRegistry(s, "file:///first/index.json");
  await assert.rejects(restoreRegistry(s), /the registry command failed/);
  await useRegistry(s, "file:///second/index.json");
  await restoreRegistry(s);
  // A restore without a record sends nothing: the record of an ended run is not used again.
  const sent = server.requests.length;
  await restoreRegistry(s);
  assert.equal(server.requests.length, sent, "the record of an ended run was used again");
  await useRegistry(s, "file:///third/index.json");
  await restoreRegistry(s);
  assert.deepEqual(commands(server).map(([, params]) => params.index), [
    "file:///first/index.json", "https://registry.example/index.json", "file:///second/index.json", "https://registry.example/index.json",
    "file:///third/index.json", "https://registry.example/index.json"],
  "a later run restored the registry that the failed restore left");
});

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
  };
}

test("the placeholder tabs of a layout are the tabs that core.surfaces reports with a placeholder, in card order", () => {
  const { grid, surfaces } = starterLayout();
  assert.deepEqual(placeholderTabs(grid, surfaces), [
    { card: "upper", tab: "t1", plugin: "starter-a" }, { card: "lower", tab: "b1", plugin: "starter-b" }]);
  assert.deepEqual(placeholderTabs(grid, surfaces.map((row) => ({ ...row, placeholder: null }))), []);
  assert.deepEqual(placeholderTabs(null, surfaces), []);
});

test("the start layout replaces each placeholder by a layout probe tab of its card and returns the ready tab of the focused card", async (t) => {
  const { s, server } = await play(t, "start-layout");
  assert.deepEqual(await replacePlaceholders(s), [{ card: "upper", tab: "added-1" }, { card: "lower", tab: "added-2" }]);
  // The new tab is added before the placeholder closes, so a card never loses its last tab.
  assert.deepEqual(commands(server), [
    ["core.card.add-tab", { card: "upper", plugin: START_PLUGIN }], ["core.tab.close", { tab: "t1" }],
    ["core.card.add-tab", { card: "lower", plugin: START_PLUGIN }], ["core.tab.close", { tab: "b1" }]]);
  assert.deepEqual(await startTab(s), { surface: "added-1", plugin: START_PLUGIN });
  await server.played;
  assert.deepEqual(server.requests.slice(-3).map(({ method }) => method), ["status.watch", "status.get", "status.unwatch"]);
  assert.equal(server.requests.at(-2).params.name, "core.surfaces");
  assert.equal(START_PLUGIN, "layoutprobe");
});

test("a start layout whose focused card holds no ready layout probe tab fails", async (t) => {
  await assert.rejects(startTab((await play(t, "start-no-active")).s), /focused card of the start layout holds no active layoutprobe tab/);
  const loading = await play(t, "start-tab-loading");
  await replacePlaceholders(loading.s);
  await assert.rejects(startTab(loading.s), /start tab added-1 did not become ready/);
  const unregistered = await play(t, "start-tab-unregistered");
  await replacePlaceholders(unregistered.s);
  await assert.rejects(startTab(unregistered.s), /did not register status layoutprobe.view, status layoutprobe.surface/);
});

test("a card sidebar stores its own set of the layout probe list sections, or of the given sections, and links it to the cards of the plugin", async (t) => {
  const listed = JSON.parse(readFileSync(new URL("../fixtures/layout-probe/layoutprobe/plugin.json", import.meta.url), "utf8"))
    .sidebars.sets.find((item) => item.id === "list").sections;
  assert.deepEqual(probeListSections(), listed);
  const stored = (server) => commands(server).filter(([name]) => name === "core.settings.set").map(([, params]) => params.patch.sets);
  const list = await play(t, "sidebar-list");
  await replacePlaceholders(list.s);
  assert.deepEqual(await cardSidebar(list.s), ["upper:left", "lower:left"]);
  await list.server.played;
  assert.deepEqual(stored(list.server), [[{ id: "check-sections", title: "검사", sections: listed, layout: "list" }]]);
  assert.deepEqual(commands(list.server).at(-1),
    ["core.settings.link", { place: "card-left", plugin: START_PLUGIN, set: "check-sections", scope: "common" }]);
  assert.equal(list.s.cleanups.length, 1, "the sets and links are restored when the check ends");

  const tabs = await play(t, "sidebar-tabs");
  await replacePlaceholders(tabs.s);
  await cardSidebar(tabs.s, { set: "check-tabs", sections: ["layoutprobe.alpha", "layoutprobe.beta"], layout: "tabs" });
  await tabs.server.played;
  assert.deepEqual(stored(tabs.server), [[{ id: "check-tabs", title: "검사", sections: ["layoutprobe.alpha", "layoutprobe.beta"], layout: "tabs" }]]);
  assert.equal(commands(tabs.server).at(-1)[1].set, "check-tabs");

  const own = await play(t, "sidebar-replace");
  await replacePlaceholders(own.s);
  await cardSidebar(own.s, { sections: ["layoutprobe.alpha", "layoutprobe.fill"] });
  await own.server.played;
  assert.deepEqual(stored(own.server), [[{ id: "check-sections", title: "검사", sections: ["layoutprobe.alpha", "layoutprobe.fill"], layout: "list" }]]);
  assert.equal(commands(own.server).at(-1)[1].set, "check-sections");
  await assert.rejects(cardSidebar((await play(t, "sidebar-no-card")).s), /no card shows an active layoutprobe tab/);
});

test("the start layout module names no real plugin and imports no terminal helper", () => {
  const source = readFileSync(new URL("../fixture.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /terminal-screen|terminal-processes|terminal-ime-document|prepare-terminal|check-shell|check-zsh/);
  assert.doesNotMatch(source, /["'](terminal|term|browser|files|editor|hwp)["'.]/);
});

test("the sidebar sets of the configuration take the sections of the layout probe set of their layout and keep their ids", async (t) => {
  const declared = JSON.parse(readFileSync(new URL("../fixtures/layout-probe/layoutprobe/plugin.json", import.meta.url), "utf8")).sidebars.sets;
  const [list, tabs] = ["list", "tabs"].map((layout) => declared.find((set) => set.layout === layout).sections);
  assert.notDeepEqual(list, tabs, "the two layouts show different sections");
  assert.ok([...list, ...tabs].every((section) => section.startsWith(`${START_PLUGIN}.`)));
  const want = [
    { id: "set-install", title: "탐색기", sections: list, layout: "list" },
    { id: "set-browser", title: "브라우저", sections: tabs, layout: "tabs" },
  ];
  const sets = await play(t, "sidebar-sets");
  assert.deepEqual(await probeSidebarSets(sets.s), want);
  await sets.server.played;
  assert.deepEqual(commands(sets.server).at(-1), ["core.settings.set", { patch: { sets: want }, scope: "common" }]);
  assert.equal(sets.s.cleanups.length, 1, "the sets are restored when the check ends");
  await assert.rejects(probeSidebarSets((await play(t, "sidebar-sets-unknown-layout")).s),
    /the layout probe declares no set of the layout grid of the set set-grid/);
  await assert.rejects(probeSidebarSets((await play(t, "sidebar-sets-none")).s), /the configuration holds no sidebar set/);
});

test("the settings dialog is shown when the modal web view of a main page shows it, and on the mygo host when core.modal names it", async (t) => {
  const page = await play(t, "settings-shown-page");
  await settingsShown(page.s, "not shown");
  await page.server.played;
  assert.deepEqual(watched(page.server), ["host.window"]);
  await assert.rejects(settingsShown((await play(t, "settings-shown-page-hidden")).s, "not shown"), /not shown/);

  const mygo = await play(t, "settings-shown-mygo");
  await settingsShown(mygo.s, "not shown");
  await mygo.server.played;
  assert.deepEqual(watched(mygo.server), ["core.modal"]);
  await assert.rejects(settingsShown((await play(t, "settings-shown-mygo-none")).s, "not shown"), /not shown/);
});

test("the settings dialog is closed when the main page has no modal web view, and on the mygo host when core.modal is empty", async (t) => {
  const page = await play(t, "settings-closed-page");
  await settingsClosed(page.s, "not closed");
  await page.server.played;
  assert.deepEqual(watched(page.server), ["host.window"]);
  await assert.rejects(settingsClosed((await play(t, "settings-closed-page-shown")).s, "not closed"), /not closed/);

  const mygo = await play(t, "settings-closed-mygo");
  await settingsClosed(mygo.s, "not closed");
  await mygo.server.played;
  assert.deepEqual(watched(mygo.server), ["core.modal"]);
  await assert.rejects(settingsClosed((await play(t, "settings-closed-mygo-open")).s, "not closed"), /not closed/);
});

test("the document region of a layout probe tab is painted after its document reports and is ready once it reports the colour", async (t) => {
  const painted = await play(t, "paint-probe-document");
  await paintProbeDocument(painted.s, "probe-1", "rgb(25, 27, 36)");
  await painted.server.played;
  // The colour is posted after the document reported and the status of the document is read again after it.
  assert.deepEqual(painted.server.requests.filter(({ method }) => method !== "status.get" && method !== "status.unwatch").map(({ method, params }) => [method, params.name, params.surface]), [
    ["status.watch", "core.surfaces", undefined],
    ["status.watch", "layoutprobe.document", "probe-1"],
    ["command.run", "layoutprobe.document.color", "probe-1"],
    ["status.watch", "core.surfaces", undefined],
    ["status.watch", "layoutprobe.document", "probe-1"],
  ]);
  assert.deepEqual(commands(painted.server), [["layoutprobe.document.color", { color: "rgb(25, 27, 36)" }]]);
  await assert.rejects(paintProbeDocument((await play(t, "paint-probe-document-refused")).s, "probe-1", "rgb(250, 250, 250)"),
    /probe-1 did not paint its document region rgb\(250, 250, 250\)/);
});

test("a plugin change waits for the new start in the event log, reads the workbench only when the page is ready again and waits until that start is complete", async (t) => {
  const configDir = configFolder(t, true);
  const log = join(configDir, "logs", "host-1-10.jsonl");
  let seq = 0;
  const write = (event, fields) => appendFileSync(log,
    `${JSON.stringify({ ts_us: 1791000000000000 + ++seq, seq, level: "info", layer: "workbench", event, fields })}\n`);
  write("log.open", { schema: 3 });
  const changed = await play(t, "plugin-change", configDir);
  const sent = [];
  const change = async () => {
    sent.push(changed.server.requests.map(({ method, params }) => [method, params.name]));
    write("workbench.start", { url: "app://new" });
    return { reloaded: true };
  };
  const { workbench: started, result } = await pluginChangeStarted(changed.s, change, "disabling probe");
  assert.deepEqual(started, { start: "new", readyState: "complete" });
  assert.deepEqual(result, { reloaded: true });
  await changed.server.played;
  assert.deepEqual(sent, [[["status.get", "core.window.workbench"]]], "the change ran after the workbench was read and before the page was waited for");
  assert.deepEqual(changed.server.requests.filter(({ method }) => method !== "status.unwatch").map(({ method, params }) => [method, params.name]), [
    ["status.get", "core.window.workbench"], ["status.watch", "host.windows"], ["status.get", "host.windows"],
    ["status.get", "core.window.workbench"], ["status.watch", "core.window.workbench"], ["status.get", "core.window.workbench"]]);

  // A change that does not start the workbench again fails with its action.
  const same = await play(t, "plugin-change-same", configDir);
  await assert.rejects(pluginChangeStarted(same.s, async () => { write("workbench.start", { url: "app://same" }); }, "enabling probe"),
    /enabling probe did not start the workbench again/);
});
