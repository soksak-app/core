// 파일 저장·설정 상속·프로젝트 창의 실제 네이티브 동작을 검사한다.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { APPS, failure, fresh, open } from "./app.mjs";

const read = (path) => JSON.parse(readFileSync(path, "utf8"));

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

/** 설정 모달 컨트롤을 누른다. */
async function press(s, name, key) {
  const found = await control(s, name, key);
  await s.act(name, "click", { index: found.index });
}

/** 설정 모달이 열리고 네이티브 모달이 표시될 때까지 기다린다. */
async function openSettings(s) {
  await s.run("core.settings.open");
  await s.until("host.window", (w) => w.modal?.id === "settings" && w.modal.shown, "settings did not render");
}

/** 설정 모달을 닫기 단추로 닫는다. */
async function closeSettings(s) {
  await s.act("core.settings-modal.close", "click");
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
  test(`${app.name}: project windows persist files, inherit settings, and isolate native state`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const temporary = realpathSync(mkdtempSync(join(tmpdir(), "soksak-projects-")));
    const secondRoot = join(temporary, "second"); mkdirSync(secondRoot);
    const thirdRoot = join(temporary, "third"); mkdirSync(thirdRoot);
    const alias = join(temporary, "alias"); symlinkSync(secondRoot, alias);
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
      rmSync(temporary, { recursive: true, force: true });
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
    assert.equal(await failure(settings(child, { projectOpening: "tabs" }, "project")), -32000,
      "a common-only setting must be rejected in the project scope");

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
    const commonLatency = read(join(config, "settings.json")).latency;
    await press(child, "core.settings-modal.nav", "nav:compositing");
    const latency = await control(child, "core.settings-modal.set", "latency");
    await child.act("core.settings-modal.set", "input", { index: latency.index, value: "7" });
    await child.until("core.settings", (value) => value.overridden.includes("latency") && !value.saving,
      "category change did not retain project scope");
    assert.equal(read(join(second.root, ".soksak/settings.json")).latency, 7);
    assert.equal(read(join(config, "settings.json")).latency, commonLatency);
    await press(child, "core.settings-modal.reset", "reset:latency");
    await child.until("core.settings", (value) => !value.overridden.includes("latency") && !value.saving,
      "project override was not removed");
    assert.equal(read(join(second.root, ".soksak/settings.json")).latency, undefined);
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
    await child.act("core.chrome.mode", "click");
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
    await child.run("core.grid.size", { card: "rail-terminal", axis: "x", size: 213 });
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
    assert.equal(saved.spaces.find((x) => x.id === saved.activeSpaceId).layout.railWidth.terminal, 213);
    assert.ok(saved.geometry.width > 0);
    await s.until("core.surfaces", (list) => list.some((x) => x.visible && x.plugin === "terminal"),
      "the main window must keep its terminal surface");
    await settings(s, { projectOpening: "windows" }, "common");
    await s.run("core.project.activate", { id: second.id });
    child = s.on(added(await s.windows(2, "saved project did not reopen"), [s.window]));
    await child.until("core.grid", (grid) => grid?.cards.length > 0, "saved project did not render");
    assert.equal((await child.get("core.project")).activeSpaceId, saved.activeSpaceId);
    assert.equal((await child.get("core.layout")).railWidth.terminal, 213);
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
