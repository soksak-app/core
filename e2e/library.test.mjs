// Checks the start of the library, the reuse of an existing OS window, the creation of a folder and the restoration of the work screen.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { APPS, failure, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";
import { frames, pixel, readFrame } from "@soksak/window-check/frame.mjs";
import { processTable } from "@soksak/window-check/process-table.mjs";
import { RASTER, rasterReady } from "./raster-probe.mjs";

/** One window of the window list that is not in known. */
const added = (list, known) => list.find((w) => !known.includes(w.window)).window;

/** Waits until the number of projects that the library shows is count. */
const shown = (s, count, message) => s.until("core.library", (library) => library.shown.length === count, message);

/** Waits until the saving of the project ends and returns the project whose name is id. */
const project = async (s, id) => (await s.get("core.projects")).find((p) => p.id === id);

/** Does not accept a state in which a library command swallowed an error inside and only switched the screen. */
async function assertNoLibraryError(s, message) {
  const library = await s.get("core.library");
  assert.equal(library.error, null, `${message}: library reported ${library.error}`);
}

/** On failure, it keeps the native state right after the return before cleanup. */
async function returnProject(s, id, phase) {
  try {
    await s.run("core.library.open", { id });
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
    sessions.push(await s.until("rasterprobe.session", (value) => value?.connected && typeof value.session === "string" ? value : null,
      `${message}: ${tab.id} has no session`, { surface: tab.id }));
  }
  const services = new Set(sessions.map((session) => session.service?.pid));
  assert.equal(services.size, 1, `${message}: the raster probe sessions do not share one service: ${JSON.stringify(sessions)}`);
  const [service] = services;
  assert.ok(Number.isInteger(service) && service > 0, `${message}: the raster probe service pid is missing`);
  const rows = processTable("pid=,ppid=,stat=").trim().split("\n").map((line) => line.trim().split(/\s+/))
    .map(([pid, parent, state]) => ({ pid: Number(pid), parent: Number(parent), state }));
  const running = rows.find((row) => row.pid === service);
  assert.ok(running && !running.state.includes("Z"), `${message}: the raster probe service ${service} is not running`);
  const children = rows.filter((row) => row.parent === service);
  for (const child of children) assert.equal(child.state.includes("Z"), false, `${message}: raster probe child ${child.pid} is a zombie`);
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
  const owned = new Set([...grid.cards.flatMap((card) => card.tabs.map((tab) => tab.id)), ...sections]);
  const orphan = host.surfaces.filter((surface) => !owned.has(surface.id));
  assert.deepEqual(orphan, [], `${message}: orphan native surfaces ${orphan.map((surface) => surface.id).join(", ")}`);
}

/** Checks the white of the DOM in the image regions in the real pixels of a recording of the whole return transition. */
function assertNoWhiteBleed(frameFiles, regions, message) {
  assert.ok(frameFiles.length > 0, `${message}: capture produced no frames`);
  let worst = { ratio: 0, frame: -1, surface: "" };
  for (const [frameIndex, path] of frameFiles.entries()) {
    const frame = readFrame(path);
    for (const region of regions) {
      const x0 = Math.max(0, Math.floor(region.frame.x));
      const y0 = Math.max(0, Math.floor(region.frame.y));
      const x1 = Math.min(frame.width, Math.ceil(region.frame.x + region.frame.width));
      const y1 = Math.min(frame.height, Math.ceil(region.frame.y + region.frame.height));
      let white = 0;
      let samples = 0;
      for (let y = y0; y < y1; y += 2) {
        for (let x = x0; x < x1; x += 2) {
          const [r, g, b] = pixel(frame, x, y);
          samples++;
          if (r >= 245 && g >= 245 && b >= 245) white++;
        }
      }
      const ratio = samples ? white / samples : 0;
      if (ratio > worst.ratio) worst = { ratio, frame: frameIndex, surface: region.surface };
    }
  }
  assert.ok(worst.ratio <= 0.01,
    `${message}: ${worst.surface} exposed ${(worst.ratio * 100).toFixed(2)}% white pixels in frame ${worst.frame}`);
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: library windows create and open projects in place`, async (t) => {
    const s = await open(t, app);
    const { surface: startTab } = await fresh(s);
    const verification = await s.collect("core.verify");
    s.cleanup(async () => {
      const failed = (await verification.stop()).filter((value) => value?.rows?.some((row) =>
        row.name === "Surface presentation" && !row.ok));
      assert.deepEqual(failed, [], "the library workflow reported a presentation error before recovering");
    });
    const temporary = realpathSync(mkdtempSync(join(tmpdir(), "soksak-library-")));
    // The deletion of the folder runs last, separately from the cleanup of the application (the cleanup runs in the reverse order of registration).
    s.cleanup(() => rmSync(temporary, { recursive: true, force: true }));
    s.cleanup(async () => {
      for (const window of await s.get("host.windows")) {
        if (window.window !== s.window) await s.on(window.window).close();
      }
      await s.windows(1, "extra windows did not close");
      for (const item of await s.get("core.projects")) {
        if (item.root.startsWith(temporary)) await s.run("core.project.close", { id: item.id });
      }
      const remaining = await s.get("core.projects");
      if (remaining.length) await s.run("core.project.activate", { id: remaining[0].id });
      await s.run("core.projects.flush");
    });

    const grid = await s.until("core.grid", (value) => value?.cards?.length > 0, "the project grid did not render");
    const geometry = grid.cards.map(({ id, x, y, w, h }) => ({ id, x, y, w, h }));
    const first = await s.get("core.project");
    await s.run("core.settings.set", { patch: { projectOpening: "windows" }, scope: "common" });
    await s.run("core.projects.browse");
    assert.equal((await s.get("core.screen")).screen, "library");
    assert.equal((await s.surfaces(RASTER)).length, 0);
    assert.equal((await s.get("host.window")).surfaces.some((x) => x.visible), false, "the library shows no native surface");
    const library = await shown(s, 1, "the library did not list the project");
    const preview = library.previews[first.id].map(({ card, x, y, w, h }) => ({ id: card, x, y, w, h }));
    assert.deepEqual(preview.map((c) => c.id).sort(), geometry.map((c) => c.id).sort(), "preview must include the workspace cards");
    for (const a of geometry) {
      for (const b of geometry) {
        const pa = preview.find((c) => c.id === a.id), pb = preview.find((c) => c.id === b.id);
        if (a.x + a.w <= b.x) assert.ok(pa.x + pa.w < pb.x, `${a.id} must remain left of ${b.id}`);
        if (a.y + a.h <= b.y) assert.ok(pa.y + pa.h < pb.y, `${a.id} must remain above ${b.id}`);
      }
    }
    // The start layout holds the fixed sidebars left and right and between them two content cards, the card of the start tab above
    // the other.
    const upperId = grid.cards.find((card) => card.tabs?.some((tab) => tab.id === startTab)).id;
    const lowerId = grid.cards.find((card) => card.id !== upperId && card.tabs?.length > 0).id;
    const [left, upper, lower, right] = ["left", upperId, lowerId, "right"]
      .map((id) => preview.find((c) => c.id === id));
    assert.ok(Math.abs(left.w - right.w) <= 1 / 64, "sidebar widths must be uniform");
    assert.ok(Math.abs(upper.h - lower.h) <= 1 / 64, "split rows must have equal heights");
    const gaps = [upper.x - left.x - left.w, right.x - upper.x - upper.w, lower.y - upper.y - upper.h];
    assert.ok(gaps.every((gap) => gap > 0 && Math.abs(gap - gaps[0]) <= 1 / 64), "pane gaps must be uniform on both axes");
    const saved = await project(s, first.id);
    const space = saved.spaces.find((x) => x.id === saved.activeSpaceId);
    assert.equal("preview" in space.layout, false, "screen state must not store renderer coordinates for previews");

    await returnProject(s, first.id, "preview project return");
    await s.until("core.screen", (screen) => screen.screen === "workspace", "the project did not reopen after the preview check");
    await assertNoLibraryError(s, "the preview project return");
    // After it creates three visible raster views, the check leaves for the library and returns to the same project.
    // If the return command restores only the DOM and displays the native image raster late, this check fails.
    let rasterCount = (await s.surfaces(RASTER)).filter((surface) => surface.visible).length;
    if (rasterCount === 0) {
      const source = grid.cards.find((card) => card.id === upperId && card.tabs.length > 0);
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
    const capture = await s.request("diagnostics.capture.start", {});
    let captureActive = true;
    s.cleanup(async () => {
      if (captureActive) await s.request("diagnostics.capture.stop", { after: 0 });
      rmSync(capture.frames, { recursive: true, force: true });
      captureActive = false;
    });
    await s.run("core.projects.browse");
    await s.until("core.screen", (screen) => screen.screen === "library", "the project did not enter the library");
    await returnProject(s, first.id, "three-raster project return");
    await s.until("core.screen", (screen) => screen.screen === "workspace", "the project did not return from the library");
    await assertNoLibraryError(s, "the measured project return");
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
    const stopped = await s.request("diagnostics.capture.stop", { after: 0 });
    captureActive = false;
    const returned = await s.get("host.window");
    const expectedRasters = (await s.surfaces(RASTER)).filter((surface) => surface.visible);
    const returnedRegions = expectedRasters.map((surface) => {
      const region = returned.regions.find((item) => item.surface === surface.surface);
      assert.ok(region, `project return pixel composition: ${surface.surface} has no native region to measure`);
      assert.equal(region.visible, true,
        `project return pixel composition: ${surface.surface} is visible in DOM but native region is hidden`);
      return region;
    });
    assertNoWhiteBleed(frames(stopped.frames), returnedRegions, "project return pixel composition");
    rmSync(stopped.frames, { recursive: true, force: true });
    await assertVisibleRasters(s, 3, "immediately after returning to the project");
    await assertNoOrphanNativeSurfaces(s, "immediately after returning to the project");
    assert.deepEqual(await rasterProcessSnapshot(s, "after returning to the project"), processesAtThree,
      "project return must retain the same service and child PIDs without creating sessions");

    await s.run("core.window.new");
    const two = await s.windows(2, "new OS window was not created");
    let child = s.on(added(two, [s.window]));
    await shown(child, 1, "new window library did not initialise");
    assert.equal(await child.get("core.project"), null);
    const blank = await child.get("host.window");
    assert.deepEqual([blank.surfaces.length, blank.modal], [0, null], "a library window has only its main document");

    // Submits the real library creation form.
    await child.run("core.library.form.open", { mode: "create" });
    await child.run("core.library.form.set", { field: "name", value: "created" });
    await child.run("core.library.form.set", { field: "parent", value: temporary });
    await child.run("core.library.form.submit");
    await child.until("core.screen", (screen) => screen.screen === "workspace", "created project did not replace the library");
    assert.equal((await s.get("host.windows")).length, 2);
    const created = await child.get("core.project");
    assert.equal(created.root, join(temporary, "created"));
    assert.equal(existsSync(created.root), true);
    await child.until("core.grid", (grid) => grid?.cards.length > 0, "new project cards did not render");
    await child.run("core.projects.browse");
    await child.until("core.screen", (screen) => screen.screen === "library", "project list button did not open the library");
    await child.until("core.library", (state) => state.count === "프로젝트 2 · 열림 2", "open project count is not actual");
    const order = (await child.get("core.library")).shown;
    assert.ok(order.includes(created.id), "the library must list the created project");
    await child.run("core.library.pin", { id: created.id, pinned: true });
    await child.until("core.projects", (list) => list.find((p) => p.id === created.id)?.pinned, "pin was not saved");
    await child.run("core.library.search", { query: "created" });
    await shown(child, 1, "search did not filter the library");
    await child.run("core.project.activate", { id: created.id });
    assert.equal((await s.get("host.windows")).length, 2);
    await child.until("host.window", (state) => state.surfaces.some((x) => x.visible), "return did not restore native content");
    await child.close();
    await s.windows(1, "project close did not complete");

    // Opening a saved project in an unselected new window does not increase the number of windows.
    await s.run("core.window.new");
    child = s.on(added(await s.windows(2, "second library window did not open"), [s.window]));
    const libraryOrder = (await shown(child, 2, "saved library did not render")).shown;
    assert.ok(libraryOrder.includes(created.id), "the library must list the saved project");
    await returnProject(child, created.id, "saved project in a new window");
    await child.until("core.screen", (screen) => screen.screen === "workspace", "saved project did not reuse the new window");
    assert.equal((await s.get("host.windows")).length, 2);

    // An already open project selects its existing window and leaves the unselected window as it is.
    assert.deepEqual(await s.get("host.dock"), ["새 창"]);
    await s.run("host.dock.select", { title: "새 창" });
    const three = await s.windows(3, "third library did not open");
    const third = s.on(added(three, [s.window, child.window]));
    await shown(third, 2, "third library did not render");
    await third.run("core.project.activate", { id: created.id });
    assert.equal((await s.get("host.windows")).length, 3);
    assert.equal(await third.get("core.project"), null);
    for (const name of ["../escape", "created"]) {
      assert.equal(await failure(third.run("core.folder.create", { parent: temporary, name })), -32000,
        `the host must reject creating ${name}`);
    }
    assert.equal(existsSync(join(temporary, "created")), true);
    assert.equal((await third.get("core.screen")).screen, "library");
    t.diagnostic("same OS window reused for creation and saved projects; Dock menu creates an unassigned library window");
  });
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: the library names a missing project folder and removes the project`, async (t) => {
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
    const listed = await s.until("host.windows", (list) => list.some((item) => item.project === folder && item.ready),
      "the project did not open in its own window");
    const projectWindow = listed.find((item) => item.project === folder);
    const other = s.on(projectWindow.window);
    const focused = (await other.until("core.grid", (grid) => grid?.cards.some((card) => card.focused),
      "the project window has no focused card")).cards.find((card) => card.focused);
    const { tab: probe } = await other.run("core.card.add-tab", { card: focused.id, plugin: "layoutprobe" });
    await other.until("core.surfaces", (surfaces) => surfaces.some((item) => item.surface === probe && item.status?.phase === "ready"),
      `the probe tab ${probe} of the project did not become ready`);
    const tabs = (await other.get("core.grid")).cards.flatMap((card) => card.tabs ?? []).map((tab) => tab.id);
    rmSync(folder, { recursive: true });
    // This check shows the missing folder in the library and makes the project unopenable. Both errors are shown on the screen and recorded.
    s.expectError(new RegExp(`^error workbench library project ${folder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: `));
    s.expectError(/^error workbench library: project directory does not exist: /);

    await s.run("core.projects.browse");
    const library = await s.until("core.library", (state) => state.folderErrors?.[missing.id] !== undefined,
      "the library did not report the missing project folder");
    assert.deepEqual(library.folderErrors, { [missing.id]: `project directory does not exist: ${folder}` },
      "both hosts report the contract message for the missing folder only");
    assert.equal(library.previewErrors[missing.id], undefined, "the stored layout of the missing project is valid");
    // The failure of a library command is shown in the error line of the library.
    await s.run("core.library.open", { id: missing.id });
    const failed = await s.until("core.library", (state) => state.error !== null, "opening the missing project showed no error");
    assert.equal(failed.error, `project directory does not exist: ${folder}`);
    assert.equal((await s.get("core.screen")).screen, "library", "the failed open left the library");

    await s.run("core.library.remove", { id: missing.id });
    await s.until("core.library", (state) => !state.shown.includes(missing.id), "the removed project is still shown");
    assert.equal((await s.get("core.projects")).some((item) => item.id === missing.id), false, "the removed project is still stored");
    assert.equal((await s.get("core.library")).shown.includes(first.id), true, "removing a project removed another project");
    // The window that showed the deleted project becomes a window without a project, as if its project tabs were closed, shows the library, and cleans up the surfaces of those tabs
    // (docs/spec/projects.md#settings).
    await s.until("host.windows", (list) => list.some((item) => item.window === projectWindow.window && item.project === null) &&
      !list.some((item) => item.project === folder), "the window of the removed project still shows it");
    await other.until("core.screen", (state) => state.screen === "library", "the window of the removed project did not show the library");
    const ended = new Set(tabs);
    await other.until("host.window", (state) => !state.surfaces.some((surface) => ended.has(surface.id)),
      "the window of the removed project kept the native surfaces of its tabs");
    // Closes the window that this check opened so that no window remains for the next check.
    await other.close();
    await s.windows(1, "the window of the removed project did not close");
    t.diagnostic(`missing folder reason: ${library.folderErrors[missing.id]}`);
  });
}
