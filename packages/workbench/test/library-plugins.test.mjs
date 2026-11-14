import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { selectPageWire } from "@soksak/runtime";
import { installContributions } from "../contributions.js";
import { installExposure } from "../exposure.js";
import exposureFile from "../exposure.json" with { type: "json" };

installExposure(exposureFile);

// The plugin page of the library shows the name, description, state, version, sidecars, and operation buttons of each plugin
// (Plugin screen in docs/spec/installation.md). The host calls of the page are answered by the page-wire case of this test
// (docs/spec/cases/page-wire/README.md); the case is selected before the modules are imported, because the plugin operations take the
// host of the page when they are imported.
test("the plugin page of the library lists each plugin with its description, versions, sidecars and actions", async () => {
  const wire = selectPageWire("library-plugins-list");
  // The plane reads the elements of the page of the window when it is imported, so the library is drawn into that page.
  const markup = readFileSync(new URL("../index.html", import.meta.url), "utf8")
    .replace("</body>", "<div id=library></div></body>");
  const dom = new JSDOM(markup, { url: "http://localhost/" });
  dom.window.matchMedia = (query) => ({ media: query, matches: true, addEventListener: () => {}, removeEventListener: () => {} });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.devicePixelRatio = dom.window.devicePixelRatio;
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.CSS = dom.window.CSS;
  globalThis.PointerEvent = dom.window.PointerEvent;
  globalThis.MouseEvent = dom.window.MouseEvent;
  // The window loads the plugin tty, which the host lists as installed, enabled and in the same version.
  const { installEnvironment } = await import("../environment.js");
  assert.deepEqual(installEnvironment({
    runtime: "runtime",
    workspace: { focus: "main", grid: { xs: [0, 1], ys: [0, 1], cards: [{ id: "main", c0: 0, c1: 1, r0: 0, r1: 1, tabs: [{ plugin: "tty", title: "t" }] }] } },
    sidebars: { sets: [], links: [] },
  }, { plugins: [{ id: "tty", package: "@scope/tty", version: "0.1.0", manifest: {
    id: "tty", name: "터미널", description: "명령을 실행하는 표면.", mark: "t", icon: "<path/>",
    surface: { composition: { kind: "view", page: "ui/index.html" } },
  } }] }), [], "the fixture environment refused a plugin");
  // The tty plugin connects its item to the extension point items of the db plugin, which declares it with the version 1.0.0.
  installContributions([
    { id: "db", version: "2.0.0", package: "@x/db", manifest: { extends: { items: { version: "1.0.0", schema: {} } } } },
    { id: "tty", version: "0.1.0", package: "@scope/tty", manifest: { contributes: { "db.items": [{ range: "^1.0.0", module: "item.js" }] } } },
  ]);
  const { pluginOperations } = await import("../installed-plugins.js");
  const { createLibrary } = await import("../library.js?plugins");
  const { flushEvents } = await import("../page-log.js");
  // The replies of the host settle in the turns that follow the call.
  const settled = () => new Promise((resolve) => setImmediate(resolve));
  const root = document.getElementById("library");
  const library = createLibrary(root);
  const callsOf = (name) => wire.calls.filter((call) => call.name === name).length;
  try {
    library.render();
    assert.equal(library.state().page, "projects");
    assert.deepEqual(library.state().plugins, { query: "", shown: [], actions: [] });
    const tabs = [...root.querySelectorAll('[data-expose="core.library.page"]')];
    assert.deepEqual(tabs.map((tab) => [tab.textContent, tab.dataset.command, tab.dataset.params]), [
      ["프로젝트", "core.library.page", JSON.stringify({ page: "projects" })],
      ["플러그인", "core.library.page", JSON.stringify({ page: "plugins" })],
    ]);

    // An installation of db is running, so the host holds its reply.
    const installing = pluginOperations.run("install", "db");
    library.actions.page("plugins");
    assert.equal(callsOf("pluginsState"), 1, "showing the plugin page did not read the plugin state");
    assert.equal(callsOf("sidecarsOutdated"), 1, "showing the plugin page did not read the outdated sidecars");
    await settled();
    assert.equal(library.state().page, "plugins");
    // Each outdated service is a row above the cards with the action that ends its sessions and replaces it.
    const outdatedRows = [...root.querySelectorAll('[data-expose="core.library.plugins.outdated"]')];
    assert.deepEqual(outdatedRows.map((row) => [row.querySelector("p").textContent, row.querySelector("button").textContent,
      row.querySelector("button").dataset.command, row.querySelector("button").dataset.params]), [[
      "@fixture/sidecar-removed: 0.0.5 → 선언 없음", "세션 1개를 끝내고 종료", "core.plugins.replace",
      JSON.stringify({ sidecar: "@fixture/sidecar-removed" }),
    ], [
      "@fixture/sidecar-service: 0.0.3 → 0.0.7", "세션 2개를 끝내고 적용", "core.plugins.replace",
      JSON.stringify({ sidecar: "@fixture/sidecar-service" }),
    ]]);
    // The update list names each update and offers one action that updates all of them.
    const updateRows = [...root.querySelectorAll('[data-expose="core.library.plugins.updates"]')];
    assert.deepEqual(updateRows.map((row) => row.textContent), ["tty: 0.1.0 → 0.2.0"]);
    const updateAll = root.querySelector('[data-expose="core.library.plugins.update-all"]');
    assert.deepEqual([updateAll.textContent, updateAll.dataset.command], ["모두 업데이트", "core.plugins.update-all"]);
    assert.deepEqual(library.state().plugins.shown, ["db", "kept", "lone", "plain", "tty"]);
    assert.deepEqual(library.state().plugins.actions.map(({ plugin, action, disabled }) => `${plugin} ${action} ${disabled}`), [
      "db install true", "kept apply true", "kept disable true", "kept remove true", "plain enable true", "plain remove true",
      "tty update true", "tty disable true", "tty remove true",
    ]);
    const card = (id) => root.querySelector(`.library-plugin[data-plugin-id="${id}"]`);
    const text = (id, part) => card(id).querySelector(`.library-plugin__${part}`)?.textContent ?? null;
    assert.equal(card("db").querySelector("h2").textContent, "DB");
    assert.equal(text("db", "id"), "db");
    assert.equal(text("db", "state"), "설치 안 됨");
    assert.equal(text("db", "about"), "데이터베이스 표면.");
    // The description and the contribution lines of a card are elements of their own names, so a check measures where each host places them.
    const named = (id, name) => [...card(id).querySelectorAll(`[data-expose="core.library.plugins.${name}"]`)].map((line) => line.textContent);
    assert.deepEqual(named("db", "about"), ["데이터베이스 표면."]);
    assert.deepEqual(named("tty", "contribution"), ["db.items 기여 1: 연결됨"]);
    assert.deepEqual(named("db", "contribution"), [], "a card shows the contributions of another plugin");
    assert.equal(text("db", "versions"), "최신 버전 2.0.0");
    assert.equal(text("db", "sidecars"), "사이드카 @x/db ^1.0.0");
    assert.equal(text("db", "operation"), "db install 진행 중");
    assert.equal(text("tty", "state"), "사용 중");
    assert.equal(text("tty", "versions"), "설치된 버전 0.1.0 · 최신 버전 0.2.0");
    assert.equal(text("tty", "sidecars"), "사이드카 @scope/sidecar-probe 0.1.2");
    assert.equal(text("tty", "operation"), null, "the operation line shows on a card of another plugin");
    assert.equal(text("plain", "about"), null, "a plugin without a description shows an empty description");
    assert.equal(text("plain", "sidecars"), "사이드카 없음");
    const actions = (id) => [...card(id).querySelectorAll('[data-expose="core.library.plugins.action"]')]
      .map((button) => [button.textContent, button.dataset.command, button.dataset.params, button.disabled]);
    // While an operation runs, the operation buttons of all cards are disabled.
    assert.deepEqual(actions("db"), [["설치", "core.plugins.install", JSON.stringify({ plugin: "db" }), true]]);
    assert.deepEqual(actions("tty"), [
      ["업데이트", "core.plugins.update", JSON.stringify({ plugin: "tty" }), true],
      ["사용 안 함", "core.plugins.disable", JSON.stringify({ plugin: "tty" }), true],
      ["제거", "core.plugins.remove", JSON.stringify({ plugin: "tty" }), true],
    ]);
    assert.deepEqual(actions("plain").map(([label]) => label), ["사용", "제거"]);
    assert.equal(text("kept", "state"), "창을 다시 불러오면 적용");
    assert.equal(text("kept", "versions"), "설치된 버전 2.0.0 · core 0.0.24에 맞는 버전 없음");
    assert.equal(text("lone", "versions"), "core 0.0.24에 맞는 버전 없음");
    assert.equal(text("lone", "sidecars"), null, "a card without a selected version names no sidecars");
    // A command without params writes no data-params (createBinder mark), so the apply button has none.
    assert.deepEqual(actions("kept")[0], ["적용", "core.plugins.apply", undefined, true]);

    // The host ends the installation, and the page reads the plugin state again.
    wire.release();
    await installing;
    await settled();
    // A plugin operation that succeeds reloads the window, so the card states nothing after it.
    assert.equal(text("db", "operation"), null);
    assert.equal(actions("db")[0][3], false, "the actions stay disabled after the operation");

    const search = root.querySelector('[data-expose="core.library.plugins.search"]');
    assert.deepEqual([search.dataset.command, search.dataset.value], ["core.library.plugins.search", "query"]);
    library.actions.searchPlugins("명령");
    assert.deepEqual([library.state().plugins.query, library.state().plugins.shown], ["명령", ["tty"]]);
    library.actions.searchPlugins("없는플러그인");
    assert.deepEqual(library.state().plugins.shown, []);
    assert.equal(root.querySelector(".library-plugins-none")?.textContent, "찾는 플러그인이 없습니다.");
    library.actions.searchPlugins("");

    library.actions.page("projects");
    assert.deepEqual(library.state().plugins, { query: "", shown: [], actions: [] });
    assert.equal(root.querySelector(".library-plugin"), null);
    assert.throws(() => library.actions.page("themes"), /unknown library page themes/);
    await flushEvents();
    wire.finish();
  } finally {
    dom.window.close();
  }
});
