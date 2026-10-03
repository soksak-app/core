// 라이브러리의 플러그인 페이지: 설명, 버전, 사이드카, 검색, 플러그인 작업을 검사한다(docs/spec/installation.md 의 Plugin screen).
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, fresh, keepCommonSettings, open } from "./app.mjs";

/** 플러그인 페이지를 보이고, 검사가 끝나면 프로젝트 페이지와 작업 화면으로 돌아간다. */
async function showPlugins(s) {
  s.cleanup(async () => {
    if ((await s.get("core.screen")).screen !== "library") return;
    await s.run("core.library.plugins.search", { query: "" });
    await s.run("core.library.page", { page: "projects" });
    await s.run("core.library.return");
  });
  await s.run("core.plugins.browse");
  await s.until("core.screen", (screen) => screen.screen === "library", "core.plugins.browse did not show the library");
  return s.until("core.library", (library) => library.page === "plugins" && library.plugins.shown.length > 0,
    "the plugin page did not list plugins");
}

/** 카드가 보이는 plugin 의 작업 이름을 문서 순서로 반환한다. */
const actionsOf = (library, plugin) => library.plugins.actions.filter((item) => item.plugin === plugin).map((item) => item.action);

for (const app of Object.values(APPS)) {
  test(`${app.name}: the library plugin page lists plugins with descriptions, versions and sidecars`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    await keepCommonSettings(s);
    const library = await showPlugins(s);
    const plugins = await s.get("core.plugins");
    assert.deepEqual(library.plugins.shown, plugins.plugins.map((row) => row.id));
    assert.deepEqual(library.plugins.shown, ["browser", "files", "terminal"]);
    for (const row of plugins.plugins) {
      assert.ok(row.description.length > 0, `${row.id} shows no description`);
      assert.ok(row.installed?.version, `${row.id} shows no installed version: ${JSON.stringify(row)}`);
    }
    const terminal = plugins.plugins.find((row) => row.id === "terminal");
    assert.ok(terminal.sidecars.length > 0, `terminal lists no sidecar: ${JSON.stringify(terminal)}`);
    assert.ok(terminal.sidecars.every((sidecar) => typeof sidecar.version === "string"),
      `a terminal sidecar has no installed version: ${JSON.stringify(terminal.sidecars)}`);
    assert.deepEqual(actionsOf(library, "files"), ["update", "disable", "remove"]);

    await s.run("core.library.plugins.search", { query: "TERM" });
    await s.until("core.library", (value) => value.plugins.query === "TERM" && value.plugins.shown.join() === "terminal",
      "the plugin search did not keep only terminal");
    await s.run("core.library.plugins.search", { query: "없는플러그인" });
    await s.until("core.library", (value) => value.plugins.shown.length === 0, "a query without a match still lists plugins");
    await s.run("core.library.plugins.search", { query: "" });
    await s.until("core.library", (value) => value.plugins.shown.join() === library.plugins.shown.join(),
      "an empty query did not list every plugin");

    // 프로젝트 목록 명령은 프로젝트 페이지를 보인다.
    await s.run("core.library.return");
    await s.until("core.screen", (screen) => screen.screen === "workspace", "the library did not return to the workspace");
    await s.run("core.projects.browse");
    await s.until("core.library", (value) => value.page === "projects" && value.plugins.shown.length === 0 && value.shown.length > 0,
      "core.projects.browse did not show the project page");
  });

  test(`${app.name}: a plugin card disables and enables an installed plugin through its commands`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    await keepCommonSettings(s);
    // 검사가 중간에 실패해도 다음 검사가 같은 설치에서 시작하도록 files 를 다시 켠다.
    s.cleanup(async () => {
      const now = (await s.get("core.plugins")).plugins.find((row) => row.id === "files");
      if (!now.installed.enabled) await s.run("core.plugins.enable", { plugin: "files" });
    });
    await showPlugins(s);
    const listed = await s.until("core.plugins", (value) => value.plugins.some((row) => row.id === "files"),
      "core.plugins did not list files");
    assert.equal(listed.plugins.find((row) => row.id === "files").state, "loaded");
    assert.equal(listed.restart, false);

    assert.ok(actionsOf(await s.get("core.library"), "files").includes("disable"), "the files card has no 사용 안 함");
    await s.run("core.plugins.disable", { plugin: "files" });
    const disabled = await s.until("core.plugins", (value) => value.operation?.state === "done"
      && value.plugins.find((row) => row.id === "files").state === "restart", "disabling files did not wait for a restart");
    assert.deepEqual(disabled.operation, { action: "disable", plugin: "files", state: "done", error: null });
    assert.equal(disabled.plugins.find((row) => row.id === "files").installed.enabled, false);
    assert.equal(disabled.restart, true);
    await s.until("core.library", (value) => actionsOf(value, "files").includes("enable"), "the files card did not offer 사용");

    await s.run("core.plugins.enable", { plugin: "files" });
    const enabled = await s.until("core.plugins", (value) => value.operation?.action === "enable"
      && value.operation.state === "done" && value.plugins.find((row) => row.id === "files").state === "loaded",
      "enabling files did not return it to loaded");
    assert.equal(enabled.restart, false);
    await assert.rejects(s.run("core.plugins.enable", { plugin: "" }), /plugin must be a non-empty string/);
  });
}
