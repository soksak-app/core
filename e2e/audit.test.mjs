// 모든 화면과 상태에서 조작 요소가 선언된 명령과 dom 이름을 갖는지 실행 중인 문서로 검사한다.
//
// 메인 문서는 core.page.audit 로, 플러그인 표면 문서는 core.surface.document 의 unbound 로
// 명령에 연결되지 않았거나 이름이 없는 조작 요소를 보고한다(docs/spec/exposure.md).
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, fresh, open } from "./app.mjs";

/** 메인 문서와 보이는 모든 플러그인 표면 문서의 audit 가 비어 있는지 확인한다. */
async function clean(s, where) {
  const { unbound } = await s.get("core.page.audit");
  assert.deepEqual(unbound, [], `${where}: main document controls without a command or dom name`);
  for (const surface of await s.surfaces()) {
    if (!surface.exposes.includes("status core.surface.document")) continue;
    const doc = await s.get("core.surface.document", surface.surface);
    assert.deepEqual(doc.unbound, [], `${where}: ${surface.plugin} surface ${surface.surface} controls without a command or dom name`);
  }
}

/** 메뉴를 열고 audit 를 검사한 뒤 닫는다. */
async function menu(s, name, params, where) {
  await s.run(name, params);
  await s.until("core.picker", (picker) => picker.open && picker.items.length > 0, `${where} did not open`);
  await clean(s, where);
  await s.run("core.picker.close");
  await s.until("core.picker", (picker) => !picker.open, `${where} did not close`);
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: every control on every screen runs a declared command and has a dom name`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const surfaces = await s.surfaces();
    assert.ok(surfaces.length > 0, "the workspace must show plugin surfaces");
    await clean(s, "workspace");

    // 선택 레이어: 카드마다 추가, 분할, 탭 목록.
    const grid = await s.get("core.grid");
    for (const card of grid.cards.filter((c) => c.pane !== null)) {
      for (const kind of ["add", "split-x", "split-y"]) {
        if (card.acts[kind].enabled && !card.acts[kind].hidden) {
          await menu(s, "core.card.menu", { card: card.id, menu: kind }, `${card.id} ${kind} menu`);
        }
      }
      await menu(s, "core.card.tab-list", { card: card.id }, `${card.id} tab list`);
    }

    // 이름 변경 중인 공간과 프로젝트.
    const project = await s.get("core.project");
    for (const [kind, id] of [["space", project.activeSpaceId], ["project", project.id]]) {
      await s.run("core.rename.begin", { kind, id });
      await s.until("core.rename", (rename) => rename?.id === id, `${kind} rename did not start`);
      await clean(s, `${kind} rename`);
      await s.run("core.rename.cancel");
      await s.until("core.rename", (rename) => rename === null, `${kind} rename did not stop`);
    }

    // 설정 모달: 두 범위의 모든 구역.
    await s.run("core.settings.open");
    await s.until("core.settings-modal", (modal) => modal.open, "settings did not open");
    for (const scope of ["common", "project"]) {
      await s.run("core.settings-modal.scope", { scope });
      for (const section of ["general", "plugins", "sidebars"]) {
        await s.run("core.settings-modal.nav", { section });
        await s.until("core.settings-modal", (modal) => modal.section === section && modal.scope === scope,
          `settings did not show ${scope} ${section}`);
        await clean(s, `settings ${scope} ${section}`);
      }
    }
    await s.run("core.settings.close");
    await s.until("core.settings-modal", (modal) => !modal.open, "settings did not close");

    // 라이브러리와 그 폼, 검색 결과가 없는 상태.
    await s.run("core.projects.browse");
    await s.until("core.library", (library) => library.shown.length > 0, "the library did not list projects");
    await clean(s, "library");
    for (const mode of ["create", "open"]) {
      await s.run("core.library.form.open", { mode });
      await s.until("core.library", (library) => library.formState?.mode === mode, `the ${mode} form did not open`);
      await clean(s, `library ${mode} form`);
      await s.run("core.library.form.cancel");
      await s.until("core.library", (library) => !library.form, `the ${mode} form did not close`);
    }
    await s.run("core.library.search", { query: "no such project" });
    await s.until("core.library", (library) => library.noResults, "search did not empty the library");
    await clean(s, "library without results");
    await s.run("core.library.search", { query: "" });
    // 라이브러리의 플러그인 페이지와 검색 결과가 없는 상태.
    await s.run("core.library.page", { page: "plugins" });
    await s.until("core.library", (library) => library.page === "plugins" && library.plugins.shown.length > 0,
      "the plugin page did not list plugins");
    await clean(s, "library plugin page");
    await s.run("core.library.plugins.search", { query: "no such plugin" });
    await s.until("core.library", (library) => library.plugins.shown.length === 0, "search did not empty the plugin page");
    await clean(s, "library plugin page without results");
    await s.run("core.library.plugins.search", { query: "" });
    await s.run("core.library.page", { page: "projects" });
    await s.run("core.library.return");
    await s.until("core.screen", (screen) => screen.screen === "workspace", "the library did not return to the workspace");
    await clean(s, "workspace after the library");
  });
}
