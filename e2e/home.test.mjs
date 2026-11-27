// Checks the project home, the reuse of an existing OS window, the creation of a folder and the restoration of the work screen.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { APPS, failure, open, recordingSummary } from "@soksak/window-check/app.mjs";
import { fresh, START_PLUGIN } from "./fixture.mjs";
import { processes } from "@soksak/window-check/platform/platform.mjs";
import { RASTER, rasterReady } from "./raster-probe.mjs";

/** One window of the window list that is not in known. */
const added = (list, known) => list.find((w) => !known.includes(w.window)).window;

/** Waits until the number of rows that the project home lists is count. */
const listed = (s, count, message) => s.until("core.home", (home) => home.rows.length === count, message);

/** Waits until the saving of the project ends and returns the project whose name is id. */
const project = async (s, id) => (await s.get("core.projects")).find((p) => p.id === id);

/** On failure, it keeps the native state right after the return before cleanup. */
async function returnProject(s, id, phase) {
  try {
    await s.run("core.home.open", { project: id });
  } catch (error) {
    const window = await s.get("host.window");
    const page = { screen: await s.get("core.screen"), surfaces: await s.get("core.surfaces") };
    throw new Error(`${phase}: ${error.message}; page state: ${JSON.stringify(page)}; native state: ${JSON.stringify(window)}`,
      { cause: error });
  }
}

/**
 * The processes of the raster probe tabs of the grid: the service pid and the sorted child pids that the sessions of the tabs report,
 * hidden tabs included. The process table must show the service with exactly those children and no zombie among them.
 */
async function rasterProcessSnapshot(s, message) {
  const tabs = (await s.get("core.grid")).cards.flatMap((card) => card.tabs).filter((tab) => tab.plugin === RASTER);
  const sessions = [];
  for (const tab of tabs) {
    sessions.push(await s.until("rasterprobe.session", (value) => value?.connected === true && typeof value.session === "string",
      `${message}: ${tab.tab} has no session`, { surface: tab.tab }));
  }
  const services = new Set(sessions.map((session) => session.service?.pid));
  assert.equal(services.size, 1, `${message}: the raster probe sessions do not share one service: ${JSON.stringify(sessions)}`);
  const [service] = services;
  assert.ok(Number.isInteger(service) && service > 0, `${message}: the raster probe service pid is missing`);
  const rows = processes().map(({ pid, ppid, state }) => ({ pid, parent: ppid, state }));
  const running = rows.find((row) => row.pid === service);
  assert.ok(running && running.state !== "zombie", `${message}: the raster probe service ${service} is not running`);
  const children = rows.filter((row) => row.parent === service);
  for (const child of children) assert.equal(child.state === "zombie", false, `${message}: raster probe child ${child.pid} is a zombie`);
  const reported = sessions.map((session) => session.child).sort((a, b) => a - b);
  assert.deepEqual(children.map((row) => row.pid).sort((a, b) => a - b), reported,
    `${message}: the children of the raster probe service are not the children of its sessions`);
  return { service, children: reported };
}

/** Checks that the return to the project restored not only the DOM slots but also the visible native image raster. */
async function assertVisibleRasters(s, minimum, message) {
  const surfaces = await s.surfaces(RASTER);
  assert.ok(surfaces.length >= minimum, `${message}: expected at least ${minimum} visible raster views, got ${surfaces.length}`);
  const window = await s.until("host.window", (state) => surfaces.every((surface) => {
    const region = state.regions.find((item) => item.surface === surface.surface);
    return region?.visible && region.presented && region.frame.width > 0 && region.frame.height > 0;
  }), `${message}: native regions did not settle`);
  for (const surface of surfaces) {
    const region = window.regions.find((item) => item.surface === surface.surface);
    assert.ok(region, `${message}: ${surface.surface} has no native image region`);
    assert.equal(region.visible, true,
      `${message}: ${surface.surface} is a visible raster surface but its native image region is hidden`);
    assert.ok(region.presented, `${message}: ${surface.surface} has no presented raster`);
    assert.ok(region.frame.width > 0 && region.frame.height > 0,
      `${message}: ${surface.surface} has an empty native frame`);
    assert.equal(region.presented.width, Math.round(region.frame.width * region.presented.scale),
      `${message}: ${surface.surface} raster width does not match its native frame`);
    assert.equal(region.presented.height, Math.round(region.frame.height * region.presented.scale),
      `${message}: ${surface.surface} raster height does not match its native frame`);
  }
  const visibleIds = new Set(surfaces.map((surface) => surface.surface));
  const visibleRegions = window.regions.filter((region) => region.visible && visibleIds.has(region.surface));
  assert.equal(visibleRegions.length, surfaces.length,
    `${message}: visible raster surfaces and visible native image regions are not one-to-one`);
}

/** Checks that no web view that the grid does not own remains in the native surface list of the host. */
async function assertNoOrphanNativeSurfaces(s, message) {
  const grid = await s.get("core.grid");
  const host = await s.get("host.window");
  const sections = (await s.get("core.sidebars")).flatMap((sidebar) => sidebar.sections.map((section) => section.surfaceId));
  const owned = new Set([...grid.cards.flatMap((card) => card.tabs.map((tab) => tab.tab)), ...sections]);
  const orphan = host.surfaces.filter((surface) => !owned.has(surface.id));
  assert.deepEqual(orphan, [], `${message}: orphan native surfaces ${orphan.map((surface) => surface.id).join(", ")}`);
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: the project home creates and opens projects in place`, async (t) => {
    const s = await open(t, app);
    const { surface: startTab } = await fresh(s);
    const verification = await s.collect("core.verify");
    s.cleanup(async () => {
      const failed = (await verification.stop()).filter((value) => value?.rows?.some((row) =>
        row.name === "Surface presentation" && !row.ok));
      assert.deepEqual(failed, [], "the project home workflow reported a presentation error before recovering");
    });
    const temporary = realpathSync(mkdtempSync(join(tmpdir(), "soksak-home-")));
    // The deletion of the folder runs last, separately from the cleanup of the application (the cleanup runs in the reverse order of registration).
    s.cleanup(() => rmSync(temporary, { recursive: true, force: true }));
    s.cleanupSteps(
      async () => {
        for (const window of await s.get("host.windows")) {
          if (window.window !== s.window) await s.on(window.window).close();
        }
        await s.windows(1, "extra windows did not close");
      },
      async () => {
        for (const item of await s.get("core.projects")) {
          if (item.root.startsWith(temporary)) await s.run("core.project.close", { id: item.id });
        }
        const remaining = await s.get("core.projects");
        if (remaining.length) await s.run("core.project.activate", { id: remaining[0].id });
        await s.run("core.projects.flush");
      },
    );

    // The start layout holds one content card between the window sidebars (docs/spec/plugins.md#environmentjson); the check splits it
    // into an upper and a lower card, so the card that the check splits from it holds the focus.
    await s.run("core.layout.open", { card: "current", side: "bottom", plugin: START_PLUGIN });
    await s.until("core.grid", (value) => value?.cards?.filter((card) => !card.fixed).length === 2,
      "the project grid did not show the split start card");
    const first = await s.get("core.project");
    await s.run("core.settings.set", { patch: { projectOpening: "windows" }, scope: "common" });
    await s.run("core.projects.browse");
    assert.equal((await s.get("core.screen")).screen, "home");
    assert.equal((await s.surfaces(RASTER)).length, 0);
    assert.equal((await s.get("host.window")).surfaces.some((x) => x.visible), false, "the project home shows no native surface");
    await listed(s, 1, "the project home did not list the project");
    const saved = await project(s, first.id);
    const space = saved.spaces.find((x) => x.id === saved.activeSpaceId);
    assert.equal("preview" in space.layout, false, "screen state must not store renderer coordinates for previews");

    await returnProject(s, first.id, "project return");
    await s.until("core.screen", (screen) => screen.screen === "workspace", "the project did not reopen from the project home");
    // After it creates three visible raster views, the check leaves for the project home and returns to the same project.
    // If the return command restores only the DOM and displays the native image raster late, this check fails.
    let rasterCount = (await s.surfaces(RASTER)).filter((surface) => surface.visible).length;
    if (rasterCount === 0) {
      const source = (await s.get("core.grid")).cards.find((card) => card.tabs?.some((tab) => tab.tab === startTab));
      assert.ok(source, "raster source card not found");
      await s.run("core.card.split", { card: source.id, side: "right", plugin: RASTER });
      await s.until("core.surfaces", (surfaces) => surfaces.filter((surface) =>
        surface.visible && surface.plugin === RASTER).length > rasterCount,
      "the first raster card did not render");
      rasterCount = 1;
    }
    while (rasterCount < 3) {
      // Splits the largest content card along its longer side. The fixed sidebar and the inner sidebar take space, so a small card
      // cannot be split further because of the minimum size rule.
      const [largest] = (await s.get("core.grid")).cards.filter((card) => !card.fixed)
        .sort((a, b) => b.w * b.h - a.w * a.h);
      assert.ok(largest, "no content card can be split");
      await s.run("core.card.split", { card: largest.id, side: largest.w >= largest.h ? "right" : "bottom", plugin: RASTER });
      const next = await s.until("core.surfaces", (surfaces) => surfaces.filter((surface) =>
        surface.visible && surface.plugin === RASTER).length > rasterCount,
      "a raster card split did not produce another visible raster view");
      rasterCount = next.filter((surface) => surface.visible && surface.plugin === RASTER).length;
    }
    await s.until("core.surfaces", (surfaces) => surfaces.filter((item) => item.visible && item.plugin === RASTER).length >= 3,
      "three visible raster surfaces did not render");
    // The image regions of the window draw while it is covered (rasterReady).
    for (const { surface } of await s.surfaces(RASTER)) await rasterReady(s, surface);
    await s.presented();
    await assertVisibleRasters(s, 3, "before leaving the project");
    const processesAtThree = await rasterProcessSnapshot(s, "before leaving the project");
    const rasterTabs = (await s.get("core.grid")).cards.flatMap((card) => card.tabs).filter((tab) => tab.plugin === RASTER);
    assert.equal(new Set(processesAtThree.children).size, rasterTabs.length,
      "every open raster view owns one child in the shared service, including hidden tabs");
    // The session stops the recording when the check ends before its stop, and keeps it when the check fails.
    const recording = await s.record();
    await s.run("core.projects.browse");
    await s.until("core.screen", (screen) => screen.screen === "home", "the project did not enter the project home");
    await returnProject(s, first.id, "three-raster project return");
    await s.until("core.screen", (screen) => screen.screen === "workspace", "the project did not return from the project home");
    const phaseStarted = performance.now();
    let phasePrevious = phaseStarted;
    const phase = (name) => {
      const now = performance.now();
      const duration = now - phasePrevious;
      const total = now - phaseStarted;
      phasePrevious = now;
      t.diagnostic(`${app.name}: PASS restoration ${name} (${duration.toFixed(0)}ms, total ${total.toFixed(0)}ms)`);
      return duration;
    };
    t.diagnostic(`${app.name}: START restoration connection`);
    const restored = (surfaces) => surfaces.filter((surface) => surface.visible && surface.plugin === RASTER &&
      surface.exposes.includes("status rasterprobe.session") && surface.exposes.includes("status core.surface.document"));
    await s.until("core.surfaces", (surfaces) => restored(surfaces).length > 0,
      "restoration connection did not register raster surfaces");
    // A notification that satisfied the condition can describe a surface from before the return changed the surfaces, so the check reads the current registry again.
    const restoredRasters = restored(await s.get("core.surfaces"));
    assert.ok(restoredRasters.length > 0, "the current registry has no restored raster surface");
    for (const raster of restoredRasters) {
      await s.until("rasterprobe.session", (session) => session?.connected === true && typeof session.session === "string",
        "restored raster session did not connect", { surface: raster.surface });
    }
    phase("connection");
    t.diagnostic(`${app.name}: START restoration document`);
    for (const raster of restoredRasters) {
      await s.until("core.surface.document", (document) => document?.readyState === "complete" && document.themed,
        "restored raster document did not become ready", { surface: raster.surface });
    }
    phase("document");
    t.diagnostic(`${app.name}: START restoration raster`);
    await assertVisibleRasters(s, 3, "restored raster phase");
    phase("raster");
    t.diagnostic(`${app.name}: START restoration first presentation`);
    await s.presented();
    phase("first-presentation");
    const stopped = await recording.stop({ after: 0 });
    t.diagnostic(`project return: ${recordingSummary(stopped)}`);
    const returned = await s.get("host.window");
    const expectedRasters = (await s.surfaces(RASTER)).filter((surface) => surface.visible);
    for (const surface of expectedRasters) {
      const region = returned.regions.find((item) => item.surface === surface.surface);
      assert.ok(region, `project return: ${surface.surface} has no native region`);
      assert.equal(region.visible, true, `project return: ${surface.surface} is visible in DOM but native region is hidden`);
    }
    await assertVisibleRasters(s, 3, "immediately after returning to the project");
    await assertNoOrphanNativeSurfaces(s, "immediately after returning to the project");
    assert.deepEqual(await rasterProcessSnapshot(s, "after returning to the project"), processesAtThree,
      "project return must retain the same service and child PIDs without creating sessions");

    await s.run("core.window.new");
    const two = await s.windows(2, "new OS window was not created");
    let child = s.on(added(two, [s.window]));
    await listed(child, 1, "new window project home did not initialise");
    assert.equal(await child.get("core.project"), null);
    const blank = await child.get("host.window");
    assert.deepEqual([blank.surfaces.length, blank.modal], [0, null], "a project home window has only its main document");

    // Submits the real project home form that creates a project folder.
    await child.run("core.home.form.open", { mode: "create" });
    await child.run("core.home.form.set", { field: "name", value: "created" });
    await child.run("core.home.form.set", { field: "parent", value: temporary });
    await child.run("core.home.form.submit");
    await child.until("core.screen", (screen) => screen.screen === "workspace", "created project did not replace the project home");
    assert.equal((await s.get("host.windows")).length, 2);
    const created = await child.get("core.project");
    assert.equal(created.root, join(temporary, "created"));
    assert.equal(existsSync(created.root), true);
    // The start layout of a new project holds tabs of plugins that a check configuration does not install, which have no native
    // surface, so the check adds a layout probe tab whose native surface the return to the project shows again.
    const focused = (await child.until("core.grid", (grid) => grid?.cards.some((card) => card.focused),
      "new project cards did not render")).cards.find((card) => card.focused);
    const { tab: probe } = await child.run("core.card.add-tab", { card: focused.id, plugin: "layoutprobe" });
    await child.until("core.surfaces", (surfaces) => surfaces.some((item) => item.surface === probe && item.status?.phase === "ready"),
      `the probe tab ${probe} of the created project did not become ready`);
    await child.run("core.projects.browse");
    await child.until("core.screen", (screen) => screen.screen === "home", "project list button did not open the project home");
    const order = (await child.get("core.home")).rows;
    assert.ok(order.includes(created.id), "the project home must list the created project");
    await child.run("core.home.pin", { project: created.id });
    await child.until("core.projects", (list) => list.find((p) => p.id === created.id)?.pinned === true, "pin was not saved");
    await child.run("core.home.search", { query: "created" });
    await listed(child, 1, "search did not filter the project home");
    await child.run("core.project.activate", { id: created.id });
    assert.equal((await s.get("host.windows")).length, 2);
    await child.until("host.window", (state) => state.surfaces.some((x) => x.visible), "return did not restore native content");
    await child.close();
    await s.windows(1, "project close did not complete");

    // Opening a saved project in an unselected new window does not increase the number of windows.
    await s.run("core.window.new");
    child = s.on(added(await s.windows(2, "second project home window did not open"), [s.window]));
    const homeOrder = (await listed(child, 2, "saved project home did not render")).rows;
    assert.ok(homeOrder.includes(created.id), "the project home must list the saved project");
    await returnProject(child, created.id, "saved project in a new window");
    await child.until("core.screen", (screen) => screen.screen === "workspace", "saved project did not reuse the new window");
    assert.equal((await s.get("host.windows")).length, 2);

    // An already open project selects its existing window and leaves the unselected window as it is.
    assert.deepEqual(await s.get("host.dock"), ["새 창"]);
    await s.run("host.dock.select", { title: "새 창" });
    const three = await s.windows(3, "third project home did not open");
    const third = s.on(added(three, [s.window, child.window]));
    await listed(third, 2, "third project home did not render");
    await third.run("core.project.activate", { id: created.id });
    assert.equal((await s.get("host.windows")).length, 3);
    assert.equal(await third.get("core.project"), null);
    for (const name of ["../escape", "created"]) {
      assert.equal(await failure(third.run("core.folder.create", { parent: temporary, name })), -32000,
        `the host must reject creating ${name}`);
    }
    assert.equal(existsSync(join(temporary, "created")), true);
    assert.equal((await third.get("core.screen")).screen, "home");
    t.diagnostic("same OS window reused for creation and saved projects; Dock menu creates an unassigned project home window");
  });
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: the project home names a missing project folder and removes the project`, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    const first = await s.get("core.project");
    const temporary = realpathSync(mkdtempSync(join(tmpdir(), "soksak-missing-")));
    s.cleanup(() => rmSync(temporary, { recursive: true, force: true }));
    s.cleanup(async () => {
      for (const item of await s.get("core.projects")) {
        if (item.root.startsWith(temporary)) await s.run("core.project.close", { id: item.id });
      }
      await s.run("core.project.activate", { id: first.id });
      await s.run("core.projects.flush");
    });
    const folder = join(temporary, "gone");
    mkdirSync(folder);
    const missing = await s.run("core.project.open", { root: folder });
    await s.run("core.projects.flush");
    // The project opens in its own window (the default of projectOpening is windows). The check adds a tab of the layout probe to
    // that window and deletes the folder after the tab is ready, so the window holds the native surface of a tab of the project.
    const listedWindows = await s.until("host.windows", (list) => list.some((item) => item.project === folder && item.ready),
      "the project did not open in its own window");
    const projectWindow = listedWindows.find((item) => item.project === folder);
    const other = s.on(projectWindow.window);
    const focused = (await other.until("core.grid", (grid) => grid?.cards.some((card) => card.focused),
      "the project window has no focused card")).cards.find((card) => card.focused);
    const { tab: probe } = await other.run("core.card.add-tab", { card: focused.id, plugin: "layoutprobe" });
    await other.until("core.surfaces", (surfaces) => surfaces.some((item) => item.surface === probe && item.status?.phase === "ready"),
      `the probe tab ${probe} of the project did not become ready`);
    const tabs = (await other.get("core.grid")).cards.flatMap((card) => card.tabs ?? []).map((tab) => tab.tab);
    rmSync(folder, { recursive: true });
    // This check shows the missing folder in the project home and makes the project unopenable. Both errors are shown on the screen and recorded.
    s.expectError(new RegExp(`^error home project ${folder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: `));
    s.expectError(/^error home: project directory does not exist: /);

    await s.run("core.projects.browse");
    const home = await s.until("core.home", (state) => state.folderErrors?.[missing.id] !== undefined,
      "the project home did not report the missing project folder");
    assert.deepEqual(home.folderErrors, { [missing.id]: `project directory does not exist: ${folder}` },
      "both hosts report the contract message for the missing folder only");
    assert.deepEqual(home.previewErrors, {}, "the project home declares no preview of a stored layout");
    // The failure of a home command is shown in the error line of the home and the screen stays on the project home.
    await s.run("core.home.open", { project: missing.id });
    assert.equal((await s.get("core.screen")).screen, "home", "the failed open left the project home");

    // The removal is a confirm state of the row: the × asks, and the danger button removes the record and keeps the folder.
    await s.run("core.home.confirm", { project: missing.id, answer: "ask" });
    await s.run("core.home.confirm", { project: missing.id, answer: "yes" });
    await s.until("core.home", (state) => !state.rows.includes(missing.id), "the removed project is still listed");
    assert.equal((await s.get("core.projects")).some((item) => item.id === missing.id), false, "the removed project is still stored");
    assert.equal((await s.get("core.home")).rows.includes(first.id), true, "removing a project removed another project");
    // The window that showed the deleted project becomes a window without a project, as if its project tabs were closed, shows the project home, and cleans up the surfaces of those tabs
    // (docs/spec/projects.md#settings).
    await s.until("host.windows", (list) => list.some((item) => item.window === projectWindow.window && item.project === null) &&
      !list.some((item) => item.project === folder), "the window of the removed project still shows it");
    await other.until("core.screen", (state) => state.screen === "home", "the window of the removed project did not show the project home");
    const ended = new Set(tabs);
    await other.until("host.window", (state) => !state.surfaces.some((surface) => ended.has(surface.id)),
      "the window of the removed project kept the native surfaces of its tabs");
    // Closes the window that this check opened so that no window remains for the next check.
    await other.close();
    await s.windows(1, "the window of the removed project did not close");
    t.diagnostic(`missing folder reason: ${home.folderErrors[missing.id]}`);
  });
}
