// 라이브러리의 플러그인 페이지: 설명, 버전, 사이드카, 검색, 플러그인 작업을 검사한다(docs/spec/installation.md 의 Plugin screen).
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { APPS, keepCommonSettings, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";

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
    assert.deepEqual(library.plugins.shown, ["browser", "editor", "files", "hwp", "terminal"]);
    for (const row of plugins.plugins) {
      assert.ok(row.description.length > 0, `${row.id} shows no description`);
      assert.ok(row.installed?.version, `${row.id} shows no installed version: ${JSON.stringify(row)}`);
    }
    const terminal = plugins.plugins.find((row) => row.id === "terminal");
    assert.ok(terminal.sidecars.length > 0, `terminal lists no sidecar: ${JSON.stringify(terminal)}`);
    assert.ok(terminal.sidecars.every((sidecar) => typeof sidecar.version === "string"),
      `a terminal sidecar has no installed version: ${JSON.stringify(terminal.sidecars)}`);
    // The card offers 업데이트 only when the registry lists a version newer than the installed one.
    const update = plugins.updates.some((item) => item.id === "files") ? ["update"] : [];
    assert.deepEqual(actionsOf(library, "files"), [...update, "disable", "remove"]);

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

  test(`${app.name}: a plugin card disables and enables an installed plugin and the window applies each change`, { timeout: 60000 }, async (t) => {
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
    assert.equal(listed.reload, false);

    // A plugin operation reloads the page of the window, which then reports the change without an application restart
    // (docs/spec/installation.md#applying-a-change). The page process changes with each reload.
    const reloaded = async (before, message) => {
      const window = await s.until("host.window", (value) => value.pageProcess !== 0 && value.pageProcess !== before, message);
      await s.until("host.windows", (list) => list.some((item) => item.window === s.window && item.ready), `${message}: the new page did not report ready`);
      return window;
    };
    assert.ok(actionsOf(await s.get("core.library"), "files").includes("disable"), "the files card has no 사용 안 함");
    let page = (await s.get("host.window")).pageProcess;
    await s.run("core.plugins.disable", { plugin: "files" });
    page = (await reloaded(page, "disabling files did not reload the window")).pageProcess;
    const disabled = await s.until("core.plugins", (value) => value.plugins.find((row) => row.id === "files")?.state === "disabled",
      "the reloaded window did not report files disabled");
    assert.equal(disabled.reload, false);
    assert.equal(disabled.plugins.find((row) => row.id === "files").installed.enabled, false);

    await showPlugins(s);
    await s.until("core.library", (value) => actionsOf(value, "files").includes("enable"), "the files card did not offer 사용");
    await s.run("core.plugins.enable", { plugin: "files" });
    await reloaded(page, "enabling files did not reload the window");
    const enabled = await s.until("core.plugins", (value) => value.plugins.find((row) => row.id === "files")?.state === "loaded",
      "the reloaded window did not load files");
    assert.equal(enabled.reload, false);
    await assert.rejects(s.run("core.plugins.enable", { plugin: "" }), /plugin must be a non-empty string/);
  });

  test(`${app.name}: a plugin change asks about a modified tab before it reloads the window`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const project = await s.get("core.project");
    const folder = `plugin-apply-check-${process.pid}`;
    const path = `${folder}/note.txt`;
    const file = join(project.root, path);
    mkdirSync(join(project.root, folder));
    writeFileSync(file, "alpha\n");
    s.cleanup(() => rmSync(join(project.root, folder), { recursive: true, force: true }));
    const page = async () => (await s.get("host.window")).pageProcess;
    const reloaded = async (before, message) => {
      await s.until("host.window", (value) => value.pageProcess !== 0 && value.pageProcess !== before, message);
      await s.until("host.windows", (list) => list.some((item) => item.window === s.window && item.ready), `${message}: the new page did not report ready`);
    };

    const { tab: surface } = await s.run("core.file.open", { path });
    s.cleanup(async () => {
      const grid = await s.get("core.grid");
      if (!grid.cards.some((card) => (card.tabs ?? []).some((tab) => tab.id === surface))) return;
      const { closed } = await s.run("core.tab.close", { tab: surface });
      if (closed) return;
      const picker = await s.until("core.picker", (value) => value.open, "the close question did not open");
      await s.run("core.picker.pick", { index: picker.items.findIndex((item) => item.name === "저장하지 않고 닫기") });
    });
    await s.until("core.surfaces", (all) => all.some((x) => x.surface === surface && x.status.phase === "ready"), "the editor tab did not open");
    await s.until("editor.document", (value) => value.path === path && value.version !== null, "the editor did not read the file", { surface });
    await s.run("editor.edit", { changes: [{ from: 0, to: 0, insert: "z" }] }, surface);
    await s.until("editor.document", (value) => value.modified, "editor.edit did not modify the text", { surface });

    // The browser plugin is enabled again after the check, which reloads the window once more.
    s.cleanup(async () => {
      if ((await s.get("core.plugins")).plugins.find((row) => row.id === "browser").installed.enabled) return;
      const before = await page();
      await s.run("core.plugins.enable", { plugin: "browser" });
      await reloaded(before, "enabling browser did not reload the window");
    });
    const before = await page();
    await s.run("core.plugins.disable", { plugin: "browser" });
    const ask = async () => (await s.until("core.picker", (picker) => picker.open && picker.title.includes("저장하지 않은 변경이 있습니다"),
      "the plugin change did not ask about the modified tab")).items.map((item) => item.name);
    assert.deepEqual(await ask(), ["저장하고 적용", "저장하지 않고 적용", "적용하지 않기"]);
    // 적용하지 않기 keeps the page, and the card offers to apply the change.
    await s.run("core.picker.pick", { index: 2 });
    const kept = await s.until("core.plugins", (value) => value.plugins.find((row) => row.id === "browser").state === "reload",
      "적용하지 않기 did not leave the browser change waiting for a reload");
    assert.equal(kept.reload, true);
    assert.equal(await page(), before, "적용하지 않기 reloaded the window");

    // core.plugins.apply asks again, and 저장하지 않고 적용 reloads the window without writing the file.
    const applying = s.run("core.plugins.apply", {});
    assert.deepEqual(await ask(), ["저장하고 적용", "저장하지 않고 적용", "적용하지 않기"]);
    await s.run("core.picker.pick", { index: 1 });
    assert.deepEqual(await applying, { reloaded: true });
    await reloaded(before, "저장하지 않고 적용 did not reload the window");
    const applied = await s.until("core.plugins", (value) => value.plugins.find((row) => row.id === "browser").state === "disabled",
      "the reloaded window did not report browser disabled");
    assert.equal(applied.reload, false);
    assert.equal(readFileSync(file, "utf8"), "alpha\n");
  });
}
