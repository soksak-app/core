// 설치된 플러그인 목록과 작업(docs/spec/settings.md 의 플러그인 절).
import test from "node:test";
import assert from "node:assert/strict";
import { createPluginOperations, pluginRows } from "../plugin-operations.js";

const loaded = [
  { id: "term", name: "터미널", description: "터미널 표면.", version: "0.1.0" },
  { id: "notes", name: "노트", description: "노트 목록.", version: "1.0.0" },
  { id: "gone", name: "지운 것", description: "지운 플러그인.", version: "1.0.0" },
];

const entry = (id, name, versions) => ({ id, package: `plugin-${id}`, name, description: `${name} 설명.`, versions: versions.map((version) => ({ version })) });

const state = {
  registry: "file:///registry/index.json",
  index: { plugins: [entry("term", "Terminal", ["0.1.0", "0.10.0", "0.9.0"]), entry("db", "DB", ["2.0.0"]), entry("off", "Off", ["1.0.0"])] },
  installed: {
    format: 1,
    plugins: {
      term: { version: "0.1.0", enabled: true },
      notes: { version: "1.1.0", enabled: true },
      off: { version: "1.0.0", enabled: false },
      fresh: { version: "0.1.0", enabled: true },
    },
    sidecars: {},
  },
};

test("plugin rows join loaded, installed and registry plugins by id with their states", () => {
  assert.deepEqual(pluginRows(loaded, state), [
    { id: "db", name: "DB", description: "DB 설명.", state: "available", installed: null, latest: "2.0.0" },
    { id: "fresh", name: "fresh", description: "", state: "restart", installed: { version: "0.1.0", enabled: true }, latest: null },
    { id: "gone", name: "지운 것", description: "지운 플러그인.", state: "restart", installed: null, latest: null },
    { id: "notes", name: "노트", description: "노트 목록.", state: "restart", installed: { version: "1.1.0", enabled: true }, latest: null },
    { id: "off", name: "Off", description: "Off 설명.", state: "disabled", installed: { version: "1.0.0", enabled: false }, latest: "1.0.0" },
    { id: "term", name: "터미널", description: "터미널 표면.", state: "loaded", installed: { version: "0.1.0", enabled: true }, latest: "0.10.0" },
  ]);
});

test("a loaded plugin that was disabled after the window loaded waits for a restart", () => {
  const disabled = { ...state, installed: { ...state.installed, plugins: { term: { version: "0.1.0", enabled: false } } } };
  assert.equal(pluginRows([loaded[0]], disabled).find((row) => row.id === "term").state, "restart");
});

test("without a host only the loaded plugins are listed, all loaded, and operations fail", async () => {
  let changes = 0;
  const operations = createPluginOperations({ host: null, loaded: () => loaded, changed: () => { changes++; } });
  await operations.refresh();
  assert.deepEqual(operations.status().plugins.map((row) => [row.id, row.state]), [["gone", "loaded"], ["notes", "loaded"], ["term", "loaded"]]);
  await assert.rejects(operations.run("install", "db"), /plugin operations need a native host/);
  assert.equal(changes, 0);
});

/** 호출을 기록하고 정한 답을 주는 host. */
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
  assert.equal(operations.status().restart, true);
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

/** pluginsState 와 pluginsRun 을 흉내 내는 host. installed 가 비어 있으면 installed.json 이 없는 첫 실행이다. */
function starterHost({ registry = "file:///registry/index.json", index, firstRun = true }) {
  const calls = [];
  let first = firstRun;
  return {
    calls,
    async call(method, params) {
      calls.push([method, params ?? null]);
      if (method === "pluginsRun") { first = false; return null; }
      return { registry, index, installed: { format: 1, plugins: {}, sidecars: {} }, firstRun: first };
    },
  };
}

const starterIndex = { plugins: [], packs: [{ name: "starter", description: "Starter.", plugins: ["alpha", "beta"] }] };

test("the first run installs the starter pack in its order and asks for a reload", async () => {
  const host = starterHost({ index: starterIndex });
  const operations = createPluginOperations({ host, loaded: () => [], changed: () => {} });
  await operations.refresh();
  assert.equal(await operations.installStarter("starter", () => assert.fail("nothing to log")), true);
  assert.deepEqual(host.calls.filter(([method]) => method === "pluginsRun").map(([, params]) => params),
    [{ action: "install", plugin: "alpha" }, { action: "install", plugin: "beta" }]);
  // installed.json 이 생긴 뒤에는 다시 설치하지 않는다.
  assert.equal(await operations.installStarter("starter", () => {}), false);
});

test("the first run installs nothing without a pack, a host state or a first run", async () => {
  const later = starterHost({ index: starterIndex, firstRun: false });
  const operations = createPluginOperations({ host: later, loaded: () => [], changed: () => {} });
  await operations.refresh();
  assert.equal(await operations.installStarter("starter", () => {}), false);
  assert.equal(await operations.installStarter(null, () => {}), false);
  const hostless = createPluginOperations({ host: null, loaded: () => [], changed: () => {} });
  assert.equal(await hostless.installStarter("starter", () => {}), false);
});

test("the first run without a registry logs and a missing pack or unreadable index fails", async () => {
  const lines = [];
  const unset = createPluginOperations({ host: starterHost({ registry: null, index: null }), loaded: () => [], changed: () => {} });
  await unset.refresh();
  assert.equal(await unset.installStarter("starter", (line) => lines.push(line)), false);
  assert.deepEqual(lines, ["first run: no registry is set; the starter pack starter was not installed"]);
  const missing = createPluginOperations({ host: starterHost({ index: { plugins: [], packs: [] } }), loaded: () => [], changed: () => {} });
  await missing.refresh();
  await assert.rejects(missing.installStarter("starter", () => {}), /first run: the registry has no pack starter/);
  const unread = createPluginOperations({ host: starterHost({ index: { error: "index.json: no such file or directory" } }), loaded: () => [], changed: () => {} });
  await unread.refresh();
  await assert.rejects(unread.installStarter("starter", () => {}), /first run: index.json: no such file or directory/);
});
