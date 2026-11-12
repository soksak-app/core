// Checks the core boundary of view surfaces through fixtures: the image regions of the raster probe (e2e/raster-probe.mjs), whose
// fake persistent sidecar service draws their frames and holds one session with one child process per surface, and the tab
// reports of the layout probe. The checks cover the presentation of split and balanced image regions, the shared service and its
// sessions across project returns, page starts and project removal, native focus on a click, the tab title bound, the directory that
// a split inherits, divider drags, and window resizes.
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { APPS, drag, open } from "@soksak/window-check/app.mjs";
import { currentEventOffsets, readEvents, traceRows, untilEventLine } from "@soksak/window-check/event-log.mjs";
import { endSignal, untilFolderState } from "@soksak/window-check/folder-wait.mjs";
import { fresh, reading, START_PLUGIN } from "./fixture.mjs";
import { frames, pixel, readFrame } from "@soksak/window-check/frame.mjs";
import { rasterMarks, surfaceBoxes, whitePixels } from "./outside.mjs";
import { assertHeldStatesShown } from "@soksak/window-check/drag-measurement.mjs";
import { readStills, requireNoLostStills } from "@soksak/window-check/stills.mjs";
import { presentsFrame } from "@soksak/window-check/region-raster.mjs";
import {
  acceptedCurrentViewReplies, currentPageNativeViewCalls, currentPageViewCallCoverage,
} from "./reload-view-reply.mjs";
import { unansweredViewCalls } from "@soksak/window-check/view-calls.mjs";
import { appDomWebviews, expectedPresentations, rasterIdentity, viewPresentationJoins, viewWebviews } from "./view-display.mjs";
import {
  closeRasterTabs, ensureRasters, MEASURED, presentedFrame, RASTER, rasterReady, rasterServiceSnapshot, REGION, setMeasuredColor,
} from "./raster-probe.mjs";

/** The image region of the raster probe `surface` in a host.window status. */
const regionOf = (host, surface) => host.regions.find((item) => item.surface === surface && item.name === REGION);

/** Waits until the raster probe `surface` has an open session and returns its session status. */
const sessionOf = (s, surface, message = `${surface} did not open a sidecar session`) =>
  s.until("rasterprobe.session", (state) => typeof state?.session === "string" && state.connected === true, message, { surface });

async function lastFrame(session) {
  // The session removes the recording when the check passes and keeps it when the check fails.
  const recording = await session.record();
  const displayed = await session.presented();
  const stopped = await recording.stop({ after: displayed.displayed });
  requireNoLostStills(readStills(stopped.stills), "the last frame capture");
  const paths = frames(stopped.frames);
  assert.ok(paths.length > 0, "the capture produced no frames");
  // The last still shows the presented window only when it was requested at or after the presentation.
  const frame = readFrame(paths.at(-1));
  assert.ok(frame.requested >= displayed.displayed, `the last still was requested at ${frame.requested}ms, before the ` +
    `presentation at ${displayed.displayed}ms`);
  return frame;
}

async function assertGridFillsPlane(session, message) {
  const grid = await session.get("core.grid");
  assert.ok(grid?.plane, `${message}: grid has no plane measurement`);
  assert.equal(Math.round(grid.width), Math.round(grid.plane.w),
    `${message}: grid width ${grid.width} does not fill plane width ${grid.plane.w}`);
  assert.equal(Math.round(grid.height), Math.round(grid.plane.h),
    `${message}: grid height ${grid.height} does not fill plane height ${grid.plane.h}`);
}

/**
 * Prepares two layout probe views for the notice checks: `shown`, the start tab in the focused card, and `hidden`, a view in a card
 * split from it that is visible but not focused. Returns their surfaces with the card and notice readers of core.grid.
 */
async function twoNoticeViews(s) {
  const { surface: shown } = await fresh(s);
  const cardOf = (grid, surface) => grid.cards.find((card) => card.tabs.some((tab) => tab.id === surface));
  const notice = (grid, surface) => cardOf(grid, surface).tabs.find((tab) => tab.id === surface).notice;
  const { tab: hidden } = await s.run("core.card.split", { card: cardOf(await s.get("core.grid"), shown).id, side: "right", plugin: START_PLUGIN });
  s.cleanup(async () => {
    const grid = await s.get("core.grid");
    if (grid.cards.some((card) => card.tabs.some((tab) => tab.id === hidden))) await s.run("core.tab.close", { tab: hidden });
  });
  await s.until("core.surfaces", (surfaces) => surfaces.some((item) => item.surface === hidden && item.visible &&
    item.exposes.includes("command layoutprobe.notify")), "the split view did not register its notice command");
  await s.run("core.card.focus", { card: cardOf(await s.get("core.grid"), shown).id });
  await s.until("core.grid", (grid) => cardOf(grid, shown).focused, "the first view card did not take focus");
  return { shown, hidden, cardOf, notice };
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: a newly split image region presents its first native raster`, { timeout: 30000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    t.diagnostic(`${app.name}: START split image region presentation`);
    const rasters = await ensureRasters(s, 2);
    for (const raster of rasters) await sessionOf(s, raster.surface);
    const host = await s.get("host.window");
    for (const raster of rasters) {
      const region = regionOf(host, raster.surface);
      assert.ok(region?.visible && region.presented,
        `${raster.surface} was not visible and presented after splitting: ${JSON.stringify(region)}`);
    }
    t.diagnostic(`${app.name}: PASS split image region presentation`);
  });

  test(`${app.name}: balancing unequal cards presents every image region at its new size`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    s.cleanup(() => closeRasterTabs(s));
    const rasters = await ensureRasters(s, 3);
    for (const raster of rasters) await sessionOf(s, raster.surface);
    const regionsOf = (host) => rasters.map((raster) => regionOf(host, raster.surface));
    for (let round = 1; round <= 5; round++) {
      const layout = await s.get("core.layout");
      const grid = await s.get("core.grid");
      const own = layout.state.cards.find((item) => item.id === grid.cards.find((card) => card.tabs.some((tab) => tab.id === rasters[0].surface)).id);
      // The first raster card narrows by a third of its width, so the balance changes the size of every card of the row.
      const width = grid.lines.x[own.c1] - grid.lines.x[own.c0];
      await s.run("core.boundary.move", { axis: "x", line: own.c1, position: grid.lines.x[own.c1] - Math.round(width / 3) });
      await s.presented();
      await s.run("core.layout.balance", {});
      await s.until("host.window", (host) => regionsOf(host).every((region) => presentsFrame(region, host.scale)),
        `round ${round}: an image region did not present a raster of its new size after the balance`);
    }
  });

  test(`${app.name}: four split image regions complete native presentation without a host crash`, { timeout: 30000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    t.diagnostic(`${app.name}: START four image region presentation`);
    const rasters = await ensureRasters(s, 4);
    for (const raster of rasters) await sessionOf(s, raster.surface);
    const host = await s.get("host.window");
    const regions = host.regions.filter((region) => rasters.some((raster) =>
      raster.surface === region.surface && region.name === REGION));
    assert.equal(regions.length, 4, `four image regions were not reported: ${JSON.stringify(regions)}`);
    assert.ok(regions.every((region) => region.visible && region.presented),
      `one of four image regions was not presented: ${JSON.stringify(regions)}`);
    t.diagnostic(`${app.name}: PASS four image region presentation`);
  });

  test(`${app.name}: endpoint split requests survive repeated native WebView presentation`, { timeout: 30000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    t.diagnostic(`${app.name}: START endpoint repeated split`);
    const rasters = await ensureRasters(s, 3);
    assert.equal(rasters.length, 3, "the endpoint must report all three split image regions");
    for (const raster of rasters) {
      const session = await sessionOf(s, raster.surface, `${raster.surface} did not retain its session after repeated split`);
      assert.ok(session.session, `${raster.surface} lost its session after split`);
    }
    const host = await s.get("host.window");
    const regions = host.regions.filter((region) => rasters.some((raster) =>
      raster.surface === region.surface && region.name === REGION));
    assert.equal(regions.length, 3, `endpoint split lost a native region: ${JSON.stringify(host)}`);
    assert.ok(regions.every((region) => region.visible && region.presented),
      `endpoint split left an unpresented region: ${JSON.stringify(regions)}`);
    t.diagnostic(`${app.name}: PASS endpoint repeated split`);
  });

  test(`${app.name}: native presentation failure is explicit and the next split remains usable`, { timeout: 30000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    t.diagnostic(`${app.name}: START injected presentation failure`);
    await ensureRasters(s, 1);
    await s.request("diagnostics.presentation.failure", {});
    await assert.rejects(
      () => s.presented(),
      (error) => /injected native presentation failure/.test(error.message),
      "an injected native presentation failure must not become a generic timeout",
    );
    const rasters = await ensureRasters(s, 2);
    for (const raster of rasters) {
      const region = regionOf(await s.get("host.window"), raster.surface);
      assert.ok(region?.visible && region.presented,
        `${raster.surface} did not recover after the injected failure: ${JSON.stringify(region)}`);
    }
    t.diagnostic(`${app.name}: PASS injected presentation failure`);
  });

  test(`${app.name}: three image regions and two document views keep one view web view each and one sidecar service`, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    const rasters = await ensureRasters(s, 3);
    const documentCard = (await s.get("core.grid")).cards.find((card) =>
      card.tabs.find((tab) => tab.id === card.active)?.plugin === START_PLUGIN);
    assert.ok(documentCard, `the fixture must keep a visible ${START_PLUGIN} card`);
    await s.run("core.card.split", { card: documentCard.id, side: "right", plugin: START_PLUGIN });
    const documentViews = (surfaces) => surfaces.filter((item) => item.visible && item.kind === "tab" && item.plugin === START_PLUGIN);
    await s.until("core.surfaces", (surfaces) => documentViews(surfaces).length >= 2, "two document views did not become visible");
    for (const raster of rasters) await sessionOf(s, raster.surface, `session ${raster.surface} did not open`);
    await s.presented();
    // A document region renders independently and joins no presentation wait (docs/spec/native-surfaces.md), so the presented
    // window does not tell that the page of a new layout probe view attached its region. The check waits for the region of each
    // loaded layout probe view, shown or retained, before it counts the web views.
    const probeViews = viewWebviews(await s.get("core.surfaces")).tabs.filter((item) => item.plugin === START_PLUGIN)
      .map((item) => item.surface);
    await s.until("host.window", (state) => probeViews.every((surface) =>
      state.documents.some((item) => item.surface === surface && item.document === "page")),
    `the layout probe views ${probeViews.join(", ")} did not all attach their document region`);
    const window = await s.get("host.window");
    // The app DOM webviews are the main page of a window that has one and one view web view per loaded view surface, shown or
    // retained: the first raster probe tab was added to the card of a layout probe tab, whose view stays retained behind it. A
    // window of the Wails and Tauri hosts has one main page and a window of the mygo host has none
    // (docs/spec/plugins.md#surface-ownership). A view web view is not a document region, so it is counted in appDomWebviews and
    // not in documentWebviews.
    const surfaces = await s.get("core.surfaces");
    const shown = surfaces.filter((item) => item.visible && item.kind === "tab" && (item.plugin === RASTER || item.plugin === START_PLUGIN));
    assert.equal(shown.length, 3 + documentViews(surfaces).length,
      `the fixture must show three image region views and two document views, found ${JSON.stringify(shown)}`);
    const { mainPages, tabs: tabViews, sections: sectionViews, count: expectedAppDom } =
      appDomWebviews(surfaces, { mainPage: window.pageProcess !== null });
    assert.equal(window.webviews.filter((webview) => webview.main).length, mainPages,
      `the window must have ${mainPages} main page web views`);
    assert.equal(window.appDomWebviews, expectedAppDom,
      `expected ${mainPages} main page, ${tabViews.length} tab views (${tabViews.map((item) => `${item.surface} ${item.plugin}` +
        `${item.visible ? "" : " retained"}`).join(", ")}) and ${sectionViews.length} section views ` +
      `(${expectedAppDom} app DOM webviews), measured ${window.appDomWebviews}`);
    // Each loaded layout probe view, shown or retained, holds one document region, which has its own native WebView.
    const documents = tabViews.filter((item) => item.plugin === START_PLUGIN).length;
    assert.equal(window.documentWebviews, documents, "each document region must have an independent native WebView");
    const processes = rasterServiceSnapshot(app.configDir);
    const sessions = await Promise.all(rasters.map(async ({ surface }) => [surface, await s.get("rasterprobe.session", surface)]));
    assert.equal(processes.children.length, 3,
      `three independent sessions must own three child processes, found ${JSON.stringify(processes)}; sessions ${JSON.stringify(sessions)}`);
    assert.equal(new Set(sessions.map(([, state]) => state.session)).size, 3, "image regions must not share a sidecar session");
    assert.deepEqual(sessions.map(([, state]) => state.child).sort((a, b) => a - b), processes.children,
      "the sessions must own the child processes of the service");
    for (const [surface, state] of sessions) {
      assert.equal(state.service.pid, processes.service, `the session of ${surface} does not belong to the one service`);
    }
    const project = await s.get("core.project");
    for (let round = 0; round < 3; round++) {
      await s.run("core.projects.browse");
      await s.run("core.library.open", { id: project.id });
      const returned = await s.get("host.window");
      assert.equal(returned.appDomWebviews, expectedAppDom,
        `return ${round} changed the app DOM webviews: expected ${expectedAppDom}, measured ${returned.appDomWebviews}`);
      assert.equal(returned.documentWebviews, documents, `return ${round} duplicated or lost a document region`);
      assert.deepEqual(rasterServiceSnapshot(app.configDir), processes,
        `return ${round} changed the service or session processes`);
      for (const [surface, state] of sessions) {
        assert.equal((await s.get("rasterprobe.session", surface)).session, state.session,
          `return ${round} replaced the sidecar session of ${surface}`);
        const region = regionOf(returned, surface);
        assert.ok(region?.visible && region.presented,
          `return ${round} failed to immediately restore image region ${surface}`);
      }
    }
  });

  test(`${app.name}: closing image region tabs reaps every session child without killing the shared service`, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    const rasters = await ensureRasters(s, 3);
    assert.equal(rasters.length, 3, "the close test requires three sidecar sessions");
    await s.presented();

    const before = rasterServiceSnapshot(app.configDir);
    assert.equal(before.children.length, 3, "three open sidecar sessions must own three child processes");

    await closeRasterTabs(s);
    // Layout settlement does not await project persistence. Flush awaits tab
    // cleanup and the persistent service's authoritative retain response.
    await s.run("core.projects.flush");
    await s.until(
      "core.surfaces",
      (current) => current.every((surface) => surface.plugin !== RASTER),
      "raster probe surfaces did not close",
    );
    const after = rasterServiceSnapshot(app.configDir);
    assert.equal(after.service, before.service, "closing tabs must not recreate the shared sidecar service");
    assert.deepEqual(after.children, [], "completed layout retention must reap every session child");
  });

  test(`${app.name}: removing a project ends the sidecar sessions that its layout held`, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    const [raster] = await ensureRasters(s, 1);
    await sessionOf(s, raster.surface);
    const held = rasterServiceSnapshot(app.configDir).children;
    assert.ok(held.length > 0, "the first project has no session child process");

    // Opening another project in the same window keeps the sessions of the first project.
    s.cleanup(() => s.run("core.settings.set", { patch: { projectOpening: "windows" }, scope: "common" }));
    await s.run("core.settings.set", { patch: { projectOpening: "tabs" }, scope: "common" });
    const other = mkdtempSync(join(tmpdir(), "soksak-retain-"));
    s.cleanup(() => rmSync(other, { recursive: true, force: true }));
    await s.run("core.project.open", { root: other, color: "#7fe3b0" });
    await s.until("core.project", (project) => project?.root === realpathSync(other), "the second project did not open in the window");
    const preserved = rasterServiceSnapshot(app.configDir).children;
    assert.ok(held.every((pid) => preserved.includes(pid)), `opening another project ended the first project's sessions: ${held} -> ${preserved}`);

    // The fixture deletes both projects. A tab of a deleted layout has nowhere to attach again, so its session ends.
    await s.request("diagnostics.fixture");
    const after = rasterServiceSnapshot(app.configDir).children;
    const left = held.filter((pid) => after.includes(pid));
    assert.deepEqual(left, [], `the removed project's session children remain: ${left} (before ${held}, after ${after})`);
  });

  test(`${app.name}: a click gives native focus to the clicked image region and its card`, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    const rasters = await ensureRasters(s, 3);
    await s.presented();
    // The focus of the pressed card and the native keyboard focus must point to the same image region (V5-46).
    for (const raster of [...rasters, rasters[0]]) {
      const current = (await s.get("core.surfaces")).find((item) => item.surface === raster.surface);
      assert.ok(current?.visible && current.applied, `${raster.surface} has no applied native frame`);
      const { x, y, w, h } = current.applied;
      await s.click(x + w / 2, y + h / 2);
      await s.until("core.grid", (grid) => grid.cards.some((card) => card.focused &&
        card.tabs.some((tab) => tab.id === raster.surface)), `the card of ${raster.surface} did not take focus`);
      const host = await s.until("host.window", (window) => window.responder?.surface === raster.surface,
        `${raster.surface} did not become the native first responder after its click`);
      assert.deepEqual(host.regions.filter((region) => region.focused).map((region) => region.surface), [raster.surface]);
    }
  });

  test(`${app.name}: a long tab title is cut at the width bound of a tab`, async (t) => {
    const s = await open(t, app);
    const { surface } = await fresh(s);
    const title = "LONG-TITLE-".repeat(20);
    const tabs = (grid) => grid.cards.flatMap((card) => card.tabs);
    s.cleanup(() => s.run("layoutprobe.title", { text: null }, surface));
    await s.run("layoutprobe.title", { text: title }, surface);
    const grid = await s.until("core.grid", (value) => tabs(value).find((tab) => tab.id === surface)?.label === title,
      "the tab did not show the long title that its view reported");
    // The tabs of every card are in document order, which is the order of the cards and of their tabs in core.grid.
    const rect = await s.rect("core.card.tab", tabs(grid).findIndex((tab) => tab.id === surface));
    assert.ok(rect.width <= 200, `the tab with a title of ${title.length} characters is ${rect.width} points wide, more than 200`);
  });

  test(`${app.name}: a notification from a view out of view becomes a tab notice until the tab is in view`, async (t) => {
    const s = await open(t, app);
    const { shown, hidden, cardOf, notice } = await twoNoticeViews(s);
    // No notification is kept for a visible tab (the active tab of the focused card).
    await s.run("layoutprobe.notify", { text: "SHOWN-NOTICE" }, shown);
    await s.until("layoutprobe.view", (view) => view.notice?.text === "SHOWN-NOTICE",
      "the focused view did not report its notification", { surface: shown });
    assert.equal(notice(await s.get("core.grid"), shown), null, "the tab in view received a notice");
    await s.run("layoutprobe.notify", { text: "NOTICE-CHECK" }, hidden);
    await s.until("core.grid", (grid) => notice(grid, hidden) === "NOTICE-CHECK",
      "the view out of view did not show a tab notice");
    await s.run("core.card.focus", { card: cardOf(await s.get("core.grid"), hidden).id });
    await s.until("core.grid", (grid) => notice(grid, hidden) === null,
      "the notice stayed after the tab came into view");
  });

  test(`${app.name}: a notification from a view out of view follows the system policy and then the tab policy`, async (t) => {
    const s = await open(t, app);
    const { hidden, cardOf, notice } = await twoNoticeViews(s);
    await s.run("layoutprobe.notify", { text: "SYSTEM-POLICY", policy: "system" }, hidden);
    await s.until("layoutprobe.view", (view) => view.notice?.text === "SYSTEM-POLICY",
      "the system notification policy did not reach the view", { surface: hidden });
    // The result of the system policy is one of: posted, native error, or denied permission. A denial is reported only through the permission state, without a post or an error
    // (V5-111). The notification permission of the application bundle is set only when the user answers the system question.
    const decided = (state) => state.posted.includes(hidden) || state.error !== null || state.authorization === "denied";
    try {
      await s.until("core.notifications", decided,
        "the system notification policy produced neither a post, a native error, nor a denied authorization");
    } catch (error) {
      const state = await s.get("core.notifications");
      if (state.authorization === "notDetermined") {
        throw new Error(`${app.name}: the notification authorization of this application is not decided; answer its system notification prompt once (${error.message})`, { cause: error });
      }
      throw error;
    }
    assert.equal(notice(await s.get("core.grid"), hidden), null, "the system notification policy fell back to a tab notice");
    const posted = (await s.get("core.notifications")).posted.length;
    await s.run("layoutprobe.notify", { text: "TAB-NOTICE", policy: "tab" }, hidden);
    await s.until("core.grid", (grid) => notice(grid, hidden) === "TAB-NOTICE",
      "the view out of view did not show a tab notice");
    assert.equal((await s.get("core.notifications")).posted.length, posted, "the tab policy posted a system notification");
    await s.run("core.card.focus", { card: cardOf(await s.get("core.grid"), hidden).id });
    await s.until("core.grid", (grid) => notice(grid, hidden) === null,
      "the tab notice stayed after the tab came into view");
  });

  test(`${app.name}: a split while the sidecar service is stopped waits for its raster and leaves the next fixture and splits usable`, async (t) => {
    const s = await open(t, app);
    // The trace records each raster that the host hands a sidecar, which tells when the split waits for the stopped service.
    await fresh(s, { performanceTrace: true });
    s.cleanup(() => closeRasterTabs(s));
    const [raster] = await ensureRasters(s, 1);
    await s.presented();
    const shown = regionOf(await s.get("host.window"), raster.surface);
    assert.ok(shown?.presented, `${raster.surface} presented no raster before the split: ${JSON.stringify(shown)}`);
    const { service } = rasterServiceSnapshot(app.configDir);
    process.kill(service, "SIGSTOP");
    let stopped = true;
    s.cleanup(() => { if (stopped) process.kill(service, "SIGCONT"); });
    const card = (await s.get("core.grid")).cards.find((item) => item.active === raster.surface);
    const offsets = currentEventOffsets(app.configDir);
    // The split halves the card of the image region, so its presentation waits for a raster of the new size, which the stopped
    // service does not draw. No limit ends that wait: the presentation of the raster, the end of the connection of the service or a
    // press or key event of the user ends it (docs/spec/native-surfaces.md#layout-transaction).
    const split = s.run("core.card.split", { card: card.id, side: "right", plugin: RASTER });
    const settled = split.then(() => "answered", () => "failed");
    // Once the host has handed the raster of the new size to the stopped service, the split cannot answer before that raster
    // presents, so the check then looks once without blocking.
    await untilFolderState(join(app.configDir, "logs"), () => traceRows(readEvents(app.configDir, offsets).events).find((row) =>
      row.layer === "host" && row.event === "image.raster" && row.phase === "sent" && row.surface === raster.surface &&
      row.width !== shown.presented.width), { signal: endSignal(s.client.ended) });
    assert.equal(await Promise.race([settled, Promise.resolve("waiting")]), "waiting",
      "the split answered while the stopped service drew no raster of the new size");
    process.kill(service, "SIGCONT");
    stopped = false;
    const { tab } = await split;
    await s.until("host.window", (value) => {
      const region = regionOf(value, raster.surface);
      return region?.visible === true && region.presented !== null &&
        region.presented.width === Math.round(region.frame.width * region.presented.scale);
    }, `${raster.surface} did not present the raster of the split after the service continued`);
    // The new raster probe page places its region, or its surface reports an error.
    const placed = s.until("host.window", (value) => value.regions.some((region) => region.surface === tab),
      "the new raster probe did not place its region").then(() => null);
    const failure = s.until("core.surfaces", (surfaces) => surfaces.find((item) => item.surface === tab)?.status.phase === "error",
      "the new raster probe did not report an error").then((surfaces) => surfaces.find((item) => item.surface === tab).status.error);
    const error = await Promise.race([placed, failure]);
    assert.equal(error, null, "the new raster probe failed to place its region after the split waited for the stopped service");
    // Runs the cleanup of the check and the preparation of the next check in the same order.
    await closeRasterTabs(s);
    await fresh(s);
    const rasters = await ensureRasters(s, 3);
    for (const item of rasters) {
      await s.until("host.window", (value) => value.regions.some((region) => region.surface === item.surface &&
        region.visible && region.presented !== null && region.presented.width === Math.round(region.frame.width * region.presented.scale)),
        `${item.surface} did not present after the split that waited`);
    }
    const failed = (await s.get("core.surfaces")).filter((item) => item.status.phase === "error");
    assert.deepEqual(failed, [], "a surface reported an error after the split that waited");
  });

  test(`${app.name}: a view split from a view starts in the directory that view reported`, async (t) => {
    const s = await open(t, app);
    const { surface } = await fresh(s);
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "soksak-origin ")));
    s.cleanup(() => rmSync(directory, { recursive: true, force: true }));
    await s.run("layoutprobe.directory", { path: directory }, surface);
    await s.until("layoutprobe.view", (view) => view.reported === directory, `the view did not report ${directory}`, { surface });
    const card = (await s.get("core.grid")).cards.find((item) => item.active === surface);
    const made = await s.run("core.card.split", { card: card.id, side: "right", plugin: START_PLUGIN });
    s.cleanup(async () => {
      const grid = await s.get("core.grid");
      if (grid.cards.some((item) => item.tabs.some((tab) => tab.id === made.tab))) await s.run("core.tab.close", { tab: made.tab });
    });
    await s.until("core.surfaces", (surfaces) => surfaces.some((item) => item.surface === made.tab && item.visible &&
      item.exposes.includes("status layoutprobe.view")), "the split view did not register");
    const split = await s.until("layoutprobe.view", (view) => view.directory !== undefined,
      "the split view reported no start values", { surface: made.tab });
    assert.equal(split.origin?.directory, directory, `the split view did not receive ${directory} as its origin`);
    assert.equal(split.directory, directory, `the split view did not start in ${directory}`);
  });

  test(`${app.name}: a page start keeps the sidecar sessions that the layouts hold`, async (t) => {
    const s = await open(t, app);
    await fresh(s, { log: { call: "debug", lifecycle: "info" }, reads: ["workbench.start", "workbench.log.clock", "workbench.view.call",
      "workbench.view.reply", "workbench.view.call.cancel", "host.view.call", "host.view.reply.dispatch"] });
    const [raster] = await ensureRasters(s, 1);
    const surface = raster.surface;
    const before = await sessionOf(s, surface, "the raster probe session did not open");
    const children = rasterServiceSnapshot(app.configDir).children;

    const offsets = currentEventOffsets(s.app.configDir);
    const document = (await s.get("core.window.workbench")).start;
    await s.run("host.window.reload");
    const reloadedDocument = await s.until("core.window.workbench", (value) =>
      value.start !== document && value.readyState === "complete",
      "the workbench did not start again");
    const currentPage = reloadedDocument.start;
    await untilEventLine(s.app.configDir, offsets, (line) => {
      if (!line.startsWith("info workbench workbench.start: ")) return false;
      const fields = JSON.parse(line.slice(line.indexOf("{")));
      return fields.started_at === reloadedDocument.startedAt;
    }, { ...reading(s.app, ["workbench.start"]), ended: s.client.ended });
    await s.until("core.surfaces", (surfaces) => surfaces.some((item) =>
      item.surface === surface && item.exposes.includes("status rasterprobe.session")), "the raster probe did not return after the reload");
    const after = await sessionOf(s, surface, "the raster probe session did not return");
    let pageEvents = [];
    const accepted = await untilFolderState(join(s.app.configDir, "logs"), () => {
      const events = readEvents(s.app.configDir, offsets).events;
      const starts = events.filter((event) => event.layer === "workbench" && event.event === "workbench.start" &&
        event.start === currentPage && event.fields.started_at === reloadedDocument.startedAt);
      assert.equal(starts.length, 1,
        `the reloaded document ${currentPage} has no unique workbench.start record: ${JSON.stringify(events)}`);
      pageEvents = events.filter((event) => event.layer === "workbench" && event.start === currentPage &&
        ["workbench.view.call", "workbench.view.reply", "workbench.view.call.cancel"].includes(event.event));
      return acceptedCurrentViewReplies(events, { window: "main", page: currentPage, plugin: RASTER, surface })
        .find((reply) => reply.outcome === "result");
    }, { signal: endSignal(s.client.ended) });
    const { id, generation } = accepted;
    assert.equal(unansweredViewCalls(pageEvents).some((call) => call.plugin === RASTER &&
      call.surface === surface && call.id === id && call.generation === generation), false,
    `viewReply ${id} generation ${generation} remains unanswered`);

    assert.equal(after.session, before.session, "the page start replaced the sidecar session");
    assert.deepEqual(rasterServiceSnapshot(app.configDir).children, children, "the page start ended a session child that a layout holds");
    // The retained session continues: a new row count reaches the session and its next presented frame.
    const rows = (after.rows ?? 0) + 2;
    await s.run("rasterprobe.rows", { count: rows }, surface);
    await s.until("rasterprobe.session", (state) => state.rows === rows, "the retained session did not take the new row count", { surface });
    await presentedFrame(s, surface, (frame) => frame.rows === rows, `a frame of ${rows} rows from the retained session`);
    await s.flushLog();
    const sealed = readEvents(s.app.configDir, offsets);
    const nativeCalls = currentPageNativeViewCalls(sealed.events, { page: currentPage });
    assert.ok(nativeCalls.length > 0, "the replacement page produced no native view calls in the sealed measurement");
    t.diagnostic(`sealed ${nativeCalls.length} native view calls across ${Object.keys(sealed.offsets).length} event-log offsets`);
    let observed = [];
    const coverage = await untilFolderState(join(s.app.configDir, "logs"), () => {
      const events = readEvents(s.app.configDir, offsets).events;
      observed = events.filter((event) => event.layer === "workbench" && event.start === currentPage &&
        ["workbench.view.call", "workbench.view.reply", "workbench.view.call.cancel"].includes(event.event));
      return currentPageViewCallCoverage(events, { window: "main", page: currentPage, calls: nativeCalls });
    }, { signal: endSignal(s.client.ended) });
    assert.equal(coverage.length, nativeCalls.length,
      "the current page did not settle every native view call through the sealed offset");
    t.diagnostic(`all ${coverage.length} sealed calls settled on the replacement page`);
  });

  test(`${app.name}: hiding three image regions retains native geometry and rasters`, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    const rasters = await ensureRasters(s, 3);
    await s.presented();
    const before = await s.get("host.window");
    for (const raster of rasters) {
      const image = regionOf(before, raster.surface);
      assert.ok(image?.visible && image.presented && image.frame.width > 0 && image.frame.height > 0,
        `${raster.surface} must be displayed before hiding`);
    }
    await s.run("core.projects.browse");
    const after = await s.get("host.window");
    for (const raster of rasters) {
      const shown = regionOf(before, raster.surface);
      const hidden = regionOf(after, raster.surface);
      assert.ok(hidden && !hidden.visible, `${raster.surface} did not hide`);
      assert.deepEqual(hidden.frame, shown.frame, `hiding ${raster.surface} changed its native frame`);
      assert.deepEqual(rasterIdentity(hidden.presented), rasterIdentity(shown.presented), `hiding ${raster.surface} changed its raster`);
    }
  });

  test(`${app.name}: three image regions survive repeated divider drags and project returns`, async (t) => {
    const s = await open(t, app);
    // The placed rows from this point are the baseline of each drag set: the last placed row of a surface before a window is its
    // placement at the window start. The baseline starts before the fixture, so it holds the created and placed rows of every image region.
    const placementRowsFrom = currentEventOffsets(s.app.configDir);
    // The trace stays on: the check judges the presentation of every surface, and its records name the frame that a
    // surface did not present (docs/spec/performance-trace.md, F161.18).
    await fresh(s, { performanceTrace: true });
    const rasters = await ensureRasters(s, 3);
    const project = await s.get("core.project");
    const cards = (await s.get("core.grid")).cards.filter((card) =>
      rasters.some((raster) => raster.surface === card.active)).sort((a, b) => a.x - b.x);
    assert.equal(cards.length, 3, "the test requires three visible image region cards");
    for (const raster of rasters) await setMeasuredColor(s, raster.surface);
    await s.presented();
    // The card head row directly above the first image region, which surfaceBoxes finds above each box.
    const headY = (await rasterMarks(s, rasters[0].surface)).head;
    const checks = await s.collect("core.verify");
    s.cleanup(() => checks.stop());
    const returnSets = 3;
    const roundTripsPerSet = 5;
    for (let set = 0; set < returnSets; set++) {
      const roundLabel = `set ${set + 1}/${returnSets}, ${roundTripsPerSet} uninterrupted round trips`;
      const started = Date.now();
      t.diagnostic(`${app.name}: START ${roundLabel}`);
      // Each round trip ends by the events of its steps; the limit of the test runner bounds the set.
      await (async () => {
      await s.flushLog();
      const baselineRows = traceRows(readEvents(s.app.configDir, placementRowsFrom).events);
      const offsets = currentEventOffsets(s.app.configDir);
      const result = await drag(s, {
        axis: "x", line: cards[0].c1, dx: 500, dy: 0, ms: 96, times: roundTripsPerSet,
      }, { capture: true });
      const describe = (joins) => joins.map((entry) =>
        `${entry.surface} phases=${JSON.stringify(entry.phases)} abandoned=${JSON.stringify(entry.abandoned)}`).join("; ");
      const traceRowsNow = () => traceRows(readEvents(s.app.configDir, offsets).events);
      await s.flushLog();
      // Only an image region whose placement changed in this gesture joins its presentation wait (docs/spec/plugin-processes.md, rule 6);
      // an image region that stayed in place adds no join. Each awaited image region ends presented in this set; an abandoned wait fails
      // at once, and a missing presentation holds the set until the limit of the test
      // (docs/spec/native-surfaces.md#view-surfaces). The frames below measure the boxes of every image region either way.
      const awaited = expectedPresentations(baselineRows, traceRowsNow(), rasters.map((raster) => raster.surface));
      const joinsOf = (rows) => awaited.map((surface) => ({ surface, ...viewPresentationJoins(rows, surface) }));
      // untilFolderState re-reads the trace at each change of the logs folder and has no timer: a presentation, an abandoned wait or
      // the end of the connection ends it.
      const joins = await untilFolderState(join(s.app.configDir, "logs"), () => {
        const current = joinsOf(traceRowsNow());
        const ended = current.find((entry) => entry.abandoned.length > 0 || entry.phases.includes("abandoned"));
        if (ended) throw new Error(`set ${set}: ${ended.surface} presentation wait ended without presentation; ${describe(current)}`);
        return current.every((entry) => entry.phases.includes("presented")) ? current : undefined;
      }, { signal: endSignal(s.client.ended) });
      t.diagnostic(`${app.name}: set ${set + 1} awaited image regions ${awaited.length}, presentations ${joins.map((entry) =>
        entry.phases.filter((phase) => phase === "presented").length).join(",") || "none"}`);
      const edgeWidths = [];
      const times = [];
      // Every still of the drag is judged, so a still that the recording lost hides a moment of it.
      requireNoLostStills(readStills(result.stills), `set ${set} drag`);
      const positions = frames(result.frameDir).map((file, index) => {
        const frame = readFrame(file);
        times.push(frame.requested);
        let boxes;
        try {
          boxes = surfaceBoxes(frame, MEASURED, { expectedRow: headY }).sort((a, b) => a.card.l - b.card.l);
        } catch (error) {
          throw new Error(`set ${set}, frame ${index} could not measure image region boxes: ${file}: ${error.message}`, { cause: error });
        }
        const rasterBoxes = boxes.filter((box) =>
          Math.abs(box.row / frame.scale - headY) <= 5);
        assert.equal(rasterBoxes.length, 3,
          `set ${set}, frame ${index}: every image region must remain visible; ` +
          `headY=${headY}, rows=${boxes.map((box) => box.row / frame.scale).join(",")}, file=${file}`);
        for (const box of rasterBoxes) {
          assert.ok(box.l > box.card.l && box.r - 1 < box.card.r,
            `set ${set}, frame ${index}: image region crosses its DOM border`);
          assert.equal(whitePixels(frame, box), 0, `set ${set}, frame ${index}: image region has white pixels`);
        }
        const ordered = [...rasterBoxes].sort((a, b) => a.card.l - b.card.l);
        edgeWidths.push({
          left: (ordered[1].card.l - ordered[0].card.l) / frame.scale,
          right: (ordered[2].card.l - ordered[1].card.l) / frame.scale,
        });
        return ordered[1].card.l / frame.scale;
      });
      try {
        // Every placement that stayed long must appear in the recording. A position that stayed shorter than one display can be replaced.
        assertHeldStatesShown(positions.map((position, index) => ({ time: times[index], position })),
          result.ticks, result.boundary, readStills(result.stills));
      } catch (error) {
        throw new Error(`set ${set}: ${error.message}; frames ${times.length}, first frame ${times[0]}ms, ` +
          `last frame ${times.at(-1)}ms, last presentation ${result.displayed}ms, drag ${result.took}ms, ` +
          `late steps ${result.late}`, { cause: error });
      }
      const span = Math.max(...positions) - Math.min(...positions);
      assert.ok(span >= 50,
        `set ${set}: divider moved only ${span.toFixed(1)}pt; the drag did not move the layout`);
      assert.ok(edgeWidths.some(({ left, right }) => Math.min(left, right) <= 110),
        `set ${set}: no card beside the dragged divider reached the 96pt minimum card edge plus 12pt gap; ` +
        `edges=${JSON.stringify(edgeWidths)}`);
      const beforeHide = await s.get("host.window");
      for (const raster of rasters) {
        const state = await s.get("rasterprobe.session", raster.surface);
        assert.equal(state.error, null, `set ${set}, ${raster.surface}: ${state.error}`);
      }
      await s.run("core.projects.browse");
      const hidden = await s.get("host.window");
      assert.equal(hidden.regions.some((region) => region.visible), false,
        "the library must hide every native region");
      for (const raster of rasters) {
        const before = regionOf(beforeHide, raster.surface);
        const after = regionOf(hidden, raster.surface);
        assert.ok(after, `hiding ${raster.surface} must retain its native region`);
        assert.deepEqual(after.frame, before.frame, `hiding ${raster.surface} must not resize or move its native frame`);
        assert.deepEqual(rasterIdentity(after.presented), rasterIdentity(before.presented), `hiding ${raster.surface} must retain its raster`);
      }
      try {
        await s.run("core.library.open", { id: project.id });
      } catch (error) {
        throw new Error(`project return set ${set}: ${error.message}; ${JSON.stringify(await s.get("host.window"))}`,
          { cause: error });
      }
      // The surface module releases ready only after the host displays the current transaction.
      // Keeps that lifecycle boundary before reading native facts.
      const displayed = await s.presented();
      assert.equal(typeof displayed.displayed, "number", `project return set ${set} did not report a displayed frame`);
      const state = await s.get("host.window");
      for (const raster of rasters) {
        const image = regionOf(state, raster.surface);
        assert.ok(image?.visible && image.presented, `image region ${raster.surface} did not return in set ${set}`);
        assert.equal(image.error, null, `image region ${raster.surface} reported a native error`);
        assert.equal(image.presented.width, Math.round(image.frame.width * image.presented.scale));
        assert.equal(image.presented.height, Math.round(image.frame.height * image.presented.scale));
      }
      const failures = checks.values.filter((value) => value?.failed > 0);
      assert.deepEqual(failures, [], `project return set ${set} reported a composition failure`);
      })();
      t.diagnostic(`${app.name}: PASS ${roundLabel} (${Date.now() - started}ms)`);
    }
  });

  test(`${app.name}: an image region draws its frame after the window is resized from outside`, async (t) => {
    // A resize that the system makes, such as the tiling of a window, configures the image region again; the new raster shows the
    // frame with its identity marker, without input.
    const s = await open(t, app);
    await fresh(s);
    const [raster] = await ensureRasters(s, 1);
    const surface = raster.surface;
    s.cleanup(() => closeRasterTabs(s));
    await sessionOf(s, surface, "the raster probe session did not open");
    const measured = await setMeasuredColor(s, surface);
    const before = await s.get("host.window");
    s.cleanup(() => s.run("host.window.resize", { width: before.frame.width, height: before.frame.height }));
    await s.run("host.window.resize", { width: Math.round(before.frame.width * 0.6), height: Math.round(before.frame.height * 0.8) });
    await s.presented();
    const frame = await presentedFrame(s, surface, (value) => value.color === measured.color &&
      (value.grid.cols !== measured.grid.cols || value.grid.rows !== measured.grid.rows), "a frame of the resized region");
    const region = regionOf(await s.get("host.window"), surface);
    const captured = await lastFrame(s);
    // The identity marker is a square one cell tall at the bottom right of the raster.
    const side = frame.grid.cellHeight;
    const x = Math.round((region.frame.x + region.frame.width) * captured.scale - side / 2);
    const y = Math.round((region.frame.y + region.frame.height) * captured.scale - side / 2);
    const shown = pixel(captured, x, y);
    assert.ok(!shown.slice(0, 3).every((value, index) => Math.abs(value - MEASURED[index]) <= 8),
      `the marker cell at ${x},${y} shows only the background after the resize: ${JSON.stringify({ shown, marker: frame.marker })}`);
  });

  test(`${app.name}: an image region follows a window resize`, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    await assertGridFillsPlane(s, "initial image region resize layout");
    s.cleanup(() => closeRasterTabs(s));
    const [raster] = await ensureRasters(s, 1);
    const surface = raster.surface;
    await rasterReady(s, surface);
    await setMeasuredColor(s, surface);
    // Row bands in the contrast color of the frame place bright content on the raster.
    await s.run("rasterprobe.rows", { count: 3 }, surface);
    const before = await presentedFrame(s, surface, (frame) => frame.rows === 3, "a frame of three rows");

    await s.run("host.window.resize", { width: 800, height: 920 });
    await s.until("host.window", (w) => w.content.width === 800 && w.content.height > 0, "the window did not become narrow");
    await s.until("core.grid", (grid) =>
      grid !== null && Math.round(grid.width) === Math.round(grid.plane.w)
      && Math.round(grid.height) === Math.round(grid.plane.h),
      "the narrow window did not resize the DOM plane");
    const narrow = await presentedFrame(s, surface, (frame) => frame.grid.cols < before.grid.cols,
      `a narrower frame than ${JSON.stringify(before.grid)}`);

    // When widened again, the grid of the sidecar frame must grow with the region.
    await s.run("host.window.resize", { width: 1500, height: 920 });
    await s.until("host.window", (w) => w.content.width === 1500 && w.content.height > 0, "the window did not become wide");
    await s.until("core.grid", (grid) =>
      grid !== null && Math.round(grid.width) === Math.round(grid.plane.w)
      && Math.round(grid.height) === Math.round(grid.plane.h),
      "the wide window did not resize the DOM plane");
    await presentedFrame(s, surface, (frame) => frame.grid.cols > narrow.grid.cols && frame.grid.rows > before.grid.rows,
      `a frame that grew after the narrow resize: ${JSON.stringify(narrow.grid)}`);
    assert.equal((await s.get("rasterprobe.session", surface)).error, null, "the resize must not set a session error");
    await s.presented();

    // Measures numerically that the drawing covers the region inside the enlarged region.
    const region = regionOf(await s.get("host.window"), surface);
    assert.ok(region?.frame.width > 0 && region.frame.height > 0, "the image region frame is empty");
    const frame = await lastFrame(s);
    const COLOR_TOLERANCE = 10;
    const BRIGHT_THRESHOLD = 160;
    const BG_SAMPLE_RATIO_MIN = 0.5;
    // Window coordinates are points and the frame is in device pixels, so multiplies by the frame scale.
    const x0 = Math.round(region.frame.x * frame.scale);
    const y0 = Math.round(region.frame.y * frame.scale);
    const width = Math.round(region.frame.width * frame.scale);
    const height = Math.round(region.frame.height * frame.scale);
    let bgPixelCount = 0;
    let totalSampleCount = 0;
    let brightCount = 0;
    for (let y = y0; y < y0 + height; y += 2) {
      for (let x = x0; x < x0 + width; x += 2) {
        if (y < 0 || y >= frame.height || x < 0 || x >= frame.width) continue;
        const px = pixel(frame, x, y);
        totalSampleCount++;
        if (px.slice(0, 3).every((v, i) => Math.abs(v - MEASURED[i]) <= COLOR_TOLERANCE)) bgPixelCount++;
        if ((px[0] + px[1] + px[2]) / 3 >= BRIGHT_THRESHOLD) brightCount++;
      }
    }
    const bgRatio = totalSampleCount > 0 ? bgPixelCount / totalSampleCount : 0;
    assert.ok(bgRatio >= BG_SAMPLE_RATIO_MIN,
      `the image does not cover the resized region: ${(bgRatio * 100).toFixed(1)}% background over ${width}x${height} (need >= ${(BG_SAMPLE_RATIO_MIN * 100).toFixed(0)}%)`);
    assert.ok(brightCount >= 20, `the row bands are not visible after the resize: ${brightCount} bright pixels (need >= 20)`);
  });
}
