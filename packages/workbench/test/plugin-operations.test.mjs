// The list of installed plugins and their operations (Plugin screen in docs/spec/installation.md).
import test from "node:test";
import assert from "node:assert/strict";
import { host, selectPageWire } from "@soksak/runtime";
import { createPluginOperations, pluginRows } from "../plugin-operations.js";

// The host calls of a test are answered by its page-wire case (docs/spec/cases/page-wire/README.md); the operations read the host of the
// runtime that the test selected.
let wire;
/** Selects the case plugin-operations-<name> and returns the host of the page. */
function open(name) {
  wire = selectPageWire(`plugin-operations-${name}`);
  return host;
}
/** The calls of the page as [name] or [name, payload]. */
const sent = (from = 0) => wire.calls.slice(from).map(({ name, payload }) => (payload === undefined ? [name] : [name, payload]));

const loaded = [
  { id: "tty", name: "터미널", description: "터미널 표면.", version: "0.1.0", dependencies: {} },
  { id: "notes", name: "노트", description: "노트 목록.", version: "1.0.0", dependencies: {} },
  { id: "gone", name: "지운 것", description: "지운 플러그인.", version: "1.0.0", dependencies: {} },
];

const entry = (id, name, versions) => ({ id, package: `plugin-${id}`, name, description: `${name} 설명.`, versions: versions.map((version) => ({ version, engines: { soksak: "*" }, sidecars: {} })) });

const state = {
  core: "0.0.24",
  registry: "file:///registry/index.json",
  index: { plugins: [entry("tty", "Terminal", ["0.1.0", "0.10.0", "0.9.0"]), entry("db", "DB", ["2.0.0"]), entry("off", "Off", ["1.0.0"])],
    revoked: { plugins: [], sidecars: [], core: [] } },
  installed: {
    format: 2,
    plugins: {
      tty: { version: "0.1.0", enabled: true, sidecars: {} },
      notes: { version: "1.1.0", enabled: true, sidecars: {} },
      off: { version: "1.0.0", enabled: false, sidecars: {} },
      fresh: { version: "0.1.0", enabled: true, sidecars: {} },
    },
    sidecars: {},
  },
};

test("plugin rows report loaded surface compositions before any tab is open", { timeout: 5000 }, () => {
  const units = [
    { ...loaded[0], surface: true, composition: "view" },
    loaded[1],
  ];
  const compositions = (rows) => rows.map(({ id, composition }) => ({ id, composition }));
  assert.deepEqual(compositions(pluginRows(units, state, new Set())), [
    { id: "db", composition: null },
    { id: "fresh", composition: null },
    { id: "notes", composition: null },
    { id: "off", composition: null },
    { id: "tty", composition: "view" },
  ], "the plugin status omits the surface kind of a view without a tab");
  assert.deepEqual(compositions(pluginRows(units, null, new Set())), [
    { id: "notes", composition: null },
    { id: "tty", composition: "view" },
  ], "a window without a native host must report the same loaded declaration");
});

test("plugin rows join loaded, installed and registry plugins by id with their states", () => {
  assert.deepEqual(pluginRows(loaded, state, new Set()), [
    { id: "db", name: "DB", description: "DB 설명.", state: "available", composition: null, installed: null, latest: "2.0.0", incompatible: false, sidecars: [] },
    { id: "fresh", name: "fresh", description: "", state: "reload", composition: null, installed: { version: "0.1.0", enabled: true }, latest: null, incompatible: false, sidecars: [] },
    { id: "gone", name: "지운 것", description: "지운 플러그인.", state: "reload", composition: null, installed: null, latest: null, incompatible: false, sidecars: [] },
    { id: "notes", name: "노트", description: "노트 목록.", state: "reload", composition: null, installed: { version: "1.1.0", enabled: true }, latest: null, incompatible: false, sidecars: [] },
    { id: "off", name: "Off", description: "Off 설명.", state: "disabled", composition: null, installed: { version: "1.0.0", enabled: false }, latest: "1.0.0", incompatible: false, sidecars: [] },
    { id: "tty", name: "터미널", description: "터미널 표면.", state: "loaded", composition: null, installed: { version: "0.1.0", enabled: true }, latest: "0.10.0", incompatible: false, sidecars: [] },
  ]);
});

test("the latest version of a row is the newest version whose range contains the running core, and a plugin without one is incompatible", { timeout: 5000 }, () => {
  const ranged = (id, versions) => ({ id, package: `plugin-${id}`, name: id, description: `${id} 설명.`,
    versions: versions.map(([version, range, sidecars = {}]) => ({ version, engines: { soksak: range }, sidecars })) });
  const running = {
    core: "0.0.24",
    registry: "file:///registry/index.json",
    index: { plugins: [
      ranged("pad", [["0.0.4", ">=0.0.18", { "@x/old": "^0.0.1" }], ["0.0.7", "^0.0.21", { "@x/old": "^0.0.2" }], ["0.0.9", "^0.0.24", { "@x/new": "^0.0.8" }]]),
      ranged("sheet", [["0.0.5", "0.0.21"], ["0.0.6", "0.0.23"]]),
    ], revoked: { plugins: [{ id: "pad", version: "0.0.4", reason: "r" }], sidecars: [], core: [] } },
    installed: { format: 3, plugins: { pad: { version: "0.0.3", enabled: true, sidecars: {} } }, sidecars: {} },
  };
  const rows = pluginRows([], running, new Set());
  assert.deepEqual(rows.map((row) => [row.id, row.latest, row.incompatible]), [["pad", "0.0.9", false], ["sheet", null, true]]);
  // An available plugin names the sidecars of the version that installation selects for the running core.
  const later = { ...running, index: { ...running.index, plugins: [ranged("pad", [["0.0.7", "^0.0.21", { "@x/old": "^0.0.2" }], ["0.0.9", "^0.0.24", { "@x/new": "^0.0.8" }], ["0.0.10", "^0.0.25", { "@x/next": "^0.0.9" }]])] },
    installed: { format: 3, plugins: {}, sidecars: {} } };
  assert.deepEqual(pluginRows([], later, new Set())[0].sidecars, [{ name: "@x/new", range: "^0.0.8", version: null }]);
  // An incompatible plugin that is neither installed nor loaded has no version to name sidecars from.
  assert.equal(rows.find((row) => row.id === "sheet").sidecars, null);
});

test("a plugin whose every registry version is revoked is not offered, and an installed one keeps its row without an update", () => {
  const withdrawn = {
    core: "0.0.24",
    registry: "file:///registry/index.json",
    index: {
      plugins: [entry("appview", "AppView", ["0.0.2"]), entry("tty", "Terminal", ["0.1.0", "0.10.0"])],
      revoked: { plugins: [{ id: "appview", version: "0.0.2", reason: "fixture" }, { id: "tty", version: "0.10.0", reason: "fixture" }], sidecars: [], core: [] },
    },
    installed: { format: 2, plugins: { appview: { version: "0.0.2", enabled: true, sidecars: {} } }, sidecars: {} },
  };
  // The installed row keeps its version and has no latest version, so the update action is not offered for it.
  assert.deepEqual(pluginRows([], withdrawn, new Set()).map((row) => [row.id, row.state, row.latest]), [["appview", "reload", null], ["tty", "available", "0.1.0"]]);
  // Without an installed version, the plugin with only revoked versions has no row.
  const uninstalled = { ...withdrawn, installed: { ...withdrawn.installed, plugins: {} } };
  assert.deepEqual(pluginRows([], uninstalled, new Set()).map((row) => row.id), ["tty"]);
});

test("an installed plugin that the window refused has the state refused and does not wait for a page reload", async () => {
  assert.equal(pluginRows(loaded, state, new Set(["fresh"])).find((row) => row.id === "fresh").state, "refused");
  const operations = createPluginOperations({ host: open("refused"), loaded: () => [loaded[0]],
    refused: () => new Set(["fresh"]), changed: () => {} });
  await operations.refresh();
  assert.equal(operations.status().reload, false, "a refused plugin made the page wait for a reload, which reloads it again");
  wire.finish();
});

test("a loaded plugin that was disabled after the window loaded waits for a page reload", () => {
  const disabled = { ...state, installed: { ...state.installed, plugins: { tty: { version: "0.1.0", enabled: false, sidecars: {} } } } };
  assert.equal(pluginRows([loaded[0]], disabled, new Set()).find((row) => row.id === "tty").state, "reload");
});

test("a row names its sidecars from the installed entry, else the registry version that installation selects, else the manifest", () => {
  const probe = "@scope/sidecar-probe";
  const withSidecars = {
    core: "0.0.24",
    registry: "file:///registry/index.json",
    index: { plugins: [{ id: "db", package: "plugin-db", name: "DB", description: "DB 설명.", versions: [
      { version: "1.0.0", engines: { soksak: "*" }, sidecars: { "@x/old": "1.0.0" } },
      { version: "2.0.0", engines: { soksak: "*" }, sidecars: { "@x/db": "^1.0.0", "@a/b": "1.0.0" } },
    ] }], revoked: { plugins: [], sidecars: [], core: [] } },
    installed: {
      format: 2,
      plugins: { tty: { version: "0.1.0", enabled: true, sidecars: { [probe]: "^0.1.0" } } },
      sidecars: { [probe]: { version: "0.1.2", path: "/config/sidecars/scope-sidecar-probe/0.1.2/darwin-arm64" } },
    },
  };
  const tty = { ...loaded[0], dependencies: { [probe]: "^0.1.0" } };
  const rows = pluginRows([tty], withSidecars, new Set());
  assert.deepEqual(rows.find((row) => row.id === "tty").sidecars, [{ name: probe, range: "^0.1.0", version: "0.1.2" }]);
  assert.deepEqual(rows.find((row) => row.id === "db").sidecars,
    [{ name: "@a/b", range: "1.0.0", version: null }, { name: "@x/db", range: "^1.0.0", version: null }]);
  // Without a host, it uses the dependencies of the loaded manifest.
  assert.deepEqual(pluginRows([tty], null, new Set())[0].sidecars, [{ name: probe, range: "^0.1.0", version: null }]);
});

test("without a host only the loaded plugins are listed, all loaded, and operations fail", async () => {
  let changes = 0;
  const operations = createPluginOperations({ host: null, loaded: () => loaded, refused: () => new Set(), changed: () => { changes++; } });
  await operations.refresh();
  assert.deepEqual(operations.status().plugins.map((row) => [row.id, row.state]), [["gone", "loaded"], ["notes", "loaded"], ["tty", "loaded"]]);
  await assert.rejects(operations.run("install", "db"), /plugin operations need a native host/);
  assert.equal(changes, 0);
});

test("status reports the installed plugins that the registry lists in a newer version", async () => {
  const operations = createPluginOperations({ host: open("updates"), loaded: () => loaded, refused: () => new Set(), changed: () => {} });
  await operations.refresh();
  assert.deepEqual(operations.status().updates, [{ id: "tty", installed: "0.1.0", latest: "0.10.0" }]);
  wire.finish();
});

test("an operation is recorded as running before the host call and its result after it", async () => {
  const seen = [];
  const operations = createPluginOperations({ host: open("running"), loaded: () => loaded, refused: () => new Set(), changed: () => seen.push(operations.status().operation) });
  await operations.refresh();
  await operations.run("install", "db");
  await assert.rejects(operations.run("remove", "db"), /plugin db is not installed/);
  assert.deepEqual(sent(), [
    ["pluginsState"], ["pluginsRun", { action: "install", plugin: "db" }], ["pluginsState"],
    ["pluginsRun", { action: "remove", plugin: "db" }], ["pluginsState"],
  ]);
  assert.deepEqual(seen, [
    null,
    { action: "install", plugin: "db", state: "running", error: null },
    { action: "install", plugin: "db", state: "done", error: null },
    { action: "remove", plugin: "db", state: "running", error: null },
    { action: "remove", plugin: "db", state: "failed", error: "plugin db is not installed" },
  ]);
  assert.equal(operations.status().reload, true);
  wire.finish();
});

test("an unreadable registry index keeps the installed rows and an unreadable state lists none", async () => {
  const operations = createPluginOperations({ host: open("unreadable"), loaded: () => loaded, refused: () => new Set(), changed: () => {} });
  await operations.refresh();
  assert.equal(operations.status().error, "/registry/index.json: no such file");
  assert.deepEqual(operations.failure(), { kind: "index", message: "/registry/index.json: no such file" });
  assert.deepEqual(operations.status().plugins.map((row) => row.id), ["fresh", "gone", "notes", "off", "tty"]);
  await operations.refresh();
  assert.deepEqual(operations.failure(), { kind: "state", message: "installed.json is not valid JSON" });
  assert.deepEqual(operations.status().plugins, []);
  await assert.rejects(operations.run("rename", "db"), /unknown plugin action rename/);
  wire.finish();
});

const starterIndex = { plugins: [], revoked: { plugins: [], sidecars: [], core: [] }, packs: [{ name: "starter", description: "Starter.", plugins: ["alpha", "beta"] }] };

/** The plugin calls of the page in the calls of the wire so far, as the list of the plugin ids of the pluginsRun calls. */
const runs = () => wire.calls.filter(({ name }) => name === "pluginsRun").map(({ payload }) => payload.plugin);
const makeOperations = () => createPluginOperations({ host, loaded: () => [], refused: () => new Set(), changed: () => {} });

test("the first run installs the starter pack in its order and asks for a reload", async () => {
  open("starter-first-run");
  const operations = makeOperations();
  await operations.refresh();
  assert.equal(await operations.installStarter("starter", null, () => assert.fail("nothing to log")), true);
  assert.deepEqual(wire.calls.filter(({ name }) => name === "pluginsRun").map(({ payload }) => payload),
    [{ action: "install", plugin: "alpha" }, { action: "install", plugin: "beta" }]);
  // After installed.json exists, the plugins are not installed again.
  assert.equal(await operations.installStarter("starter", null, () => {}), false);
  wire.finish();
});

test("the first run installs nothing without a pack, a host state or a first run", async () => {
  open("starter-later-run");
  const operations = makeOperations();
  await operations.refresh();
  assert.equal(await operations.installStarter("starter", null, () => {}), false);
  assert.equal(await operations.installStarter(null, null, () => {}), false);
  const hostless = createPluginOperations({ host: null, loaded: () => [], refused: () => new Set(), changed: () => {} });
  assert.equal(await hostless.installStarter("starter", null, () => {}), false);
  wire.finish();
});

test("the first run without a registry logs and a missing pack or unreadable index fails", async () => {
  const lines = [];
  const unset = createPluginOperations({ host: open("starter-no-registry"), loaded: () => [], refused: () => new Set(), changed: () => {} });
  await unset.refresh();
  const shown = [];
  assert.equal(await unset.installStarter("starter", null, (line) => lines.push(line), (message) => shown.push(message)), false);
  assert.deepEqual(lines, ["first run: no registry is set; the starter pack starter was not installed"]);
  // A window without a plugin states the reason on the screen.
  assert.deepEqual(shown, ["플러그인 레지스트리가 없어 시작 플러그인 묶음 starter을 설치하지 못했습니다. sok registry use 로 레지스트리를 정한 뒤 다시 시작하세요."]);
  wire.finish();
});

test("a first run that cannot read the registry starts the window without the pack and states why", async () => {
  const cases = [
    ["starter-no-pack", null, "the registry has no pack starter"],
    ["starter-index-error", null, "index.json: no such file or directory"],
    // Without a network the default registry cannot be set.
    ["starter-offline", "https://soksak-app.github.io/registry/index.json", "https://soksak-app.github.io/registry/index.json: cannot connect: offline"],
  ];
  for (const [name, registry, error] of cases) {
    const operations = createPluginOperations({ host: open(name), loaded: () => [], refused: () => new Set(), changed: () => {} });
    await operations.refresh();
    const lines = [];
    const shown = [];
    assert.equal(await operations.installStarter("starter", registry, (line) => lines.push(line), (message) => shown.push(message)), false);
    assert.deepEqual(lines, [`first run: the starter pack starter was not installed: ${error}`]);
    assert.deepEqual(shown, [`시작 플러그인 묶음 starter을 설치하지 못했습니다 · ${error}.`]);
    wire.finish();
  }
});

test("a first-run package-format failure preserves the error without promising network recovery", async () => {
  const formatError = "plugin.json: surface.module is required";
  const operations = createPluginOperations({ host: open("starter-format-failure"), loaded: () => [], refused: () => new Set(), changed: () => {} });
  await operations.refresh();
  const lines = [];
  const shown = [];
  assert.equal(await operations.installStarter("starter", null, (line) => lines.push(line), (message) => shown.push(message)), false);
  assert.deepEqual(lines, [`first run: the starter pack starter was not installed: ${formatError}`]);
  assert.deepEqual(shown, [`시작 플러그인 묶음 starter을 설치하지 못했습니다 · ${formatError}.`]);
  assert.ok(!shown[0].includes("연결된 뒤 다시 시작하면 다시 설치합니다"));
  wire.finish();
});

test("a refused starter install keeps its text in operation, log, and display", async () => {
  // The host answers a failed call with a text, and the runtime of each application rejects with an Error that holds it, so the reason
  // is that text; the formatting of a rejection with a code and data is judged by test/error-text.test.mjs.
  const operations = createPluginOperations({ host: open("starter-install-refused"), loaded: () => [], refused: () => new Set(), changed: () => {} });
  await operations.refresh();
  const lines = [];
  const shown = [];
  assert.equal(await operations.installStarter("starter", null, (line) => lines.push(line), (message) => shown.push(message)), false);
  const reason = "starter install refused";
  assert.equal(operations.status().operation.error, reason);
  assert.deepEqual(lines, [`first run: the starter pack starter was not installed: ${reason}`]);
  assert.deepEqual(shown, [`시작 플러그인 묶음 starter을 설치하지 못했습니다 · ${reason}.`]);
  wire.finish();
});

test("the first run sets the default registry of the environment before it installs the starter pack", async () => {
  open("starter-default-registry");
  const operations = makeOperations();
  await operations.refresh();
  const registry = "https://soksak-app.github.io/registry/index.json";
  assert.equal(await operations.installStarter("starter", registry, () => assert.fail("nothing to log"), () => assert.fail("nothing to show")), true);
  assert.deepEqual(sent().filter(([method]) => method !== "pluginsState"), [
    ["pluginsUseRegistry", { index: registry }],
    ["pluginsStarter", { state: "pending", pack: "starter", registry,
      plugins: ["alpha", "beta"] }],
    ["pluginsRun", { action: "install", plugin: "alpha" }],
    ["pluginsRun", { action: "install", plugin: "beta" }],
    ["pluginsStarter", { state: "complete", pack: "starter", registry,
      plugins: ["alpha", "beta"] }],
  ]);
  wire.finish();
});

test("a pending starter job resumes missing plugins after restart and stops enforcing after completion", async () => {
  open("starter-resume");
  // The case answers pluginsStarter with the pending job before the first plugin install: the job is durable first.
  const first = makeOperations();
  await first.refresh();
  assert.equal(await first.installStarter("starter", null, () => {}, () => {}), false);
  assert.equal(first.state().starter.state, "pending", "a failed plugin install must leave its job pending");
  assert.deepEqual(Object.keys(first.state().installed.plugins), ["alpha"]);

  const restarted = makeOperations();
  await restarted.refresh();
  assert.equal(restarted.state().firstRun, false, "the successful first plugin has created installed state");
  assert.equal(await restarted.installStarter("starter", null, () => {}, () => {}), true,
    "the pending starter job must resume although this is no longer the first run");
  assert.deepEqual(runs(), ["alpha", "beta", "beta"], "restart must install only the plugin missing from the pending job");
  assert.equal(restarted.state().starter.state, "complete");

  const afterUserRemoval = makeOperations();
  await afterUserRemoval.refresh();
  assert.equal(await afterUserRemoval.installStarter("starter", null, () => {}, () => {}), false,
    "a completed job must not reinstall a plugin that the user later removed");
  assert.deepEqual(runs(), ["alpha", "beta", "beta"]);
  wire.finish();
});

test("setting the registry runs pluginsUseRegistry and reads the state again", async () => {
  const operations = createPluginOperations({ host: open("use-registry"), loaded: () => [], refused: () => new Set(), changed: () => {} });
  await operations.refresh();
  assert.equal(operations.status().registry, null);
  await operations.useRegistry("https://127.0.0.1:8443/index.json");
  assert.deepEqual(sent().at(-2), ["pluginsUseRegistry", { index: "https://127.0.0.1:8443/index.json" }]);
  assert.deepEqual(sent().at(-1), ["pluginsState"]);
  assert.equal(operations.status().registry, "https://127.0.0.1:8443/index.json");
  const hostless = createPluginOperations({ host: null, loaded: () => [], refused: () => new Set(), changed: () => {} });
  await assert.rejects(hostless.useRegistry("https://127.0.0.1:8443/index.json"), /plugin operations need a native host/);
  wire.finish();
});

test("status reports the outdated sidecars that the host lists", async () => {
  const outdated = [{ sidecar: "@fixture/sidecar-service", running: "0.0.3", installed: "0.0.7", sessions: 2 }];
  const operations = createPluginOperations({ host: open("outdated"), loaded: () => loaded, refused: () => new Set(), changed: () => {} });
  assert.deepEqual(operations.status().outdated, []);
  await operations.refreshOutdated();
  assert.deepEqual(operations.status().outdated, outdated);
  wire.finish();
});

test("replacing a sidecar runs the host call and reads the outdated sidecars again, also after a failure", async () => {
  const operations = createPluginOperations({ host: open("replace"), loaded: () => loaded, refused: () => new Set(), changed: () => {} });
  await operations.replace("probe");
  await assert.rejects(operations.replace("probe"), /close owner: boom/);
  assert.deepEqual(sent(), [
    ["sidecarsReplace", { sidecar: "probe" }], ["sidecarsOutdated"], ["sidecarsReplace", { sidecar: "probe" }], ["sidecarsOutdated"],
  ]);
  assert.equal(operations.status().outdated.length, 1);
  wire.finish();
});

test("without a host the outdated sidecars are empty and replacing fails", async () => {
  const operations = createPluginOperations({ host: null, loaded: () => loaded, refused: () => new Set(), changed: () => {} });
  await operations.refreshOutdated();
  assert.deepEqual(operations.status().outdated, []);
  await assert.rejects(operations.replace("probe"), /plugin operations need a native host/);
});

test("update-all updates the plugins of updates one after the other and stops at the first failure", async () => {
  const operations = createPluginOperations({ host: open("update-all"), loaded: () => loaded, refused: () => new Set(), changed: () => {} });
  await operations.refresh();
  assert.deepEqual(operations.status().updates.map((update) => update.id), ["db", "tty"]);
  await assert.rejects(operations.updateAll(), /plugin tty cannot be updated/);
  assert.deepEqual(sent(), [
    ["pluginsState"], ["pluginsRun", { action: "update", plugin: "db" }], ["pluginsState"],
    ["pluginsRun", { action: "update", plugin: "tty" }], ["pluginsState"],
  ]);
  // Without an update the command does nothing and asks the host for nothing.
  const before = wire.calls.length;
  const quiet = createPluginOperations({ host, loaded: () => loaded, refused: () => new Set(), changed: () => {} });
  await quiet.refresh();
  assert.deepEqual(quiet.status().updates, []);
  await quiet.updateAll();
  assert.deepEqual(sent(before), [["pluginsState"]]);
  wire.finish();
});

test("a plugin state read that ended after a newer read does not replace its state", async () => {
  const operations = createPluginOperations({ host: open("read-order"), loaded: () => [], refused: () => new Set(), changed: () => {} });
  // The reply of the older read is held, and the newer read is answered first.
  const older = operations.refresh();
  const newer = operations.refresh();
  await newer;
  wire.release();
  await older;
  assert.equal(operations.status().registry, "file:///newer/index.json", "the older read replaced the state of the newer read");
  wire.finish();
});

test("a read that finds what the page holds calls no listener, and a read that finds a change calls it once", async () => {
  let changes = 0;
  const operations = createPluginOperations({ host: open("changed-once"), loaded: () => loaded, refused: () => new Set(), changed: () => { changes += 1; } });
  const counted = async (read) => { const before = changes; await read(); return changes - before; };
  assert.equal(await counted(operations.refresh), 1, "the first state");
  assert.equal(await counted(operations.refresh), 0, "the same state");
  assert.equal(await counted(operations.refresh), 1, "another state");
  assert.equal(await counted(operations.refresh), 1, "a failed read");
  assert.equal(await counted(operations.refresh), 0, "the same failure");
  assert.equal(await counted(operations.refreshOutdated), 0, "no outdated sidecar, as the page held");
  assert.equal(await counted(operations.refreshOutdated), 0, "still none");
  assert.equal(await counted(operations.refreshOutdated), 1, "an outdated sidecar");
  assert.equal(await counted(operations.refreshOutdated), 0, "the same outdated sidecar");
  wire.finish();
});
