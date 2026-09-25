// 파일 저장·설정 상속·프로젝트 창의 실제 네이티브 동작을 검사한다.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { APPS, failure, fresh, keepCommonSettings, open } from "./app.mjs";

const read = (path) => JSON.parse(readFileSync(path, "utf8"));

// 실행 중인 앱이 같은 파일을 읽으므로 호스트처럼 임시 파일에 쓴 뒤 이름을 바꾼다. 앱은 부분 파일을 읽지 않는다.
const write = (path, value) => {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, path);
};

const mode = async (s) => (await s.get("core.settings")).values.mode;

const settings = (s, patch, scope) => s.run("core.settings.set", { patch, scope });

/** 창 목록에서 known 에 없는 창 하나. */
const added = (list, known) => list.find((w) => !known.includes(w.window)).window;

/** 설정 모달 컨트롤이 나타날 때까지 기다리고 그 컨트롤을 반환한다. */
async function control(s, name, key, predicate = () => true, message = `settings control ${key} did not appear`) {
  const { controls } = await s.until("core.settings-modal",
    (modal) => modal.controls.some((c) => c.name === name && c.key === key && predicate(c)), message);
  return controls.find((c) => c.name === name && c.key === key);
}

/** 설정 모달 컨트롤이 가리키는 명령을 실행한다. value 는 값 입력 컨트롤의 값이다. */
async function press(s, name, key, value) {
  const { command } = await control(s, name, key);
  const params = { ...command.params };
  if (value !== undefined) params.value = value;
  await s.run(command.name, params);
}

/** 설정 모달이 열리고 네이티브 모달이 표시될 때까지 기다린다. */
async function openSettings(s) {
  await s.run("core.settings.open");
  await s.until("host.window", (w) => w.modal?.id === "settings" && w.modal.shown, "settings did not render");
}

/** 설정 모달을 닫는다. */
async function closeSettings(s) {
  await s.run("core.settings.close");
  await s.until("host.window", (w) => w.modal === null, "settings did not close");
}

/** 설정 범위 탭. 제목, 선택 여부, 인덱스. */
async function scopeTabs(s) {
  const { controls } = await s.until("core.settings-modal",
    (modal) => modal.controls.some((c) => c.name === "core.settings-modal.scope"), "scope tabs did not render");
  return controls.filter((c) => c.name === "core.settings-modal.scope");
}

const hasKey = async (s, prefix) => (await s.get("core.settings-modal")).controls.some((c) => c.key?.startsWith(prefix));

for (const app of Object.values(APPS)) {
  test(`${app.name}: two independent project states repeat create-use-close-recreate in one instance`, { timeout: 30000 }, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const root = realpathSync(mkdtempSync(join(tmpdir(), "soksak-v4-")));
    const firstRoot = join(root, "first");
    const secondRoot = join(root, "second");
    mkdirSync(firstRoot);
    mkdirSync(secondRoot);
    s.cleanup(() => rmSync(root, { recursive: true, force: true }));
    s.cleanup(async () => {
      for (const window of await s.get("host.windows")) {
        if (window.window !== s.window) await s.on(window.window).close();
      }
      await s.windows(1, "V4 cleanup left an extra window");
      for (const project of await s.get("core.projects")) {
        if (project.root.startsWith(root)) await s.run("core.project.close", { id: project.id });
      }
      await s.run("core.projects.flush");
    });

    await settings(s, { projectOpening: "windows" }, "common");
    const openAndUse = async (projectRoot, color, label) => {
      const opened = await s.run("core.project.open", { root: projectRoot, color });
      const child = s.on(added(await s.windows(2, `${label}: project window did not open`), [s.window]));
      await child.until("core.project", (project) => project?.id === opened.id,
        `${label}: project did not become active`);
      await child.until("core.grid", (grid) => grid?.cards?.length > 0,
        `${label}: project grid did not render`);
      const shellSurfaces = await child.until("core.surfaces", (surfaces) =>
        surfaces.filter((surface) => surface.visible && surface.plugin === "shell" &&
          surface.exposes.includes("status shell.output")),
        `${label}: shell surface did not become usable`);
      assert.ok(shellSurfaces.length > 0);
      await child.get("shell.output", shellSurfaces[0].surface);
      await child.run("core.space.add");
      await child.run("core.projects.flush");
      return { id: opened.id, child };
    };
    const closeAndRemove = async ({ id, child }, label) => {
      await child.close();
      await s.windows(1, `${label}: project window did not close`);
      await s.run("core.project.close", { id });
      await s.until("core.projects", (projects) => !projects.some((project) => project.id === id),
        `${label}: project did not leave the registry`);
    };

    const first = await openAndUse(firstRoot, "#7fe3b0", "first state");
    await closeAndRemove(first, "first state");
    const firstRecreated = await openAndUse(firstRoot, "#7fe3b0", "first recreated state");
    await closeAndRemove(firstRecreated, "first recreated state");

    const second = await openAndUse(secondRoot, "#7db4ff", "second state");
    await closeAndRemove(second, "second state");
    const secondRecreated = await openAndUse(secondRoot, "#7db4ff", "second recreated state");
    await closeAndRemove(secondRecreated, "second recreated state");
    t.diagnostic(`${app.name}: PASS V4 two independent states; each create/use/close/recreate cycle completed`);
  });

  test(`${app.name}: project windows persist files, inherit settings, and isolate native state`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    await keepCommonSettings(s);
    // 이 검사는 사이드바 위치 flow 의 레일 카드를 쓴다. 기본값은 inset 이다.
    await s.run("core.settings.set", { patch: { rail: "flow" }, scope: "common" });
    const temporary = realpathSync(mkdtempSync(join(tmpdir(), "soksak-projects-")));
    const secondRoot = join(temporary, "second"); mkdirSync(secondRoot);
    const thirdRoot = join(temporary, "third"); mkdirSync(thirdRoot);
    const alias = join(temporary, "alias"); symlinkSync(secondRoot, alias);
    // 폴더 삭제는 앱 정리와 별개로 가장 마지막에 실행한다(정리는 등록의 역순).
    s.cleanup(() => rmSync(temporary, { recursive: true, force: true }));
    s.cleanup(async () => {
      for (const window of await s.get("host.windows")) {
        if (window.window !== s.window) await s.on(window.window).close();
      }
      await s.windows(1, "project window did not close");
      for (const item of await s.get("core.projects")) {
        if (item.root.startsWith(temporary)) await s.run("core.project.close", { id: item.id });
      }
      const remaining = await s.get("core.projects");
      if (!(await s.get("core.project")) && remaining.length) await s.run("core.project.activate", { id: remaining[0].id });
      await s.run("core.projects.flush");
      assert.equal(await s.get("core.page.error") ?? "", "");
    });

    const first = await s.get("core.project");
    const config = dirname(first.root);
    await settings(s, { projectOpening: "windows", mode: "light" }, "common");
    assert.equal(read(join(config, "settings.json")).mode, "light");
    assert.equal(Object.hasOwn(read(join(first.root, ".soksak/settings.json")), "mode"), false);
    const second = await s.run("core.project.open", { root: secondRoot, color: "#7fe3b0" });
    let child = s.on(added(await s.windows(2, "second OS window was not created"), [s.window]));
    await child.until("core.grid", (grid) => grid?.cards.length > 0, "project cards did not render");
    assert.equal((await s.get("core.project")).id, first.id);
    assert.equal((await child.get("core.project")).id, second.id);
    assert.equal(await mode(child), "light");
    await settings(child, { mode: "dark" }, "project");
    assert.deepEqual(read(join(second.root, ".soksak/settings.json")), { mode: "dark" });
    assert.equal(await mode(s), "light");
    await settings(s, { mode: "dark" }, "common");
    await settings(s, { mode: "light" }, "common");
    assert.equal(await mode(child), "dark");
    await child.run("core.settings.reset", { key: "mode" });
    assert.deepEqual(read(join(second.root, ".soksak/settings.json")), {});
    await child.until("core.settings", (value) => value.values.mode === "light", "reset did not restore common settings");
    assert.equal(await failure(settings(child, { projectOpening: "tabs" }, "project")), -32602,
      "a common-only setting must be rejected in the project scope as invalid params");

    const reopened = await s.run("core.project.open", { root: alias, color: "#fff" });
    assert.equal(reopened.id, second.id);
    assert.equal((await s.get("host.windows")).length, 2);
    assert.equal((await s.get("core.projects")).length, 2);

    const concurrent = await Promise.all([s, child].map((w) => w.run("core.project.open", { root: thirdRoot, color: "#7db4ff" })));
    assert.equal(concurrent[0].id, concurrent[1].id);
    const shared = s.on(added(await s.windows(3, "concurrent opens did not create one shared project window"),
      [s.window, child.window]));
    await shared.until("core.grid", (grid) => grid?.cards.length > 0, "shared project did not render");
    assert.equal((await s.get("core.projects")).length, 3);
    await shared.close();
    await s.windows(2, "shared project did not close");
    await s.run("core.project.close", { id: concurrent[0].id });

    await settings(s, { mode: "dark" }, "common");
    await openSettings(child);
    assert.equal((await s.get("core.window.document")).background, false);
    assert.equal((await child.get("core.window.document")).background, true);
    await openSettings(s);
    const tabs = await scopeTabs(child);
    assert.equal((await child.get("core.settings-modal")).controls
      .filter((c) => c.name === "core.settings-modal.nav" && c.key?.startsWith("pick:scope:")).length, 0);
    assert.deepEqual(tabs.map((b) => b.label), ["전역", "프로젝트"]);
    assert.deepEqual(tabs.map((b) => b.on), [true, false]);
    const [globalTab, projectTab] = await Promise.all(tabs.map((b) => child.rect("core.settings-modal.scope", b.index)));
    assert.equal(globalTab.y, projectTab.y);
    assert.ok(globalTab.x < projectTab.x);
    await press(child, "core.settings-modal.scope", "pick:scope:project");
    await control(child, "core.settings-modal.scope", "pick:scope:project", (c) => c.on, "folder settings scope was not selected");
    assert.equal(await hasKey(child, "pick:projectOpening:"), false);
    await press(child, "core.settings-modal.pick", "pick:mode:light");
    await child.until("core.settings", (value) => value.values.mode === "light", "modal did not update its project");
    await child.until("core.settings", (value) => !value.saving, "the project setting was not saved");
    assert.equal(await mode(s), "dark");
    assert.equal(read(join(second.root, ".soksak/settings.json")).mode, "light");
    assert.equal(read(join(config, "settings.json")).mode, "dark");
    const commonWidth = read(join(config, "settings.json")).sidebarWidth;
    // 다른 절에 다녀와도 프로젝트 범위가 유지된다.
    await press(child, "core.settings-modal.nav", "nav:sidebars");
    await press(child, "core.settings-modal.nav", "nav:general");
    await press(child, "core.settings-modal.set", "sidebarWidth", "240");
    await child.until("core.settings", (value) => value.overridden.includes("sidebarWidth") && !value.saving,
      "category change did not retain project scope");
    assert.equal(read(join(second.root, ".soksak/settings.json")).sidebarWidth, 240);
    assert.equal(read(join(config, "settings.json")).sidebarWidth, commonWidth);
    await press(child, "core.settings-modal.reset", "reset:sidebarWidth");
    await child.until("core.settings", (value) => !value.overridden.includes("sidebarWidth") && !value.saving,
      "project override was not removed");
    assert.equal(read(join(second.root, ".soksak/settings.json")).sidebarWidth, undefined);
    await press(child, "core.settings-modal.nav", "nav:general");
    await control(child, "core.settings-modal.scope", "pick:scope:project", (c) => c.on,
      "General did not retain the selected project tab");
    await press(child, "core.settings-modal.scope", "pick:scope:common");
    await control(child, "core.settings-modal.pick", "pick:projectOpening:windows", () => true,
      "Global tab did not display the common-only setting");
    await press(child, "core.settings-modal.pick", "pick:mode:light");
    await s.until("core.settings", (value) => value.values.mode === "light", "Global tab did not update the other project");
    await child.until("core.settings", (value) => !value.saving, "the common setting was not saved");
    assert.equal(read(join(config, "settings.json")).mode, "light");
    await press(child, "core.settings-modal.scope", "pick:scope:project");
    await control(child, "core.settings-modal.scope", "pick:scope:project", (c) => c.on,
      "project scope was not selected before leaving the workspace");
    await closeSettings(child);
    assert.equal((await s.get("host.window")).modal?.shown, true);
    await closeSettings(s);

    await settings(s, { mode: "dark" }, "common");
    const projectSettings = read(join(second.root, ".soksak/settings.json"));
    await child.run("core.projects.browse");
    assert.equal((await child.get("core.screen")).screen, "library");
    assert.equal(await mode(child), "dark", "library must apply common settings after leaving a project");
    assert.equal((await child.get("core.window.document")).scheme, "dark");
    await openSettings(child);
    const libraryTabs = await scopeTabs(child);
    assert.deepEqual(libraryTabs.map((b) => ({ label: b.label, on: b.on })), [{ label: "전역", on: true }]);
    assert.equal(await hasKey(child, "pick:projectOpening:"), true);
    await press(child, "core.settings-modal.pick", "pick:mode:light");
    await s.until("core.settings", (value) => value.values.mode === "light", "library settings did not update common settings");
    await child.until("core.settings", (value) => !value.saving, "the common setting was not saved");
    assert.equal(read(join(config, "settings.json")).mode, "light");
    assert.deepEqual(read(join(second.root, ".soksak/settings.json")), projectSettings);
    await closeSettings(child);
    await child.run("core.settings.set", { patch: { mode: "dark" } });
    await s.until("core.settings", (value) => value.values.mode === "dark", "library appearance action did not update common settings");
    await child.until("core.settings", (value) => !value.saving, "the common setting was not saved");
    assert.deepEqual(read(join(second.root, ".soksak/settings.json")), projectSettings);
    await child.run("core.project.activate", { id: second.id });
    assert.equal(await mode(child), "light", "workspace must restore its project override");
    assert.equal((await child.get("core.window.document")).scheme, "light");
    await openSettings(child);
    assert.deepEqual((await scopeTabs(child)).map((b) => b.label), ["전역", "프로젝트"]);
    await closeSettings(child);

    await settings(s, { projectOpening: "tabs" }, "common");
    const third = await s.run("core.project.open", { root: thirdRoot, color: "#7db4ff" });
    assert.equal((await s.get("host.windows")).length, 2);
    assert.equal((await s.get("core.project")).id, third.id);
    assert.equal((await child.get("core.project")).id, second.id);
    const space = await child.run("core.space.add");
    await child.run("core.space.rename", { id: space.id, title: "Saved space" });
    await child.run("core.grid.size", { card: "rail-shell", axis: "x", size: 213 });
    await child.run("core.grid.size", { card: "left", axis: "x", size: 215 });
    await settings(child, { left: false }, "project");
    await child.run("core.projects.flush");
    const beforeClose = (await child.get("host.window")).frame;
    await child.run("host.window.move", { x: beforeClose.x + 30, y: beforeClose.y + 20 });
    await child.until("host.window", (w) => w.frame.x === beforeClose.x + 30 && w.frame.y === beforeClose.y + 20,
      "the window did not move");
    await child.close();
    await s.windows(1, "native close did not complete");
    const saved = read(join(config, "projects.json")).find((p) => p.id === second.id);
    assert.equal(saved.spaces.find((x) => x.id === saved.activeSpaceId).title, "Saved space");
    assert.equal(saved.spaces.find((x) => x.id === saved.activeSpaceId).layout.railWidth.shell, 213);
    // 저장한 위치와 크기는 호스트가 보고하는 창 좌표와 같은 단위여야 한다. 화면 배율이 2 인 곳에서
    // 물리 픽셀로 저장하면 같은 파일이 다른 자리를 가리키고, 창은 화면 밖으로 밀려난다.
    assert.deepEqual(saved.geometry, { x: beforeClose.x + 30, y: beforeClose.y + 20,
      width: beforeClose.width, height: beforeClose.height },
      `the saved geometry is not in window points (${JSON.stringify(beforeClose)})`);
    await s.until("core.surfaces", (list) => list.some((x) => x.visible && x.plugin === "shell"),
      "the main window must keep its shell surface");
    await settings(s, { projectOpening: "windows" }, "common");
    await s.run("core.project.activate", { id: second.id });
    child = s.on(added(await s.windows(2, "saved project did not reopen"), [s.window]));
    await child.until("core.grid", (grid) => grid?.cards.length > 0, "saved project did not render");
    assert.equal((await child.get("core.project")).activeSpaceId, saved.activeSpaceId);
    assert.equal((await child.get("core.layout")).railWidth.shell, 213);
    await settings(child, { left: true }, "project");
    const shownLeft = await child.until("core.grid", (grid) => grid?.cards.some((c) => c.id === "left"),
      "the left sidebar did not return");
    assert.equal(shownLeft.cards.find((c) => c.id === "left").width, 215);
    const afterOpen = (await child.get("host.window")).frame;
    assert.deepEqual(afterOpen, { ...beforeClose, x: beforeClose.x + 30, y: beforeClose.y + 20 },
      JSON.stringify({ before: beforeClose, saved: saved.geometry, after: afterOpen }));
    assert.equal(await mode(child), "light");
    await s.run("core.project.activate", { id: first.id });
    const title = `${first.title} / ${app.name === "wailsv3" ? "Wails v3" : "Tauri v2"}`;
    await s.until("host.windows", (list) => list.find((w) => w.window === s.window)?.title === title,
      "the main window title did not follow the project");
    await child.close();
    await s.windows(1, "restored project window did not close");
    await s.run("core.project.move", { id: third.id, delta: -2 });
    await s.run("core.project.rename", { id: third.id, title: "First saved project" });
    await s.run("core.projects.flush");
    const origin = (await s.get("core.window.document")).timeOrigin;
    await s.run("host.window.reload");
    await s.until("core.window.document", (doc) => doc.timeOrigin !== origin && doc.readyState === "complete",
      "main document did not reload");
    await s.until("core.project", (value) => value?.id === first.id, "reload did not retain the current project");
    assert.equal((await s.get("host.windows")).length, 1);
    assert.equal((await s.get("core.projects"))[0].title, "First saved project");
    t.diagnostic("verified common/project JSON files, native modal isolation, directory aliases, tab/window policy, and close/reopen persistence");
  });
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: saved layouts drop plugins that the environment does not register`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    await keepCommonSettings(s);
    const root = realpathSync(mkdtempSync(join(tmpdir(), "soksak-unknown-")));
    s.cleanup(() => rmSync(root, { recursive: true, force: true }));
    s.cleanup(async () => {
      await s.windows(1, "project window did not close");
      for (const item of await s.get("core.projects")) {
        if (item.root === root) await s.run("core.project.close", { id: item.id });
      }
      await s.run("core.projects.flush");
      assert.equal(await s.get("core.page.error") ?? "", "");
    });
    const first = await s.get("core.project");
    const config = dirname(first.root);
    // 레일 카드(flow)의 저장과 제거를 검사한다. 기본값은 inset 이다.
    await settings(s, { projectOpening: "windows", rail: "flow" }, "common");
    const saved = await s.run("core.project.open", { root, color: "#7fe3b0" });
    const child = s.on(added(await s.windows(2, "project window was not created"), [s.window]));
    await child.until("core.grid", (grid) => grid?.cards.some((c) => c.id === "rail-shell"), "the shell rail did not stand");
    await child.run("core.projects.flush");
    await child.close();
    await s.windows(1, "project window did not close");

    // 다른 환경에서 저장된 배치: 셸 카드의 첫 탭, 문서 카드의 모든 탭, 셸 레일이
    // 이 환경에 없는 플러그인 gone 의 것이다.
    const records = read(join(config, "projects.json"));
    const record = records.find((p) => p.id === saved.id);
    const layout = record.spaces.find((x) => x.id === record.activeSpaceId).layout;
    const { cards, paidBy } = layout.state;
    const shell = cards.find((c) => c.id === "shell");
    // 셸 카드의 첫 탭을 없는 플러그인의 것으로 바꾼다. 나머지 탭은 이 환경에 등록된 플러그인의 것이다.
    const [gone, kept] = shell.data.tabs;
    const remaining = shell.data.tabs.slice(1).map((tab) => tab.id);
    gone.plugin = "gone";
    shell.data.activeId = gone.id;
    for (const tab of cards.find((c) => c.id === "browser").data.tabs) tab.plugin = "gone";
    cards.find((c) => c.id === "rail-shell").id = "rail-gone";
    paidBy["rail-gone"] = paidBy["rail-shell"];
    delete paidBy["rail-shell"];
    layout.railWidth.gone = layout.railWidth.shell;
    write(join(config, "projects.json"), records);

    await s.run("core.projects.browse");
    const library = await s.until("core.library", (value) => value.previews[saved.id], "the library did not show the project");
    assert.ok(library.previews[saved.id].some((pane) => pane.card === "rail-gone"));
    assert.equal(await s.get("core.page.error") ?? "", "");
    await s.run("core.project.activate", { id: first.id });
    await s.run("core.project.activate", { id: saved.id });
    const reopened = s.on(added(await s.windows(2, "saved project did not reopen"), [s.window]));
    const grid = await reopened.until("core.grid", (value) => value?.cards.length > 0, "saved project did not render");
    assert.equal(await reopened.get("core.page.error") ?? "", "");
    assert.deepEqual(grid.cards.find((c) => c.id === "shell").tabs.map((tab) => tab.id), remaining);
    assert.equal(grid.cards.find((c) => c.id === "shell").active, kept.id);
    assert.equal(grid.cards.some((c) => c.id === "browser" || c.id === "rail-gone"), false);
    assert.equal(grid.cards.flatMap((c) => c.tabs).some((tab) => tab.plugin === "gone"), false);
    assert.equal(Object.hasOwn((await reopened.get("core.layout")).railWidth, "gone"), false);
    await reopened.close();
    t.diagnostic("verified that unknown tabs and rails are dropped from a saved layout and its library preview");
  });
}
