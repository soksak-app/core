import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

// 라이브러리의 플러그인 페이지는 플러그인마다 이름, 설명, 상태, 버전, 사이드카와 작업 단추를 보인다
// (docs/spec/installation.md 의 Plugin screen).
test("the plugin page of the library lists each plugin with its description, versions, sidecars and actions", async (t) => {
  const dom = new JSDOM("<body><div id=library></div></body>");
  globalThis.document = dom.window.document;
  t.mock.module("../projects.js", { namedExports: {
    inLibrary: () => true, all: () => [], isOpen: () => false, active: () => null,
  } });
  t.mock.module("../plane.js", { namedExports: { fresh: () => ({}) } });
  t.mock.module("@soksak/runtime", { namedExports: { host: null, windows: { createsFolders: false, folder: async (root) => ({ root }) } } });
  t.mock.module("../library-preview.js", { namedExports: { preview: () => document.createElement("div") } });
  t.mock.module("../commands.js", { namedExports: { delegate: () => {}, mark: (element, command, params, value) => {
    element.dataset.command = command;
    element.dataset.params = JSON.stringify(params ?? {});
    if (value) element.dataset.value = value;
  } } });
  t.mock.module("../icons.js", { namedExports: { icon: () => "" } });
  let refreshed = 0;
  const listeners = [];
  const status = {
    registry: "file:///registry/index.json", error: null, reload: false,
    // A persistent service that runs another version than the installed one, with the sessions that its replacement ends.
    outdated: [{ sidecar: "@fixture/sidecar-service", running: "0.0.3", installed: "0.0.7", sessions: 2 }],
    operation: { action: "install", plugin: "db", state: "running", error: null },
    plugins: [
      { id: "db", name: "DB", description: "데이터베이스 표면.", state: "available", installed: null, latest: "2.0.0",
        sidecars: [{ name: "@x/db", range: "^1.0.0", version: null }] },
      { id: "term", name: "터미널", description: "명령을 실행하는 표면.", state: "loaded", installed: { version: "0.1.0", enabled: true },
        latest: "0.2.0", sidecars: [{ name: "@soksak/sidecar-vt", range: "^0.1.0", version: "0.1.2" }] },
      // The window kept its page when the plugin changed, so the card offers to apply the change.
      { id: "kept", name: "kept", description: "", state: "reload", installed: { version: "2.0.0", enabled: true },
        latest: null, sidecars: [] },
      // The registry lists the installed version as its newest, so the card offers no update.
      { id: "plain", name: "plain", description: "", state: "disabled", installed: { version: "1.0.0", enabled: false },
        latest: "1.0.0", sidecars: [] },
    ],
  };
  let outdatedRefreshed = 0;
  const operations = {
    hosted: true, status: () => status, failure: () => null, refresh: async () => { refreshed++; },
    refreshOutdated: async () => { outdatedRefreshed++; },
  };
  t.mock.module("../installed-plugins.js", { namedExports: {
    pluginOperations: operations, onPluginOperations: (fn) => { listeners.push(fn); },
  } });
  const { createLibrary } = await import("../library.js?plugins");
  const root = document.getElementById("library");
  const library = createLibrary(root);
  try {
    library.render();
    assert.equal(library.state().page, "projects");
    assert.deepEqual(library.state().plugins, { query: "", shown: [], actions: [] });
    const tabs = [...root.querySelectorAll('[data-expose="core.library.page"]')];
    assert.deepEqual(tabs.map((tab) => [tab.textContent, tab.dataset.command, tab.dataset.params]), [
      ["프로젝트", "core.library.page", JSON.stringify({ page: "projects" })],
      ["플러그인", "core.library.page", JSON.stringify({ page: "plugins" })],
    ]);

    library.actions.page("plugins");
    assert.equal(refreshed, 1, "showing the plugin page did not read the plugin state");
    assert.equal(outdatedRefreshed, 1, "showing the plugin page did not read the outdated sidecars");
    assert.equal(library.state().page, "plugins");
    // Each outdated service is a row above the cards with the action that ends its sessions and replaces it.
    const outdatedRows = [...root.querySelectorAll('[data-expose="core.library.plugins.outdated"]')];
    assert.deepEqual(outdatedRows.map((row) => [row.querySelector("p").textContent, row.querySelector("button").textContent,
      row.querySelector("button").dataset.command, row.querySelector("button").dataset.params]), [[
      "@fixture/sidecar-service: 0.0.3 → 0.0.7", "터미널 2개를 끝내고 적용", "core.plugins.replace",
      JSON.stringify({ sidecar: "@fixture/sidecar-service" }),
    ]]);
    assert.deepEqual(library.state().plugins.shown, ["db", "term", "kept", "plain"]);
    assert.deepEqual(library.state().plugins.actions.map(({ plugin, action, disabled }) => `${plugin} ${action} ${disabled}`), [
      "db install true", "term update true", "term disable true", "term remove true", "kept apply true", "kept disable true", "kept remove true",
      "plain enable true", "plain remove true",
    ]);
    const card = (id) => root.querySelector(`.library-plugin[data-plugin-id="${id}"]`);
    const text = (id, part) => card(id).querySelector(`.library-plugin__${part}`)?.textContent ?? null;
    assert.equal(card("db").querySelector("h2").textContent, "DB");
    assert.equal(text("db", "id"), "db");
    assert.equal(text("db", "state"), "설치 안 됨");
    assert.equal(text("db", "about"), "데이터베이스 표면.");
    assert.equal(text("db", "versions"), "최신 버전 2.0.0");
    assert.equal(text("db", "sidecars"), "사이드카 @x/db ^1.0.0");
    assert.equal(text("db", "operation"), "db install 진행 중");
    assert.equal(text("term", "state"), "사용 중");
    assert.equal(text("term", "versions"), "설치된 버전 0.1.0 · 최신 버전 0.2.0");
    assert.equal(text("term", "sidecars"), "사이드카 @soksak/sidecar-vt 0.1.2");
    assert.equal(text("term", "operation"), null, "the operation line shows on a card of another plugin");
    assert.equal(text("plain", "about"), null, "a plugin without a description shows an empty description");
    assert.equal(text("plain", "sidecars"), "사이드카 없음");
    const actions = (id) => [...card(id).querySelectorAll('[data-expose="core.library.plugins.action"]')]
      .map((button) => [button.textContent, button.dataset.command, button.dataset.params, button.disabled]);
    // 작업이 실행되는 동안에는 모든 카드의 작업 단추가 비활성이다.
    assert.deepEqual(actions("db"), [["설치", "core.plugins.install", JSON.stringify({ plugin: "db" }), true]]);
    assert.deepEqual(actions("term"), [
      ["업데이트", "core.plugins.update", JSON.stringify({ plugin: "term" }), true],
      ["사용 안 함", "core.plugins.disable", JSON.stringify({ plugin: "term" }), true],
      ["제거", "core.plugins.remove", JSON.stringify({ plugin: "term" }), true],
    ]);
    assert.deepEqual(actions("plain").map(([label]) => label), ["사용", "제거"]);
    assert.equal(text("kept", "state"), "창을 다시 불러오면 적용");
    assert.deepEqual(actions("kept")[0], ["적용", "core.plugins.apply", JSON.stringify({}), true]);

    status.operation = { action: "install", plugin: "db", state: "done", error: null };
    for (const fn of listeners) fn();
    // A plugin operation that succeeds reloads the window, so the card states nothing after it.
    assert.equal(text("db", "operation"), null);
    assert.equal(actions("db")[0][3], false, "the actions stay disabled after the operation");

    const search = root.querySelector('[data-expose="core.library.plugins.search"]');
    assert.deepEqual([search.dataset.command, search.dataset.value], ["core.library.plugins.search", "query"]);
    library.actions.searchPlugins("명령");
    assert.deepEqual([library.state().plugins.query, library.state().plugins.shown], ["명령", ["term"]]);
    library.actions.searchPlugins("없는플러그인");
    assert.deepEqual(library.state().plugins.shown, []);
    assert.equal(root.querySelector(".library-plugins-none")?.textContent, "찾는 플러그인이 없습니다.");
    library.actions.searchPlugins("");

    // host 가 없으면 작업 단추가 없다.
    operations.hosted = false;
    library.render();
    assert.deepEqual(actions("term"), []);

    library.actions.page("projects");
    assert.deepEqual(library.state().plugins, { query: "", shown: [], actions: [] });
    assert.equal(root.querySelector(".library-plugin"), null);
    assert.throws(() => library.actions.page("themes"), /unknown library page themes/);
  } finally {
    dom.window.close();
  }
});
