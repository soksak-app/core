// Checks the real native behavior of file saving, settings inheritance and project windows.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";

import { APPS, failure, keepCommonSettings, open } from "@soksak/window-check/app.mjs";
import { fresh, replacePlaceholders, settingsClosed, settingsShown, START_PLUGIN, startTab } from "./fixture.mjs";
import { projectRecords } from "./projects-file.mjs";
// A plugin that the fixture registry never installs (e2e/fixtures/absent-plugins.json).
import absentPlugins from "./fixtures/absent-plugins.json" with { type: "json" };
import { frontmostApp } from "@soksak/window-check/frontmost.mjs";
import { readEvents, currentEventOffsets, traceRows } from "@soksak/window-check/event-log.mjs";
import { openStages, systemState } from "./open-report.mjs";

const read = (path) => JSON.parse(readFileSync(path, "utf8"));
// The current form of settings.json, which the stored data table of docs/spec/installation.md numbers by its format member.
const SETTINGS_FORMAT = 1;

// The running application reads the same file, so the check writes to a temporary file like the host and then renames it. The application never reads a partial file.
const write = (path, value) => {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, path);
};

const mode = async (s) => (await s.get("core.settings")).values.mode;

const settings = (s, patch, scope) => s.run("core.settings.set", { patch, scope });

/** One window of the window list that is not in known. */
const added = (list, known) => list.find((w) => !known.includes(w.window)).window;

/** Waits until the settings modal control appears and returns that control. */
/** Activates the project and, if it fails, reports the page state and the native state of that window. */
async function activate(s, id, label) {
  try {
    await s.run("core.project.activate", { id });
  } catch (error) {
    const page = { screen: await s.get("core.screen"), surfaces: await s.get("core.surfaces") };
    throw new Error(`${label}: ${error.message}; page state: ${JSON.stringify(page)}; ` +
      `native state: ${JSON.stringify(await s.get("host.window"))}`, { cause: error });
  }
}

async function control(s, name, key, predicate = () => true, message = `settings control ${key} did not appear`) {
  const { controls } = await s.until("core.settings-modal",
    (modal) => modal.controls.some((c) => c.name === name && c.key === key && predicate(c)), message);
  return controls.find((c) => c.name === name && c.key === key);
}

/** Runs the command that a settings modal control points to. value is the value of a value input control. */
async function press(s, name, key, value) {
  const { command } = await control(s, name, key);
  const params = { ...command.params };
  if (value !== undefined) params.value = value;
  await s.run(command.name, params);
}

/** Waits until the settings modal is open and shown (settingsShown). */
async function openSettings(s) {
  await s.run("core.settings.open");
  await settingsShown(s, "settings did not render");
}

/** Closes the settings modal and waits until it is gone (settingsClosed). */
async function closeSettings(s) {
  await s.run("core.settings.close");
  await settingsClosed(s, "settings did not close");
}

/** The settings scope tabs: title, whether selected, and index. */
async function scopeTabs(s) {
  const { controls } = await s.until("core.settings-modal",
    (modal) => modal.controls.some((c) => c.name === "core.settings-modal.scope"), "scope tabs did not render");
  return controls.filter((c) => c.name === "core.settings-modal.scope");
}

const hasKey = async (s, key) => (await s.get("core.settings-modal")).controls.some((c) => c.key === key);

for (const app of Object.values(APPS)) {
  test(`${app.name}: two independent project states repeat create-use-close-recreate in one instance`, { timeout: 30000 }, async (t) => {
    const s = await open(t, app);
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
      // The start layout of a project names plugins that the check application does not load, so probe tabs replace its placeholders.
      await replacePlaceholders(child);
      const { surface } = await startTab(child);
      const view = await child.get("layoutprobe.view", surface);
      assert.equal(view?.surface, surface, `${label}: the probe view did not report its surface`);
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

  test(`${app.name}: project windows persist files, inherit settings, and isolate native state`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    await keepCommonSettings(s);
    const temporary = realpathSync(mkdtempSync(join(tmpdir(), "soksak-projects-")));
    const secondRoot = join(temporary, "second"); mkdirSync(secondRoot);
    const thirdRoot = join(temporary, "third"); mkdirSync(thirdRoot);
    const alias = join(temporary, "alias"); symlinkSync(secondRoot, alias);
    // The deletion of the folder runs last, separately from the cleanup of the application (the cleanup runs in the reverse order of registration).
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
      assert.equal(await s.get("core.workbench.error") ?? "", "");
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
    // The project file is numbered (docs/spec/installation.md, stored data): its current form is SETTINGS_FORMAT.
    assert.deepEqual(read(join(second.root, ".soksak/settings.json")), { format: SETTINGS_FORMAT, mode: "dark" });
    assert.equal(await mode(s), "light");
    await settings(s, { mode: "dark" }, "common");
    await settings(s, { mode: "light" }, "common");
    assert.equal(await mode(child), "dark");
    await child.run("core.settings.reset", { key: "mode" });
    assert.deepEqual(read(join(second.root, ".soksak/settings.json")), { format: SETTINGS_FORMAT });
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
    assert.equal((await s.get("core.window.workbench")).background, false);
    assert.equal((await child.get("core.window.workbench")).background, true);
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
    assert.equal(await hasKey(child, "projectOpening"), false);
    await press(child, "core.settings-modal.set", "mode", "light");
    await child.until("core.settings", (value) => value.values.mode === "light", "modal did not update its project");
    await child.until("core.settings", (value) => !value.saving, "the project setting was not saved");
    assert.equal(await mode(s), "dark");
    assert.equal(read(join(second.root, ".soksak/settings.json")).mode, "light");
    assert.equal(read(join(config, "settings.json")).mode, "dark");
    const commonWidth = read(join(config, "settings.json")).sidebarWidth;
    // The project scope is kept even after a visit to another section.
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
    await control(child, "core.settings-modal.set", "projectOpening", () => true,
      "Global tab did not display the common-only setting");
    // In the Global tab a setting that the project overrides shows the project value with the mark 프로젝트 값 and writes the
    // project scope; every other setting shows and writes the common value (docs/spec/settings.md#scope-of-a-control).
    const projectMode = await control(child, "core.settings-modal.set", "mode");
    assert.deepEqual({ value: projectMode.value, scope: projectMode.command.params.scope }, { value: "light", scope: "project" },
      "the Global tab mode control must show and write the project value of mode");
    await control(child, "core.settings-modal.applied", "applied:mode", () => true,
      "the Global tab did not mark the project value of mode");
    const globalWidth = commonWidth + 10;
    await press(child, "core.settings-modal.set", "sidebarWidth", String(globalWidth));
    await s.until("core.settings", (value) => value.values.sidebarWidth === globalWidth,
      "Global tab did not update the other project");
    await child.until("core.settings", (value) => !value.saving, "the common setting was not saved");
    assert.equal(read(join(config, "settings.json")).sidebarWidth, globalWidth);
    assert.equal(read(join(second.root, ".soksak/settings.json")).sidebarWidth, undefined,
      "the Global tab added a project value");
    await press(child, "core.settings-modal.set", "sidebarWidth", String(commonWidth));
    await s.until("core.settings", (value) => value.values.sidebarWidth === commonWidth,
      "Global tab did not restore the common width");
    await child.until("core.settings", (value) => !value.saving, "the common setting was not saved");
    await press(child, "core.settings-modal.scope", "pick:scope:project");
    await control(child, "core.settings-modal.scope", "pick:scope:project", (c) => c.on,
      "project scope was not selected before leaving the workspace");
    await closeSettings(child);
    await settingsShown(s, "settings of the other project closed with the settings of the child");
    await closeSettings(s);

    await settings(s, { mode: "dark" }, "common");
    const projectSettings = read(join(second.root, ".soksak/settings.json"));
    await child.run("core.projects.browse");
    assert.equal((await child.get("core.screen")).screen, "library");
    assert.equal(await mode(child), "dark", "library must apply common settings after leaving a project");
    assert.equal((await child.get("core.window.workbench")).scheme, "dark");
    await openSettings(child);
    const libraryTabs = await scopeTabs(child);
    assert.deepEqual(libraryTabs.map((b) => ({ label: b.label, on: b.on })), [{ label: "전역", on: true }]);
    assert.equal(await hasKey(child, "projectOpening"), true);
    await press(child, "core.settings-modal.set", "mode", "light");
    await s.until("core.settings", (value) => value.values.mode === "light", "library settings did not update common settings");
    await child.until("core.settings", (value) => !value.saving, "the common setting was not saved");
    assert.equal(read(join(config, "settings.json")).mode, "light");
    assert.deepEqual(read(join(second.root, ".soksak/settings.json")), projectSettings);
    await closeSettings(child);
    await child.run("core.settings.set", { patch: { mode: "dark" } });
    await s.until("core.settings", (value) => value.values.mode === "dark", "library appearance action did not update common settings");
    await child.until("core.settings", (value) => !value.saving, "the common setting was not saved");
    assert.deepEqual(read(join(second.root, ".soksak/settings.json")), projectSettings);
    await activate(child, second.id, "return from the library window");
    assert.equal(await mode(child), "light", "workspace must restore its project override");
    assert.equal((await child.get("core.window.workbench")).scheme, "light");
    await openSettings(child);
    assert.deepEqual((await scopeTabs(child)).map((b) => b.label), ["전역", "프로젝트"]);
    await closeSettings(child);

    await settings(s, { projectOpening: "tabs" }, "common");
    const third = await s.run("core.project.open", { root: thirdRoot, color: "#7db4ff" });
    assert.equal((await s.get("host.windows")).length, 2);
    assert.equal((await s.get("core.project")).id, third.id);
    assert.equal((await child.get("core.project")).id, second.id);
    // Probe tabs replace the placeholders of the start layout of the third project, which the main window now shows.
    await replacePlaceholders(s);
    await startTab(s);
    const space = await child.run("core.space.add");
    await child.run("core.space.rename", { id: space.id, title: "Saved space" });
    await child.run("core.grid.size", { card: "right", axis: "x", size: 213 });
    await child.run("core.grid.size", { card: "left", axis: "x", size: 215 });
    await settings(child, { left: false }, "project");
    await child.run("core.projects.flush");
    const beforeClose = (await child.get("host.window")).frame;
    await child.run("host.window.move", { x: beforeClose.x + 30, y: beforeClose.y + 20 });
    await child.until("host.window", (w) => w.frame.x === beforeClose.x + 30 && w.frame.y === beforeClose.y + 20,
      "the window did not move");
    await child.close();
    await s.windows(1, "native close did not complete");
    const saved = projectRecords(read(join(config, "projects.json")), "projects.json").find((p) => p.id === second.id);
    assert.equal(saved.spaces.find((x) => x.id === saved.activeSpaceId).title, "Saved space");
    assert.equal(saved.spaces.find((x) => x.id === saved.activeSpaceId).layout.windowSidebars.right.width, 213);
    // The saved position and size must have the same unit as the window coordinates that the host reports. If a position is saved
    // in physical pixels where the display scale is 2, the same file points to another position and the window is pushed off the screen.
    assert.deepEqual(saved.geometry, { x: beforeClose.x + 30, y: beforeClose.y + 20,
      width: beforeClose.width, height: beforeClose.height },
      `the saved geometry is not in window points (${JSON.stringify(beforeClose)})`);
    await s.until("core.surfaces", (list) => list.some((x) => x.visible && x.plugin === START_PLUGIN),
      "the main window must keep its probe surface");
    await settings(s, { projectOpening: "windows" }, "common");
    await activate(s, second.id, "reopen the saved project in its own window");
    child = s.on(added(await s.windows(2, "saved project did not reopen"), [s.window]));
    await child.until("core.grid", (grid) => grid?.cards.length > 0, "saved project did not render");
    assert.equal((await child.get("core.project")).activeSpaceId, saved.activeSpaceId);
    assert.equal((await child.get("core.layout")).windowSidebars.right.width, 213);
    await settings(child, { left: true }, "project");
    const shownLeft = await child.until("core.grid", (grid) => grid?.cards.some((c) => c.id === "left"),
      "the left sidebar did not return").catch(async (error) => {
      const { values, project: selected, overridden, saving } = await child.get("core.settings");
      const stored = readFileSync(join(secondRoot, ".soksak", "settings.json"), "utf8");
      throw new Error(`${error.message}; left ${values.left}, project ${selected}, overridden ${overridden}, ` +
        `saving ${saving}, stored ${stored}`);
    });
    assert.equal(shownLeft.cards.find((c) => c.id === "left").width, 215);
    const afterOpen = (await child.get("host.window")).frame;
    assert.deepEqual(afterOpen, { ...beforeClose, x: beforeClose.x + 30, y: beforeClose.y + 20 },
      JSON.stringify({ before: beforeClose, saved: saved.geometry, after: afterOpen }));
    assert.equal(await mode(child), "light");
    await activate(s, first.id, "return the main window to the first project");
    const title = `${first.title} / ${app.name === "wailsv3" ? "Wails v3" : "Tauri v2"}`;
    await s.until("host.windows", (list) => list.find((w) => w.window === s.window)?.title === title,
      "the main window title did not follow the project");
    await child.close();
    await s.windows(1, "restored project window did not close");
    await s.run("core.project.move", { id: third.id, delta: -2 });
    await s.run("core.project.rename", { id: third.id, title: "First saved project" });
    await s.run("core.projects.flush");
    const origin = (await s.get("core.window.workbench")).start;
    await s.run("host.window.reload");
    await s.until("core.window.workbench", (workbench) => workbench.start !== origin && workbench.readyState === "complete",
      "the workbench did not start again");
    await s.until("core.project", (value) => value?.id === first.id, "reload did not retain the current project");
    assert.equal((await s.get("host.windows")).length, 1);
    assert.equal((await s.get("core.projects"))[0].title, "First saved project");
    t.diagnostic("verified common/project JSON files, native modal isolation, directory aliases, tab/window policy, and close/reopen persistence");
  });
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: a saved project window mounts its active view on first open and reopen`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    await keepCommonSettings(s);
    const temporary = realpathSync(mkdtempSync(join(tmpdir(), "soksak-project-view-mount-")));
    const root = join(temporary, "project");
    mkdirSync(root);
    s.cleanup(() => rmSync(temporary, { recursive: true, force: true }));
    s.cleanup(async () => {
      for (const window of await s.get("host.windows")) {
        if (window.window !== s.window) await s.on(window.window).close();
      }
      await s.windows(1, "project view cleanup left an extra window");
      for (const project of await s.get("core.projects")) {
        if (project.root === root) await s.run("core.project.close", { id: project.id });
      }
      await s.run("core.projects.flush");
      assert.equal(await s.get("core.workbench.error"), null);
    });

    await settings(s, { projectOpening: "windows" }, "common");
    const opened = await s.run("core.project.open", { root, color: "#7fe3b0" });
    let child = s.on(added(await s.windows(2, "new project window did not open"), [s.window]));
    // The active view of each card of the project is a probe tab: probe tabs replace the placeholders of the start layout, which
    // names plugins that the check application does not load, before the project is saved.
    const mounted = (item, active) => active.has(item.surface) && item.plugin === START_PLUGIN && item.visible
      && item.composition === "view" && item.status.phase === "ready" && item.applied;
    const assertActiveViewsReady = async (window, phase) => {
      await window.until("core.grid", (grid) => grid?.cards.length > 0, `${phase}: project cards did not render`);
      const grid = await window.get("core.grid");
      const active = new Set(grid.cards.filter((card) => card.tabs?.find((tab) => tab.id === card.active)?.plugin === START_PLUGIN)
        .map((card) => card.active));
      assert.ok(active.size > 0, `${phase}: no card shows an active probe view: ${JSON.stringify(grid.cards)}`);
      const surfaces = await window.until("core.surfaces", (items) =>
        [...active].every((id) => items.some((item) => item.surface === id && mounted(item, active))),
      `${phase}: the active probe views did not mount and apply their composition`);
      const views = surfaces.filter((item) => mounted(item, active)).map((item) => item.surface).sort();
      assert.deepEqual(views, [...active].sort(), `${phase}: an active probe view was absent from the satisfied surfaces status`);
      for (const surface of views) {
        await window.until("core.surface.document",
          (value) => value?.readyState === "complete" && value.themed,
          `${phase}: the active probe view document ${surface} did not become ready`, { surface });
        await window.until("host.window", (state) => state.surfaces.some((item) =>
          item.id === surface && item.visible && item.frame.width > 0 && item.frame.height > 0),
        `${phase}: the active probe native surface ${surface} was not placed`);
      }
      assert.equal(await window.get("core.workbench.error"), null, `${phase}: initial view mount reported an application error`);
      return views;
    };

    await child.until("core.grid", (grid) => grid?.cards.length > 0, "new project window: project cards did not render");
    await replacePlaceholders(child);
    await startTab(child);
    const firstSurfaces = await assertActiveViewsReady(child, "new project window");
    await child.run("core.projects.flush");
    await child.close();
    await s.windows(1, "the first project window did not close");

    await s.run("core.project.activate", { id: opened.id });
    child = s.on(added(await s.windows(2, "saved project window did not reopen"), [s.window]));
    const reopenedSurfaces = await assertActiveViewsReady(child, "reopened saved project window");
    assert.deepEqual(reopenedSurfaces, firstSurfaces, "the saved active views changed their surface IDs on reopen");
  });
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: a saved layout naming a plugin that is not loaded opens with a placeholder card`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
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
    });
    const first = await s.get("core.project");
    const config = dirname(first.root);
    // Opens and closes the saved project in another window, so that it stays as a saved record that is not open.
    await settings(s, { projectOpening: "windows" }, "common");
    const saved = await s.run("core.project.open", { root, color: "#7fe3b0" });
    const child = s.on(added(await s.windows(2, "project window was not created"), [s.window]));
    await child.until("core.grid", (grid) => grid?.cards.length > 0, "the saved project did not render");
    // Probe tabs replace the placeholders of the start layout, so that every saved tab belongs to a loaded plugin.
    await replacePlaceholders(child);
    await startTab(child);
    await child.run("core.projects.flush");
    await child.close();
    await s.windows(1, "project window did not close");

    // A layout saved in another environment: the first tab of the first card with tabs belongs to an absent plugin, which is not in
    // this environment.
    const [ABSENT] = absentPlugins.ids;
    const records = read(join(config, "projects.json"));
    const record = projectRecords(records, "projects.json").find((p) => p.id === saved.id);
    const shell = record.spaces.find((x) => x.id === record.activeSpaceId).layout.state.cards.find((c) => c.data?.tabs?.length > 0);
    assert.ok(shell, "the saved layout holds no card with tabs");
    assert.deepEqual(record.spaces.flatMap((x) => x.layout.state.cards.flatMap((c) => c.data?.tabs ?? [])).filter((tab) => tab.plugin !== START_PLUGIN), [],
    "the saved layout holds a tab that is not a probe tab");
    shell.data.tabs[0].plugin = ABSENT;
    write(join(config, "projects.json"), records);
    const stored = readFileSync(join(config, "projects.json"), "utf8");

    // The library draws that tab as a placeholder cell (docs/spec/plugins.md).
    await s.run("core.projects.browse");
    const library = await s.until("core.library", (value) => value.previews?.[saved.id]?.length > 0, "the library did not draw the saved layout");
    assert.equal(library.previewErrors?.[saved.id], undefined, "the library reported the layout of a plugin that is not loaded as an error");
    // When opened, that tab is a placeholder that gives the reason why it is not installed, and the other tabs open as they are.
    await settings(s, { projectOpening: "tabs" }, "common");
    await s.run("core.project.activate", { id: saved.id });
    await s.until("core.project", (value) => value?.id === saved.id, "the project did not open");
    const surfaces = await s.until("core.surfaces", (value) => value.some((surface) => surface.plugin === ABSENT),
      "the tab of the plugin that is not loaded was not reported");
    assert.deepEqual(surfaces.filter((surface) => surface.placeholder !== null).map((surface) => [surface.plugin, surface.placeholder]),
      [[ABSENT, "missing"]]);
    assert.equal(await s.get("core.workbench.error"), null, "opening the layout reported an error");
    // Saving does not change that tab.
    await s.run("core.projects.flush");
    const after = projectRecords(read(join(config, "projects.json")), "projects.json").find((p) => p.id === saved.id);
    const kept = after.spaces.find((x) => x.id === after.activeSpaceId).layout.state.cards.find((c) => c.id === shell.id);
    assert.equal(kept.data.tabs[0].plugin, ABSENT, "saving changed the tab of the plugin that is not loaded");
    assert.ok(stored.length > 0);
    await s.run("core.project.activate", { id: first.id });
  });
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: the first project opened from the library replies and replaces the library in the same window`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    // Turns the performance record on so that the stage of a late reply is reported.
    await fresh(s, { performanceTrace: true });
    for (const project of await s.get("core.projects")) await s.run("core.project.close", { id: project.id });
    assert.equal(await s.get("core.project"), null, "the check did not start from the library");
    const root = realpathSync(mkdtempSync(join(tmpdir(), "soksak-first-open-")));
    s.cleanup(() => rmSync(root, { recursive: true, force: true }));
    s.cleanup(async () => {
      for (const project of await s.get("core.projects")) {
        if (project.root === root) await s.run("core.project.close", { id: project.id });
      }
      await s.run("core.projects.flush");
    });

    const offsets = currentEventOffsets(app.configDir);
    const stages = async () => {
      await s.flushLog();
      return openStages(traceRows(readEvents(app.configDir, offsets).events));
    };
    const started = performance.now();
    let opened;
    try {
      opened = await s.run("core.project.open", { root, color: "#7db4ff" });
    } catch (error) {
      throw new Error(`core.project.open failed after ${(performance.now() - started).toFixed(0)}ms: ${error.message}; ` +
        `stages: ${await stages()}; ${systemState()}`, { cause: error });
    }
    t.diagnostic(`core.project.open replied in ${(performance.now() - started).toFixed(0)}ms; ${systemState()}`);
    assert.equal(opened.root, root);
    await s.windows(1, "the first project opened another window instead of replacing the library");
    await s.until("core.project", (project) => project?.id === opened.id, "the library window did not show the project");
    // If a page error occurs in the process of closing and opening the project, the check fails. The error is shown only on the screen and the command succeeds.
    assert.equal(await s.get("core.workbench.error"), null, "closing and opening projects reported a page error");
  });

  test(`${app.name}: a window that holds no open project reports no project`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    await keepCommonSettings(s);
    await s.run("core.settings.set", { patch: { left: true }, scope: "common" });
    // The left sidebar of every window shows a stored set of two probe sections.
    const sectionIds = ["layoutprobe.alpha", "layoutprobe.beta"];
    const sets = (await s.get("core.settings")).values.sets;
    await s.run("core.settings.set", { patch: { sets: [...sets, { id: "check-left", title: "Left", sections: sectionIds, layout: "list" }] },
      scope: "common" });
    await s.run("core.settings.link", { place: "left", plugin: null, set: "check-left", scope: "common" });
    const root = realpathSync(mkdtempSync(join(tmpdir(), "soksak-window-project-")));
    s.cleanup(() => rmSync(root, { recursive: true, force: true }));
    s.cleanup(async () => {
      for (const project of await s.get("core.projects")) {
        if (project.root === root) await s.run("core.project.close", { id: project.id });
      }
      await s.run("core.projects.flush");
    });
    const project = async () => (await s.get("host.windows")).find((item) => item.window === s.window).project;
    const probeSections = (sidebars) => {
      const left = sidebars.find((item) => item.sidebar === "left");
      return sectionIds.map((id) => left?.sections.find((item) => item.id === id));
    };
    // A section surface id is qualified by the shown space (docs/spec/plugins.md#sections), which is known after the open.
    let probeIds = [];
    const probeSurfaces = (surfaces) => surfaces.filter((item) => item.kind === "section" && item.sidebar === "left"
      && probeIds.includes(item.surface));
    for (const item of await s.get("core.projects")) await s.run("core.project.close", { id: item.id });
    assert.equal(await s.get("core.project"), null, "the check did not start from the library");
    await s.until("host.windows", (list) => list.find((item) => item.window === s.window)?.project === null,
      `the library window still reports project ${await project()}`);
    const opened = await s.run("core.project.open", { root, color: "#7db4ff" });
    await s.until("host.windows", (list) => list.find((item) => item.window === s.window)?.project === root,
      "the window did not report the opened project");
    await s.until("core.sidebars", (sidebars) => probeSections(sidebars).every((section) => section?.mounted && section.phase === "ready"),
      "the probe section views of the opened project were not mounted and ready");
    const space = (await s.get("core.project")).activeSpaceId;
    probeIds = sectionIds.map((id) => `${space}/left/${id}`);
    for (const surface of probeIds) {
      await s.until("core.surface.document", (doc) => doc !== null && doc.readyState === "complete" && doc.themed,
        `${surface} did not finish its document`, { surface });
    }
    const sectionSurfacesBefore = probeSurfaces(await s.get("core.surfaces"));
    assert.deepEqual(sectionSurfacesBefore.map((item) => item.surface).sort(), [...probeIds].sort(),
      "the opened project did not register its two probe section surfaces");
    await s.run("core.project.close", { id: opened.id });
    await s.until("host.windows", (list) => list.find((item) => item.window === s.window)?.project === null,
      `the window still reports the closed project ${await project()}`);
    await s.until("core.sidebars", (sidebars) => probeSections(sidebars).every((section) => section === undefined),
      "the library still draws probe sidebar sections after project close");
    await s.until("core.surfaces", (all) => probeSurfaces(all).length === 0,
      "the section surfaces of the closed project are still registered");
    assert.equal(await s.get("core.workbench.error"), null, "closing the shown project reported an application error");
    // The title of a window that shows the library does not hold the name of the closed project.
    const { title } = (await s.get("host.windows")).find((item) => item.window === s.window);
    assert.ok(!title.includes(basename(root)), `the window title still names the closed project: ${title}`);
    // Reopening the project mounts its first probe section again.
    await s.run("core.project.open", { root, color: "#7db4ff" });
    await s.until("core.sidebars", (sidebars) => probeSections(sidebars)[0]?.mounted === true && probeSections(sidebars)[0].phase === "ready",
      `the reopened project did not mount ${sectionIds[0]}`);
  });

  test(`${app.name}: a covered window keeps its document visible and completes presentation commands`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    for (const project of await s.get("core.projects")) await s.run("core.project.close", { id: project.id });
    const root = realpathSync(mkdtempSync(join(tmpdir(), "soksak-covered-")));
    s.cleanup(() => rmSync(root, { recursive: true, force: true }));
    s.cleanup(async () => {
      for (const project of await s.get("core.projects")) {
        if (project.root === root) await s.run("core.project.close", { id: project.id });
      }
      await s.run("core.projects.flush");
    });
    const opened = await s.run("core.project.open", { root, color: "#7db4ff" });

    // Covers the check window with a new window of the same application. It is the same covered state as when the user window is behind another window.
    // core.card.sidebar.set answers after it waits for the display of the plane, without changing the focus and the window order.
    const covered = (await s.get("host.window")).frame;
    await s.run("core.window.new");
    const windows = await s.windows(2, "the covering window did not open");
    const cover = s.on(windows.find((w) => w.window !== s.window).window);
    s.cleanup(async () => {
      await cover.close();
      await s.windows(1, "the covering window did not close");
    });
    await cover.run("host.window.resize", { width: covered.width + 200, height: covered.height + 100 });
    await cover.run("host.window.move", { x: covered.x - 100, y: covered.y });
    await s.until("host.window", (w) => w.occluded === true, "the covered window was not reported occluded");
    const card = (await s.get("core.grid")).cards.find((candidate) => !candidate.fixed);
    await s.run("core.card.sidebar.set", { card: card.id, side: "top", set: "off" });
    const shown = (await s.get("core.grid")).cards.find((candidate) => candidate.id === card.id);
    assert.equal(shown.sidebars.top?.set ?? "off", "off", `the top sidebar of ${card.id} in ${opened.id} was not turned off`);
    // When the covering is released, the check writes the positions and states of the two windows and the frontmost application to classify the cause of a changed window order.
    const after = await s.get("host.window");
    if (after.occluded !== true) {
      const state = ({ frame, occluded, active }) => JSON.stringify({ frame, occluded, active });
      assert.fail(`the window became uncovered during the check: window ${state(after)}, ` +
        `cover ${state(await cover.get("host.window"))}, frontmost application ${frontmostApp()}, host ${s.client.endpoint.pid}`);
    }
    assert.equal((await s.get("core.window.workbench")).visibility, "visible", "the covered window hid its document");
  });
}
