// The list of installed plugins and their operations (Plugin screen in docs/spec/installation.md).
import test from "node:test";
import assert from "node:assert/strict";
import { createPluginOperations, pluginRows } from "../plugin-operations.js";

const loaded = [
  { id: "term", name: "터미널", description: "터미널 표면.", version: "0.1.0", dependencies: {} },
  { id: "notes", name: "노트", description: "노트 목록.", version: "1.0.0", dependencies: {} },
  { id: "gone", name: "지운 것", description: "지운 플러그인.", version: "1.0.0", dependencies: {} },
];

const entry = (id, name, versions) => ({ id, package: `plugin-${id}`, name, description: `${name} 설명.`, versions: versions.map((version) => ({ version, sidecars: {} })) });

const state = {
  registry: "file:///registry/index.json",
  index: { plugins: [entry("term", "Terminal", ["0.1.0", "0.10.0", "0.9.0"]), entry("db", "DB", ["2.0.0"]), entry("off", "Off", ["1.0.0"])],
    revoked: { plugins: [], sidecars: [], core: [] } },
  installed: {
    format: 2,
    plugins: {
      term: { version: "0.1.0", enabled: true, sidecars: {} },
      notes: { version: "1.1.0", enabled: true, sidecars: {} },
      off: { version: "1.0.0", enabled: false, sidecars: {} },
      fresh: { version: "0.1.0", enabled: true, sidecars: {} },
    },
    sidecars: {},
  },
};

test("plugin rows join loaded, installed and registry plugins by id with their states", () => {
  assert.deepEqual(pluginRows(loaded, state), [
    { id: "db", name: "DB", description: "DB 설명.", state: "available", installed: null, latest: "2.0.0", sidecars: [] },
    { id: "fresh", name: "fresh", description: "", state: "reload", installed: { version: "0.1.0", enabled: true }, latest: null, sidecars: [] },
    { id: "gone", name: "지운 것", description: "지운 플러그인.", state: "reload", installed: null, latest: null, sidecars: [] },
    { id: "notes", name: "노트", description: "노트 목록.", state: "reload", installed: { version: "1.1.0", enabled: true }, latest: null, sidecars: [] },
    { id: "off", name: "Off", description: "Off 설명.", state: "disabled", installed: { version: "1.0.0", enabled: false }, latest: "1.0.0", sidecars: [] },
    { id: "term", name: "터미널", description: "터미널 표면.", state: "loaded", installed: { version: "0.1.0", enabled: true }, latest: "0.10.0", sidecars: [] },
  ]);
});

test("a plugin whose every registry version is revoked is not offered, and an installed one keeps its row without an update", () => {
  const withdrawn = {
    registry: "file:///registry/index.json",
    index: {
      plugins: [entry("appview", "AppView", ["0.0.2"]), entry("term", "Terminal", ["0.1.0", "0.10.0"])],
      revoked: { plugins: [{ id: "appview", version: "0.0.2", reason: "fixture" }, { id: "term", version: "0.10.0", reason: "fixture" }], sidecars: [], core: [] },
    },
    installed: { format: 2, plugins: { appview: { version: "0.0.2", enabled: true, sidecars: {} } }, sidecars: {} },
  };
  // The installed row keeps its version and has no latest version, so the update action is not offered for it.
  assert.deepEqual(pluginRows([], withdrawn).map((row) => [row.id, row.state, row.latest]), [["appview", "reload", null], ["term", "available", "0.1.0"]]);
  // Without an installed version, the plugin with only revoked versions has no row.
  const uninstalled = { ...withdrawn, installed: { ...withdrawn.installed, plugins: {} } };
  assert.deepEqual(pluginRows([], uninstalled).map((row) => row.id), ["term"]);
});

test("a loaded plugin that was disabled after the window loaded waits for a page reload", () => {
  const disabled = { ...state, installed: { ...state.installed, plugins: { term: { version: "0.1.0", enabled: false, sidecars: {} } } } };
  assert.equal(pluginRows([loaded[0]], disabled).find((row) => row.id === "term").state, "reload");
});

test("a row names its sidecars from the installed entry, else the newest registry version, else the manifest", () => {
  const probe = "@scope/sidecar-probe";
  const withSidecars = {
    registry: "file:///registry/index.json",
    index: { plugins: [{ id: "db", package: "plugin-db", name: "DB", description: "DB 설명.", versions: [
      { version: "1.0.0", sidecars: { "@x/old": "1.0.0" } },
      { version: "2.0.0", sidecars: { "@x/db": "^1.0.0", "@a/b": "1.0.0" } },
    ] }], revoked: { plugins: [], sidecars: [], core: [] } },
    installed: {
      format: 2,
      plugins: { term: { version: "0.1.0", enabled: true, sidecars: { [probe]: "^0.1.0" } } },
      sidecars: { [probe]: { version: "0.1.2", path: "/config/sidecars/scope-sidecar-probe/0.1.2/darwin-arm64" } },
    },
  };
  const term = { ...loaded[0], dependencies: { [probe]: "^0.1.0" } };
  const rows = pluginRows([term], withSidecars);
  assert.deepEqual(rows.find((row) => row.id === "term").sidecars, [{ name: probe, range: "^0.1.0", version: "0.1.2" }]);
  assert.deepEqual(rows.find((row) => row.id === "db").sidecars,
    [{ name: "@a/b", range: "1.0.0", version: null }, { name: "@x/db", range: "^1.0.0", version: null }]);
  // Without a host, it uses the dependencies of the loaded manifest.
  assert.deepEqual(pluginRows([term], null)[0].sidecars, [{ name: probe, range: "^0.1.0", version: null }]);
});

test("without a host only the loaded plugins are listed, all loaded, and operations fail", async () => {
  let changes = 0;
  const operations = createPluginOperations({ host: null, loaded: () => loaded, changed: () => { changes++; } });
  await operations.refresh();
  assert.deepEqual(operations.status().plugins.map((row) => [row.id, row.state]), [["gone", "loaded"], ["notes", "loaded"], ["term", "loaded"]]);
  await assert.rejects(operations.run("install", "db"), /plugin operations need a native host/);
  assert.equal(changes, 0);
});

test("status reports the installed plugins that the registry lists in a newer version", async () => {
  const operations = createPluginOperations({ host: fakeHost({ pluginsState: [state] }), loaded: () => loaded, changed: () => {} });
  await operations.refresh();
  assert.deepEqual(operations.status().updates, [{ id: "term", installed: "0.1.0", latest: "0.10.0" }]);
});

/** A host that records the calls and gives the set replies. */
function fakeHost(answers) {
  const calls = [];
  return {
    calls,
    call(name, arg) {
      calls.push(arg === undefined ? [name] : [name, arg]);
      const answer = answers[name].shift();
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
  };
}

test("an operation is recorded as running before the host call and its result after it", async () => {
  const seen = [];
  const host = fakeHost({ pluginsState: [state, state, state], pluginsRun: [{}, new Error("plugin db is not installed")] });
  const operations = createPluginOperations({ host, loaded: () => loaded, changed: () => seen.push(operations.status().operation) });
  await operations.refresh();
  await operations.run("install", "db");
  await assert.rejects(operations.run("remove", "db"), /plugin db is not installed/);
  assert.deepEqual(host.calls, [
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
});

test("an unreadable registry index keeps the installed rows and an unreadable state lists none", async () => {
  const broken = { ...state, index: { error: "/registry/index.json: no such file" } };
  const host = fakeHost({ pluginsState: [broken, new Error("installed.json is not valid JSON")] });
  const operations = createPluginOperations({ host, loaded: () => loaded, changed: () => {} });
  await operations.refresh();
  assert.equal(operations.status().error, "/registry/index.json: no such file");
  assert.deepEqual(operations.failure(), { kind: "index", message: "/registry/index.json: no such file" });
  assert.deepEqual(operations.status().plugins.map((row) => row.id), ["fresh", "gone", "notes", "off", "term"]);
  await operations.refresh();
  assert.deepEqual(operations.failure(), { kind: "state", message: "installed.json is not valid JSON" });
  assert.deepEqual(operations.status().plugins, []);
  await assert.rejects(operations.run("rename", "db"), /unknown plugin action rename/);
});

/** A host that imitates pluginsState and pluginsRun. When installed is empty, it is the first run, in which installed.json does not exist. */
function starterHost({ registry = "file:///registry/index.json", index, firstRun = true, useRegistry = null }) {
  const calls = [];
  let first = firstRun;
  let current = registry;
  return {
    calls,
    async call(method, params) {
      calls.push([method, params ?? null]);
      if (method === "pluginsRun") { first = false; return null; }
      if (method === "pluginsUseRegistry") {
        // A registry that cannot be fetched is not set.
        if (useRegistry !== null) throw new Error(useRegistry);
        current = params.index;
        return { index: current };
      }
      return { registry: current, index: current === null ? null : index, installed: { format: 2, plugins: {}, sidecars: {} }, firstRun: first };
    },
  };
}

const starterIndex = { plugins: [], revoked: { plugins: [], sidecars: [], core: [] }, packs: [{ name: "starter", description: "Starter.", plugins: ["alpha", "beta"] }] };

test("the first run installs the starter pack in its order and asks for a reload", async () => {
  const host = starterHost({ index: starterIndex });
  const operations = createPluginOperations({ host, loaded: () => [], changed: () => {} });
  await operations.refresh();
  assert.equal(await operations.installStarter("starter", null, () => assert.fail("nothing to log")), true);
  assert.deepEqual(host.calls.filter(([method]) => method === "pluginsRun").map(([, params]) => params),
    [{ action: "install", plugin: "alpha" }, { action: "install", plugin: "beta" }]);
  // After installed.json exists, the plugins are not installed again.
  assert.equal(await operations.installStarter("starter", null, () => {}), false);
});

test("the first run installs nothing without a pack, a host state or a first run", async () => {
  const later = starterHost({ index: starterIndex, firstRun: false });
  const operations = createPluginOperations({ host: later, loaded: () => [], changed: () => {} });
  await operations.refresh();
  assert.equal(await operations.installStarter("starter", null, () => {}), false);
  assert.equal(await operations.installStarter(null, null, () => {}), false);
  const hostless = createPluginOperations({ host: null, loaded: () => [], changed: () => {} });
  assert.equal(await hostless.installStarter("starter", null, () => {}), false);
});

test("the first run without a registry logs and a missing pack or unreadable index fails", async () => {
  const lines = [];
  const unset = createPluginOperations({ host: starterHost({ registry: null, index: null }), loaded: () => [], changed: () => {} });
  await unset.refresh();
  const shown = [];
  assert.equal(await unset.installStarter("starter", null, (line) => lines.push(line), (message) => shown.push(message)), false);
  assert.deepEqual(lines, ["first run: no registry is set; the starter pack starter was not installed"]);
  // A window without a plugin states the reason on the screen.
  assert.deepEqual(shown, ["플러그인 레지스트리가 없어 시작 플러그인 묶음 starter을 설치하지 못했습니다. sok registry use 로 레지스트리를 정한 뒤 다시 시작하세요."]);
});

test("a first run that cannot read the registry starts the window without the pack and states why", async () => {
  const cases = [
    [{ index: { plugins: [], packs: [] } }, null, "the registry has no pack starter"],
    [{ index: { error: "index.json: no such file or directory" } }, null, "index.json: no such file or directory"],
    // Without a network the default registry cannot be set.
    [{ registry: null, index: null, useRegistry: "https://soksak-app.github.io/registry/index.json: cannot connect: offline" },
      "https://soksak-app.github.io/registry/index.json", "https://soksak-app.github.io/registry/index.json: cannot connect: offline"],
  ];
  for (const [state, registry, error] of cases) {
    const operations = createPluginOperations({ host: starterHost(state), loaded: () => [], changed: () => {} });
    await operations.refresh();
    const lines = [];
    const shown = [];
    assert.equal(await operations.installStarter("starter", registry, (line) => lines.push(line), (message) => shown.push(message)), false);
    assert.deepEqual(lines, [`first run: the starter pack starter was not installed: ${error}`]);
    assert.deepEqual(shown, [`시작 플러그인 묶음 starter을 설치하지 못했습니다 · ${error}. 연결된 뒤 다시 시작하면 다시 설치합니다.`]);
  }
});

test("the first run sets the default registry of the environment before it installs the starter pack", async () => {
  const host = starterHost({ registry: null, index: starterIndex });
  const operations = createPluginOperations({ host, loaded: () => [], changed: () => {} });
  await operations.refresh();
  const registry = "https://soksak-app.github.io/registry/index.json";
  assert.equal(await operations.installStarter("starter", registry, () => assert.fail("nothing to log"), () => assert.fail("nothing to show")), true);
  assert.deepEqual(host.calls.filter(([method]) => method !== "pluginsState"), [
    ["pluginsUseRegistry", { index: registry }],
    ["pluginsRun", { action: "install", plugin: "alpha" }],
    ["pluginsRun", { action: "install", plugin: "beta" }],
  ]);
});

test("setting the registry runs pluginsUseRegistry and reads the state again", async () => {
  const host = starterHost({ registry: null, index: starterIndex, firstRun: false });
  const operations = createPluginOperations({ host, loaded: () => [], changed: () => {} });
  await operations.refresh();
  assert.equal(operations.status().registry, null);
  await operations.useRegistry("https://127.0.0.1:8443/index.json");
  assert.deepEqual(host.calls.at(-2), ["pluginsUseRegistry", { index: "https://127.0.0.1:8443/index.json" }]);
  assert.deepEqual(host.calls.at(-1), ["pluginsState", null]);
  assert.equal(operations.status().registry, "https://127.0.0.1:8443/index.json");
  const hostless = createPluginOperations({ host: null, loaded: () => [], changed: () => {} });
  await assert.rejects(hostless.useRegistry("https://127.0.0.1:8443/index.json"), /plugin operations need a native host/);
});

test("status reports the outdated sidecars that the host lists", async () => {
  const outdated = [{ sidecar: "@fixture/sidecar-service", running: "0.0.3", installed: "0.0.7", sessions: 2 }];
  const operations = createPluginOperations({ host: fakeHost({ sidecarsOutdated: [outdated] }), loaded: () => loaded, changed: () => {} });
  assert.deepEqual(operations.status().outdated, []);
  await operations.refreshOutdated();
  assert.deepEqual(operations.status().outdated, outdated);
});

test("replacing a sidecar runs the host call and reads the outdated sidecars again, also after a failure", async () => {
  const host = fakeHost({
    sidecarsReplace: [{}, new Error("sidecar probe: replace: close owner: boom")],
    sidecarsOutdated: [[], [{ sidecar: "probe", running: "0.0.3", installed: "0.0.7", sessions: 0 }]],
  });
  const operations = createPluginOperations({ host, loaded: () => loaded, changed: () => {} });
  await operations.replace("probe");
  await assert.rejects(operations.replace("probe"), /close owner: boom/);
  assert.deepEqual(host.calls, [
    ["sidecarsReplace", { sidecar: "probe" }], ["sidecarsOutdated"], ["sidecarsReplace", { sidecar: "probe" }], ["sidecarsOutdated"],
  ]);
  assert.equal(operations.status().outdated.length, 1);
});

test("without a host the outdated sidecars are empty and replacing fails", async () => {
  const operations = createPluginOperations({ host: null, loaded: () => loaded, changed: () => {} });
  await operations.refreshOutdated();
  assert.deepEqual(operations.status().outdated, []);
  await assert.rejects(operations.replace("probe"), /plugin operations need a native host/);
});

test("update-all updates the plugins of updates one after the other and stops at the first failure", async () => {
  const outdated = { ...state, installed: { ...state.installed, plugins: {
    term: { version: "0.1.0", enabled: true, sidecars: {} }, db: { version: "1.0.0", enabled: true, sidecars: {} },
  } } };
  const host = fakeHost({
    pluginsState: [outdated, outdated, outdated, outdated],
    pluginsRun: [{}, new Error("plugin term cannot be updated")],
  });
  const operations = createPluginOperations({ host, loaded: () => loaded, changed: () => {} });
  await operations.refresh();
  assert.deepEqual(operations.status().updates.map((update) => update.id), ["db", "term"]);
  await assert.rejects(operations.updateAll(), /plugin term cannot be updated/);
  assert.deepEqual(host.calls, [
    ["pluginsState"], ["pluginsRun", { action: "update", plugin: "db" }], ["pluginsState"],
    ["pluginsRun", { action: "update", plugin: "term" }], ["pluginsState"],
  ]);
  // Without an update the command does nothing and asks the host for nothing.
  const newest = { ...state, installed: { ...state.installed, plugins: { term: { version: "0.10.0", enabled: true, sidecars: {} } } } };
  const current = fakeHost({ pluginsState: [newest] });
  const quiet = createPluginOperations({ host: current, loaded: () => loaded, changed: () => {} });
  await quiet.refresh();
  assert.deepEqual(quiet.status().updates, []);
  await quiet.updateAll();
  assert.deepEqual(current.calls, [["pluginsState"]]);
});
