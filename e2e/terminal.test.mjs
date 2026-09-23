// 터미널 표면의 입력이 터미널 사이드카를 거쳐 같은 표면의 출력으로 돌아오는지 검사한다.
// 창 크기가 바뀌어도 터미널 그림이 영역과 DOM 을 따라가는지 검사한다.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { APPS, drag, failure, fresh, open, within } from "./app.mjs";
import { frames, pixel, readFrame } from "./frame.mjs";
import { glyphShape, surfaceBoxes, whitePixels } from "./outside.mjs";
import { assertRoundTrips } from "./drag-measurement.mjs";
import { terminalProcessSnapshot } from "./terminal-processes.mjs";
import { ensureTerminals, readScreenUntil, textLines } from "./terminal-screen.mjs";


async function clickAndExecute(session, surface, marker) {
  const view = await session.rect("terminal.view", undefined, surface);
  await session.click(view.document.x + view.x + view.width / 2, view.document.y + view.y + view.height / 2);
  await session.until("host.window", (host) => host.regions.some((region) =>
    region.surface === surface && region.focused), `${surface} did not receive native focus`);
  for (const ch of `echo ${marker}`) await session.press(ch === " " ? "Space" : ch);
  await session.press("Enter");
  await readScreenUntil(session, surface, (lines) => lines.includes(marker),
    `${surface} did not execute its first post-context command`);
}

async function closeTerminalTabs(session) {
  const grid = await session.get("core.grid");
  for (const tab of grid.cards.flatMap((card) => card.tabs).filter((tab) => tab.plugin === "terminal")) {
    await session.run("core.tab.close", { tab: tab.id });
  }
}

async function terminalBackgroundSample(session, rect) {
  await session.request("diagnostics.capture.start", {});
  const displayed = await session.presented();
  const { frames: frameDir } = await session.request("diagnostics.capture.stop", { after: displayed.displayed });
  const files = frames(frameDir);
  assert.ok(files.length > 0, "terminal theme capture produced no frames");
  const frame = readFrame(files.at(-1));
  const x = Math.round(rect.x + rect.width * 0.75);
  const y = Math.round(rect.y + rect.height * 0.75);
  const sample = pixel(frame, x, y);
  rmSync(frameDir, { recursive: true, force: true });
  return sample;
}

async function terminalCursorCell(session, surface) {
  await session.presented();
  await session.request("diagnostics.capture.start", {});
  const displayed = await session.presented();
  const { frames: frameDir } = await session.request("diagnostics.capture.stop", { after: displayed.displayed });
  const files = frames(frameDir);
  assert.ok(files.length > 0, "cursor policy capture produced no frames");
  const frame = readFrame(files.at(-1));
  const host = await session.get("host.window");
  const region = host.regions.find((item) => item.surface === surface && item.name === "view");
  assert.ok(region?.frame, `native terminal region ${surface} has no frame`);
  const cursor = await session.get("terminal.cursor", surface);
  const state = await session.get("terminal.session", surface);
  const x0 = Math.max(0, Math.round((region.frame.x + cursor.col * state.cellWidth) * frame.scale));
  const y0 = Math.max(0, Math.round((region.frame.y + cursor.row * state.cellHeight) * frame.scale));
  const x1 = Math.min(frame.width, x0 + Math.ceil(state.cellWidth * frame.scale));
  const y1 = Math.min(frame.height, y0 + Math.ceil(state.cellHeight * frame.scale));
  const pixels = [];
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) pixels.push(pixel(frame, x, y));
  const surfaceX = Math.max(0, Math.round(region.frame.x * frame.scale));
  const surfaceY = Math.max(0, Math.round(region.frame.y * frame.scale));
  const surfaceWidth = Math.min(frame.width - surfaceX, Math.ceil(region.frame.width * frame.scale));
  const surfaceHeight = Math.min(frame.height - surfaceY, Math.ceil(region.frame.height * frame.scale));
  const surfacePixels = [];
  for (let y = surfaceY; y < surfaceY + surfaceHeight; y++) {
    for (let x = surfaceX; x < surfaceX + surfaceWidth; x++) surfacePixels.push(pixel(frame, x, y));
  }
  rmSync(frameDir, { recursive: true, force: true });
  return { cell: pixels, surface: surfacePixels };
}

async function terminalFrame(session) {
  await session.request("diagnostics.capture.start", {});
  const displayed = await session.presented();
  const { frames: frameDir } = await session.request("diagnostics.capture.stop", { after: displayed.displayed });
  try {
    const files = frames(frameDir);
    assert.ok(files.length > 0, "terminal selection capture produced no frames");
    return readFrame(files.at(-1));
  } finally {
    rmSync(frameDir, { recursive: true, force: true });
  }
}

async function terminalColorBounds(session, surface, color) {
  const frame = await terminalFrame(session);
  const host = await session.get("host.window");
  const region = host.regions.find((item) => item.surface === surface && item.name === "view");
  assert.ok(region?.frame, `native terminal region ${surface} has no frame`);
  const scale = frame.scale;
  const x0 = Math.max(0, Math.round(region.frame.x * scale));
  const y0 = Math.max(0, Math.round(region.frame.y * scale));
  const x1 = Math.min(frame.width, Math.ceil((region.frame.x + region.frame.width) * scale));
  const y1 = Math.min(frame.height, Math.ceil((region.frame.y + region.frame.height) * scale));
  let count = 0;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const px = pixel(frame, x, y);
      const matches = color === "red"
        ? px[0] >= 180 && px[1] <= 80 && px[2] <= 80
        : px[0] <= 80 && px[1] <= 80 && px[2] >= 180;
      if (matches) {
        count++;
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
  }
  return { count, minY, maxY };
}

function differentPixels(before, after) {
  return before.reduce((count, value, index) => count +
    (value.some((channel, channelIndex) => channel !== after[index]?.[channelIndex]) ? 1 : 0), 0);
}

async function assertGridFillsPlane(session, message) {
  const grid = await session.get("core.grid");
  assert.ok(grid?.plane, `${message}: grid has no plane measurement`);
  assert.equal(Math.round(grid.width), Math.round(grid.plane.w),
    `${message}: grid width ${grid.width} does not fill plane width ${grid.plane.w}`);
  assert.equal(Math.round(grid.height), Math.round(grid.plane.h),
    `${message}: grid height ${grid.height} does not fill plane height ${grid.plane.h}`);
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: a newly split terminal presents its first native raster`, { timeout: 30000 }, async (t) => {
    const s = await open(t, app);
    assert.ok(s, `${app.binary} is not built`);
    await fresh(s);
    t.diagnostic(`${app.name}: START split-terminal presentation`);
    const terminals = await ensureTerminals(s, 2);
    for (const terminal of terminals) {
      await s.until("terminal.session", (state) => Boolean(state.sessionId),
        `${terminal.surface} did not open a sidecar session`, { surface: terminal.surface });
    }
    const host = await s.get("host.window");
    for (const terminal of terminals) {
      const region = host.regions.find((item) => item.surface === terminal.surface && item.name === "view");
      assert.ok(region?.visible && region.presented,
        `${terminal.surface} was not visible and presented after splitting: ${JSON.stringify(region)}`);
    }
    t.diagnostic(`${app.name}: PASS split-terminal presentation`);
  });

  test(`${app.name}: four split terminals complete native presentation without a host crash`, { timeout: 30000 }, async (t) => {
    const s = await open(t, app);
    assert.ok(s, `${app.binary} is not built`);
    await fresh(s);
    t.diagnostic(`${app.name}: START four-terminal presentation`);
    const terminals = await ensureTerminals(s, 4);
    for (const terminal of terminals) {
      await s.until("terminal.session", (state) => Boolean(state.sessionId),
        `${terminal.surface} did not open a sidecar session`, { surface: terminal.surface, timeout: 10000 });
    }
    const host = await s.get("host.window");
    const regions = host.regions.filter((region) => terminals.some((terminal) =>
      terminal.surface === region.surface && region.name === "view"));
    assert.equal(regions.length, 4, `four terminal native regions were not reported: ${JSON.stringify(regions)}`);
    assert.ok(regions.every((region) => region.visible && region.presented),
      `a four-terminal native region was not presented: ${JSON.stringify(regions)}`);
    t.diagnostic(`${app.name}: PASS four-terminal presentation`);
  });

  test(`${app.name}: endpoint split requests survive repeated native WebView presentation`, { timeout: 30000 }, async (t) => {
    const s = await open(t, app);
    assert.ok(s, `${app.binary} is not built`);
    await fresh(s);
    t.diagnostic(`${app.name}: START endpoint repeated split`);
    const terminals = await ensureTerminals(s, 3);
    assert.equal(terminals.length, 3, "the endpoint must report all three split terminals");
    for (const terminal of terminals) {
      const session = await s.until("terminal.session", (state) => state.sessionId,
        `${terminal.surface} did not retain its session after repeated split`, { surface: terminal.surface });
      assert.ok(session.sessionId, `${terminal.surface} lost its session after split`);
    }
    const host = await s.get("host.window");
    const regions = host.regions.filter((region) => terminals.some((terminal) =>
      terminal.surface === region.surface && region.name === "view"));
    assert.equal(regions.length, 3, `endpoint split lost a native region: ${JSON.stringify(host)}`);
    assert.ok(regions.every((region) => region.visible && region.presented),
      `endpoint split left an unpresented region: ${JSON.stringify(regions)}`);
    t.diagnostic(`${app.name}: PASS endpoint repeated split`);
  });

  test(`${app.name}: native presentation failure is explicit and the next split remains usable`, { timeout: 30000 }, async (t) => {
    const s = await open(t, app);
    assert.ok(s, `${app.binary} is not built`);
    await fresh(s);
    t.diagnostic(`${app.name}: START injected presentation failure`);
    await ensureTerminals(s, 1);
    await s.request("diagnostics.presentation.failure", {});
    await assert.rejects(
      () => s.presented(),
      (error) => /injected native presentation failure/.test(error.message),
      "an injected native presentation failure must not become a generic timeout",
    );
    const terminals = await ensureTerminals(s, 2);
    for (const terminal of terminals) {
      const region = (await s.get("host.window")).regions.find((item) =>
        item.surface === terminal.surface && item.name === "view");
      assert.ok(region?.visible && region.presented,
        `${terminal.surface} did not recover after the injected failure: ${JSON.stringify(region)}`);
    }
    t.diagnostic(`${app.name}: PASS injected presentation failure`);
  });

  test(`${app.name}: three terminals and two browsers share one app DOM and one terminal service`, async (t) => {
    const s = await open(t, app);
    assert.ok(s, `${app.binary} is not built`);
    await fresh(s);
    const initial = await s.get("core.grid");
    const tab = initial.cards.flatMap((card) => card.tabs).find((tab) => tab.plugin === "terminal");
    assert.ok(tab, "the fixture must contain a terminal tab");
    await s.run("core.tab.select", { tab: tab.id });
    const terminals = await ensureTerminals(s, 3);
    const browser = (await s.get("core.grid")).cards.find((card) =>
      card.tabs.find((tab) => tab.id === card.active)?.plugin === "browser");
    assert.ok(browser, "the fixture must contain a visible browser card");
    await s.run("core.card.split", { card: browser.id, axis: "x", plugin: "browser" });
    await s.until("core.surfaces", (surfaces) => surfaces.filter((item) =>
      item.visible && item.plugin === "browser").length === 2, "two browsers did not become visible");
    for (const terminal of terminals) {
      await s.until("terminal.session", (state) => Boolean(state.sessionId),
        `session ${terminal.surface} did not open`, { surface: terminal.surface });
    }
    await s.presented();
    const window = await s.get("host.window");
    assert.equal(window.appDomWebviews, 1, "all plugin DOM must share the window's single app WebView");
    assert.equal(window.documentWebviews, 2, "external browser documents must have independent native WebViews");
    const processes = terminalProcessSnapshot(app.configDir);
    assert.equal(processes.shells.length, 3, "three independent terminals must own three shells, not three daemons");
    const sessions = await Promise.all(terminals.map(async ({ surface }) =>
      [surface, (await s.get("terminal.session", surface)).sessionId]));
    assert.equal(new Set(sessions.map(([, id]) => id)).size, 3, "terminals must not share a PTY session");
    const project = await s.get("core.project");
    for (let round = 0; round < 3; round++) {
      await s.run("core.projects.browse");
      await s.run("core.library.open", { id: project.id });
      const returned = await s.get("host.window");
      assert.equal(returned.appDomWebviews, 1, `return ${round} created an extra app WebView`);
      assert.equal(returned.documentWebviews, 2, `return ${round} duplicated or lost a browser document`);
      assert.deepEqual(terminalProcessSnapshot(app.configDir), processes,
        `return ${round} changed the service or shell processes`);
      for (const [surface, sessionId] of sessions) {
        assert.equal((await s.get("terminal.session", surface)).sessionId, sessionId,
          `return ${round} replaced terminal session ${surface}`);
        const region = returned.regions.find((region) => region.surface === surface);
        assert.ok(region?.visible && region.presented,
          `return ${round} failed to immediately restore terminal ${surface}`);
      }
    }
  });

  test(`${app.name}: closing terminal tabs reaps every PTY child without killing the shared service`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const grid = await s.get("core.grid");
    const tab = grid.cards.flatMap((card) => card.tabs).find((item) => item.plugin === "terminal");
    assert.ok(tab, "the fixture must contain a terminal tab");
    await s.run("core.tab.select", { tab: tab.id });
    const terminals = await ensureTerminals(s, 3);
    assert.equal(terminals.length, 3, "the close test requires three terminal sessions");
    await s.presented();

    const before = terminalProcessSnapshot(app.configDir);
    assert.equal(before.shells.length, 3, "three open terminal sessions must own three PTY children");

    await closeTerminalTabs(s);
    await s.until(
      "core.surfaces",
      (surfaces) => surfaces.every((surface) => surface.plugin !== "terminal"),
      "terminal surfaces did not close",
    );
    const after = terminalProcessSnapshot(app.configDir);
    assert.equal(after.service, before.service, "closing tabs must not recreate the shared terminal service");
    assert.deepEqual(after.shells, [], "normal terminal close must reap every PTY child");
  });

  test(`${app.name}: native keyboard edits and executes independently in three terminals`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    assert.ok(s, `${app.binary} is not built`);
    await fresh(s);
    // 이 검사는 영문 명령을 네이티브 키로 입력한다.
    await s.selectInputSource("com.apple.keylayout.ABC");
    const tab = (await s.get("core.grid")).cards.flatMap((card) => card.tabs).find((tab) => tab.plugin === "terminal");
    assert.ok(tab, "the fixture has no terminal tab");
    await s.run("core.tab.select", { tab: tab.id });
    const terminals = await ensureTerminals(s, 3);
    assert.equal(terminals.length, 3);
    await s.presented();
    for (const [index, terminal] of terminals.entries()) {
      await t.test(`terminal ${index + 1}`, { timeout: 15000 }, async () => {
        const surface = terminal.surface;
        t.diagnostic(`${app.name}: START terminal ${index + 1} prompt`);
        await readScreenUntil(s, surface, (lines) => lines.some((line) => line.includes("$")), "shell prompt missing");
        t.diagnostic(`${app.name}: PASS terminal ${index + 1} prompt`);
        const others = await Promise.all(terminals.filter((item) => item.surface !== surface)
          .map(async (item) => [item.surface, await s.get("terminal.screen", item.surface)]));
        const view = await s.rect("terminal.view", undefined, surface);
        t.diagnostic(`${app.name}: START terminal ${index + 1} pointer focus`);
        try {
          await s.click(view.document.x + view.x + view.width / 2, view.document.y + view.y + view.height / 2);
        } catch (error) {
          t.diagnostic(`${app.name}: terminal ${index + 1} click failure host=${JSON.stringify(await s.get("host.window"))}`);
          t.diagnostic(`${app.name}: terminal ${index + 1} click failure input=${JSON.stringify(await s.get("core.surface.input", surface))}`);
          throw error;
        }
        t.diagnostic(`${app.name}: PASS terminal ${index + 1} pointer focus`);
        await s.until("host.window", (host) => host.regions.some((region) => region.surface === surface && region.focused),
          `terminal ${index + 1} did not receive keyboard focus`);
        t.diagnostic(`${app.name}: PASS terminal ${index + 1} native focus`);
        const marker = `typed${index}`;
        const line = `echo ${marker}`;
        for (const ch of `${line}x`) await s.press(ch === " " ? "Space" : ch);
        t.diagnostic(`${app.name}: PASS terminal ${index + 1} typed line`);
        const sessionAfterTyping = await s.get("terminal.session", surface);
        const screenAfterTyping = await s.get("terminal.screen", surface);
        assert.equal(sessionAfterTyping.error, undefined,
          `terminal ${index + 1} must not report a selection/input error after focus click: ${sessionAfterTyping.error}`);
        t.diagnostic(`${app.name}: terminal ${index + 1} session after typing ` +
          `${JSON.stringify({ sessionId: sessionAfterTyping.sessionId, error: sessionAfterTyping.error })}`);
        t.diagnostic(`${app.name}: terminal ${index + 1} screen after typing ` +
          `${JSON.stringify(textLines({ lines: screenAfterTyping }).filter(Boolean))}`);
        await readScreenUntil(s, surface, (lines) => lines.some((row) => row.endsWith(`${line}x`)), "native characters were not delivered");
        const focusedAfterFirstInput = await s.get("host.window");
        assert.ok(focusedAfterFirstInput.regions.some((region) => region.surface === surface && region.focused),
          `terminal ${index + 1} lost native focus before its first command completed`);
        await s.press("Backspace");
        await readScreenUntil(s, surface, (lines) => lines.some((row) => row.endsWith(line)), "native Backspace was not delivered");
        await s.press("u", { modifiers: ["control"] });
        await readScreenUntil(s, surface, (lines) => lines.some((row) => row.endsWith("$")) && !lines.some((row) => row.includes(marker)),
          "native Ctrl+U did not clear the input line");
        t.diagnostic(`${app.name}: PASS terminal ${index + 1} editing`);
        for (const ch of line) await s.press(ch === " " ? "Space" : ch);
        await s.press("Enter");
        const output = await readScreenUntil(s, surface, (lines) => lines.includes(marker), "native Enter did not execute the command");
        assert.equal(output.filter((row) => row === marker).length, 1, "command output must occur once");
        t.diagnostic(`${app.name}: PASS terminal ${index + 1} command`);
        const continued = `continued${index}`;
        for (const ch of `echo ${continued}`) await s.press(ch === " " ? "Space" : ch);
        await s.press("Enter");
        const next = await readScreenUntil(s, surface, (lines) => lines.includes(continued),
          "typing after output required another click");
        assert.equal(next.filter((row) => row === continued).length, 1, "continued input must execute once without refocusing");
        t.diagnostic(`${app.name}: PASS terminal ${index + 1} continued input`);
        for (const [other, before] of others) assert.deepEqual(await s.get("terminal.screen", other), before,
          `typing in ${surface} changed ${other}`);
      });
    }

    const terminalTab = (await s.get("core.grid")).cards.flatMap((card) => card.tabs)
      .find((tab) => tab.plugin === "terminal");
    const browserTab = (await s.get("core.grid")).cards.flatMap((card) => card.tabs)
      .find((tab) => tab.plugin === "browser");
    assert.ok(terminalTab && browserTab, "the focus context test requires terminal and browser tabs");
    t.diagnostic(`${app.name}: START focus after browser tab`);
    await s.run("core.tab.select", { tab: browserTab.id });
    await s.until("core.surfaces", (surfaces) => surfaces.some((item) => item.visible && item.plugin === "browser"),
      "browser tab did not become visible before returning to the terminal");
    await s.run("core.tab.select", { tab: terminalTab.id });
    await s.until("core.surfaces", (surfaces) => surfaces.some((item) =>
      item.visible && item.plugin === "terminal" && item.exposes.includes("status terminal.session")),
    "terminal did not return after browser tab switching");
    await s.presented();
    const returnedTerminal = (await s.get("core.surfaces")).find((item) =>
      item.visible && item.plugin === "terminal" && item.exposes.includes("status terminal.session"));
    await clickAndExecute(s, returnedTerminal.surface, "afterbrowser");
    t.diagnostic(`${app.name}: PASS focus after browser tab`);

    t.diagnostic(`${app.name}: START focus after resize`);
    const beforeResize = await s.get("terminal.session", returnedTerminal.surface);
    await s.run("host.window.resize", { width: 800, height: 920 });
    await s.until("host.window", (host) => host.content.width === 800, "window did not resize for focus test");
    await s.until("terminal.session", (state) => state.cols < beforeResize.cols,
      "terminal did not resize before focus was tested again", { surface: returnedTerminal.surface });
    await clickAndExecute(s, returnedTerminal.surface, "afterresize");
    t.diagnostic(`${app.name}: PASS focus after resize`);

    t.diagnostic(`${app.name}: START focus after modal close`);
    await s.run("core.settings.open");
    await s.until("core.settings-modal", (modal) => modal.open, "settings modal did not open for focus test");
    await s.run("core.settings.close");
    await s.until("core.settings-modal", (modal) => !modal.open, "settings modal did not close for focus test");
    await s.presented();
    await clickAndExecute(s, returnedTerminal.surface, "aftermodal");
    t.diagnostic(`${app.name}: PASS focus after modal close`);

    t.diagnostic(`${app.name}: START focus after project return`);
    const project = await s.get("core.project");
    await s.run("core.projects.browse");
    await s.until("core.screen", (screen) => screen.screen === "library", "project library did not open for focus test");
    await s.run("core.library.open", { id: project.id });
    await s.until("core.surfaces", (surfaces) => surfaces.some((item) =>
      item.visible && item.plugin === "terminal" && item.exposes.includes("status terminal.session")),
    "terminal did not return after project navigation");
    await s.presented();
    const restoredTerminal = (await s.get("core.surfaces")).find((item) =>
      item.visible && item.plugin === "terminal" && item.exposes.includes("status terminal.session"));
    await clickAndExecute(s, restoredTerminal.surface, "afterproject");
    t.diagnostic(`${app.name}: PASS focus after project return`);

    t.diagnostic(`${app.name}: START focus after window switch`);
    const temporaryProject = mkdtempSync(join(tmpdir(), "soksak-terminal-focus-"));
    s.cleanup(() => rmSync(temporaryProject, { recursive: true, force: true }));
    await s.run("core.settings.set", { patch: { projectOpening: "windows" }, scope: "common" });
    const opened = await s.run("core.project.open", { root: temporaryProject, color: "#7fe3b0" });
    const child = s.on((await s.windows(2, "focus test project window did not open"))
      .find((window) => window.window !== s.window).window);
    await child.until("core.grid", (grid) => grid.cards.length > 0, "focus test project window did not render");
    const childTerminalTab = (await child.get("core.grid")).cards.flatMap((card) => card.tabs)
      .find((tab) => tab.plugin === "terminal");
    assert.ok(childTerminalTab, `opened project ${opened.id} has no terminal tab`);
    await child.run("core.tab.select", { tab: childTerminalTab.id });
    await child.until("core.surfaces", (surfaces) => surfaces.some((item) =>
      item.visible && item.plugin === "terminal" && item.exposes.includes("status terminal.session")),
    "focus test child window terminal did not become visible");
    await child.presented();
    const childTerminal = (await child.get("core.surfaces")).find((item) =>
      item.visible && item.plugin === "terminal" && item.exposes.includes("status terminal.session"));
    await clickAndExecute(child, childTerminal.surface, "afterwindow");
    await child.close();
    await s.windows(1, "focus test child window did not close");
    t.diagnostic(`${app.name}: PASS focus after window switch`);
  });

  test(`${app.name}: hiding three terminals retains native geometry and rasters`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const tab = (await s.get("core.grid")).cards.flatMap((card) => card.tabs).find((tab) => tab.plugin === "terminal");
    assert.ok(tab, "the fixture has no terminal tab");
    await s.run("core.tab.select", { tab: tab.id });
    const terminals = await ensureTerminals(s, 3);
    await s.presented();
    const before = await s.get("host.window");
    for (const terminal of terminals) {
      const image = before.regions.find((region) => region.surface === terminal.surface);
      assert.ok(image?.visible && image.presented && image.frame.width > 0 && image.frame.height > 0,
        `${terminal.surface} must be displayed before hiding`);
    }
    await s.run("core.projects.browse");
    const after = await s.get("host.window");
    for (const terminal of terminals) {
      const shown = before.regions.find((region) => region.surface === terminal.surface);
      const hidden = after.regions.find((region) => region.surface === terminal.surface);
      assert.ok(hidden && !hidden.visible, `${terminal.surface} did not hide`);
      assert.deepEqual(hidden.frame, shown.frame, `hiding ${terminal.surface} changed its native frame`);
      assert.deepEqual(hidden.presented, shown.presented, `hiding ${terminal.surface} changed its raster`);
    }
  });

  test(`${app.name}: three terminals survive repeated divider drags and project returns`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const grid = await s.get("core.grid");
    const tab = grid.cards.flatMap((card) => card.tabs).find((tab) => tab.plugin === "terminal");
    assert.ok(tab, "the fixture has no terminal tab");
    await s.run("core.tab.select", { tab: tab.id });
    const terminals = await ensureTerminals(s, 3);
    const project = await s.get("core.project");
    const cards = (await s.get("core.grid")).cards.filter((card) =>
      terminals.some((terminal) => terminal.surface === card.active)).sort((a, b) => a.x - b.x);
    assert.equal(cards.length, 3, "the test requires three visible terminal cards");
    for (const terminal of terminals) {
      await readScreenUntil(s, terminal.surface,
        (lines) => lines.some((line) => line.includes("$")),
        `${terminal.surface} must show a shell prompt before divider capture`);
    }
    await s.presented();
    const terminalY = (await s.rect("terminal.view", undefined, terminals[0].surface)).y;
    const checks = await s.collect("core.verify");
    s.cleanup(() => checks.stop());
    const returnSets = 3;
    const roundTripsPerSet = 5;
    const roundTimeout = 60000;
    for (let set = 0; set < returnSets; set++) {
      const roundLabel = `set ${set + 1}/${returnSets}, ${roundTripsPerSet} uninterrupted round trips`;
      const started = Date.now();
      t.diagnostic(`${app.name}: START ${roundLabel}`);
      await within((async () => {
      const result = await drag(t, s, {
        axis: "x", line: cards[0].c1, dx: 500, dy: 0, ms: 96, times: roundTripsPerSet,
      }, { capture: true });
      const edgeWidths = [];
      const times = [];
      const positions = frames(result.frameDir).map((file, index) => {
        const frame = readFrame(file);
        times.push(frame.time);
        let boxes;
        try {
          boxes = surfaceBoxes(frame, [30, 30, 30], { expectedRow: terminalY }).sort((a, b) => a.card.l - b.card.l);
        } catch (error) {
          throw new Error(`set ${set}, frame ${index} could not measure terminal boxes: ${file}`, { cause: error });
        }
        const terminalBoxes = boxes.filter((box) =>
          Math.abs(box.row / frame.scale - terminalY) <= 5);
        assert.equal(terminalBoxes.length, 3,
          `set ${set}, frame ${index}: every terminal must remain visible; ` +
          `terminalY=${terminalY}, rows=${boxes.map((box) => box.row / frame.scale).join(",")}, file=${file}`);
        for (const box of terminalBoxes) {
          assert.ok(box.l > box.card.l && box.r - 1 < box.card.r,
            `set ${set}, frame ${index}: terminal crosses its DOM border`);
          assert.equal(whitePixels(frame, box), 0, `set ${set}, frame ${index}: terminal has white pixels`);
        }
        const ordered = [...terminalBoxes].sort((a, b) => a.card.l - b.card.l);
        edgeWidths.push({
          left: (ordered[1].card.l - ordered[0].card.l) / frame.scale,
          right: (ordered[2].card.l - ordered[1].card.l) / frame.scale,
        });
        return ordered[1].card.l / frame.scale;
      });
      try {
        assertRoundTrips(positions, roundTripsPerSet);
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
      if (!process.env.SOKSAK_KEEP_FAILURE_CAPTURE) rmSync(result.frameDir, { recursive: true, force: true });
      const beforeHide = await s.get("host.window");
      for (const terminal of terminals) {
        const state = await s.get("terminal.session", terminal.surface);
        assert.equal(state.error, undefined, `set ${set}, ${terminal.surface}: ${state.error}`);
      }
      await s.run("core.projects.browse");
      const hidden = await s.get("host.window");
      assert.equal(hidden.regions.some((region) => region.visible), false,
        "the library must hide every native region");
      for (const terminal of terminals) {
        const before = beforeHide.regions.find((region) => region.surface === terminal.surface);
        const after = hidden.regions.find((region) => region.surface === terminal.surface);
        assert.ok(after, `hiding ${terminal.surface} must retain its native region`);
        assert.deepEqual(after.frame, before.frame, `hiding ${terminal.surface} must not resize or move its native frame`);
        assert.deepEqual(after.presented, before.presented, `hiding ${terminal.surface} must retain its raster`);
      }
      try {
        await s.run("core.library.open", { id: project.id });
      } catch (error) {
        throw new Error(`project return set ${set}: ${error.message}; ${JSON.stringify(await s.get("host.window"))}`,
          { cause: error });
      }
      // Surface modules release ready only after the host has presented the current
      // transaction. Preserve that lifecycle boundary before reading native facts.
      const displayed = await s.presented();
      assert.equal(typeof displayed.displayed, "number", `project return set ${set} did not report a displayed frame`);
      const state = await s.get("host.window");
      for (const terminal of terminals) {
        const image = state.regions.find((region) => region.surface === terminal.surface);
        assert.ok(image?.visible && image.presented, `terminal ${terminal.surface} did not return in set ${set}`);
        assert.equal(image.error, null, `terminal ${terminal.surface} reported a native error`);
        assert.equal(image.presented.width, Math.round(image.frame.width * image.presented.scale));
        assert.equal(image.presented.height, Math.round(image.frame.height * image.presented.scale));
      }
      const failures = checks.values.filter((value) => value?.failed > 0);
      assert.deepEqual(failures, [], `project return set ${set} reported a composition failure`);
      })(), roundTimeout, `${app.name}: ${roundLabel}`);
      t.diagnostic(`${app.name}: PASS ${roundLabel} (${Date.now() - started}ms)`);
    }
  });

  test(`${app.name}: terminal input returns terminal output through the terminal sidecar`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    await assertGridFillsPlane(s, "initial terminal layout");

    // 터미널 탭을 활성화한다. core.grid 는 상태이므로 상태 읽기로 카드와 탭을 얻는다.
    const grid = await s.get("core.grid");
    const card = grid.cards.find((c) => c.tabs.some((tab) => tab.plugin === "terminal"));
    if (!card) return t.skip("terminal tab not found");
    const terminalTab = card.tabs.find((tab) => tab.plugin === "terminal");

    // 터미널 탭을 선택하는 명령을 실행한다.
    await s.run("core.tab.select", { tab: terminalTab.id });

    // 터미널 세션이 준비될 때까지 기다린다.
    let terminalSurface;
    await s.until(
      "core.surfaces",
      (surfaces) => {
        const terminal = surfaces.find(
          (surf) => surf.visible && surf.plugin === "terminal" &&
            surf.exposes.includes("status terminal.session")
        );
        if (!terminal) return false;
        terminalSurface = terminal.surface;
        return true;
      },
      "terminal surface did not become visible"
    );

    // 터미널 sessionId 가 생길 때까지 기다린다.
    await s.until(
      "terminal.session",
      (session) => session && session.sessionId,
      "terminal session did not report sessionId",
      { surface: terminalSurface }
    );

    // 명령을 보낸다.
    await s.run("terminal.input", { bytes: "echo hi\r" }, terminalSurface);

    // 출력 줄을 읽을 때까지 기다린다.
    // 화면이 읽혔는지 확인한다.
    const screenLines = await readScreenUntil(
      s,
      terminalSurface,
      (screen) => screen.some((line) => line.trim() === "hi"),
      'terminal output does not contain "hi"'
    );

    // 창 캡처로 터미널 영역에 글자가 나왔는지 확인한다.
    const terminalRect = await s.rect("terminal.view", undefined, terminalSurface);
    const capture = await s.request("diagnostics.capture.start", {});

    // 캡처를 즉시 중지하되, 마지막 표시 시각까지의 프레임을 기록한다.
    const { frames: frameDir } = await s.request("diagnostics.capture.stop", {
      after: (await s.presented()).displayed,
    });

    s.cleanup(async () => {
      await closeTerminalTabs(s);
      try {
        rmSync(frameDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    });

    const frameFiles = frames(frameDir);
    assert.ok(frameFiles.length > 0, "no frames were captured");

    // 마지막 프레임을 읽는다.
    const lastFramePath = frameFiles[frameFiles.length - 1];
    const frame = readFrame(lastFramePath);

    // 터미널 영역 내에서 네이티브 IOSurface 가 덮고 있고 글자가 나왔는지 확인한다.
    const BG_COLOR = [30, 30, 30];
    const COLOR_TOLERANCE = 10;
    const BRIGHT_TEXT_THRESHOLD = 160;
    const BRIGHT_TEXT_MIN = 20;
    const BG_SAMPLE_RATIO_MIN = 0.5;

    const termX = Math.round(terminalRect.x);
    const termY = Math.round(terminalRect.y);
    const termWidth = Math.round(terminalRect.width);
    const termHeight = Math.round(terminalRect.height);

    let bgPixelCount = 0;
    let totalSampleCount = 0;
    let brightTextCount = 0;

    // 두 픽셀마다 하나씩 표본 추출하여 배경 비율과 밝은 픽셀 개수를 센다.
    for (let y = termY; y < termY + termHeight; y += 2) {
      for (let x = termX; x < termX + termWidth; x += 2) {
        if (y < 0 || y >= frame.height || x < 0 || x >= frame.width) continue;
        const px = pixel(frame, x, y);
        totalSampleCount++;

        // (a) 배경색 픽셀 개수
        const isBG = px.every((v, i) => Math.abs(v - BG_COLOR[i]) <= COLOR_TOLERANCE);
        if (isBG) bgPixelCount++;

        // (b) 밝은 픽셀 개수
        const brightness = (px[0] + px[1] + px[2]) / 3;
        if (brightness >= BRIGHT_TEXT_THRESHOLD) brightTextCount++;
      }
    }

    const bgRatio = totalSampleCount > 0 ? bgPixelCount / totalSampleCount : 0;
    assert.ok(
      bgRatio >= BG_SAMPLE_RATIO_MIN,
      `terminal IOSurface not detected: ${(bgRatio * 100).toFixed(1)}% background (need >= ${(BG_SAMPLE_RATIO_MIN * 100).toFixed(0)}%)`
    );
    assert.ok(
      brightTextCount >= BRIGHT_TEXT_MIN,
      `terminal text not visible: ${brightTextCount} bright pixels (need >= ${BRIGHT_TEXT_MIN})`
    );
  });

  test(`${app.name}: inline image pixels follow scroll, resize, replacement, deletion, and cleanup`, { timeout: 30000 }, async (t) => {
    const s = await open(t, app);
    assert.ok(s, `${app.binary} is not built`);
    await fresh(s);
    const [terminal] = await ensureTerminals(s, 1);
    const surface = terminal.surface;
    s.cleanup(() => closeTerminalTabs(s));
    await s.until("terminal.session", (state) => Boolean(state?.sessionId && state.rows > 8),
      "inline-image terminal session did not open", { surface });

    const red = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGP4z8DwH4QBEfcD/ePF9e8AAAAASUVORK5CYII=";
    const blue = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGNgYPj/H4QBDfsD/Yde1YcAAAAASUVORK5CYII=";
    const name = "cGxvdA==";
    const image = (data) => `printf '\\033[6;1H\\033]1337;File=name=${name};inline=1;width=4px;height=4px:${data}\\a'`;
    const redInput = `${image(red)}\r`;
    await s.run("terminal.input", { bytes: redInput }, surface);
    await s.until("terminal.session", (state) => state.inlineImages?.includes("plot"),
      "inline image display event was not observed", { surface });
    const beforeScroll = await terminalColorBounds(s, surface, "red");
    assert.ok(beforeScroll.count >= 2, `red inline image did not reach native pixels: ${beforeScroll.count}`);
    t.diagnostic(`${app.name}: inline image displayed ${beforeScroll.count} red pixels`);

    await s.run("terminal.input", { bytes: "i=0; while [ $i -lt 100 ]; do printf '\\n'; i=$((i+1)); done; printf '\\nSCROLL_DONE\\n'\r" }, surface);
    await readScreenUntil(s, surface, (lines) => lines.includes("SCROLL_DONE"),
      "terminal did not finish the scroll fixture");
    const afterScroll = await terminalColorBounds(s, surface, "red");
    t.diagnostic(`${app.name}: after scroll red pixels ${afterScroll.count} y=${afterScroll.minY}-${afterScroll.maxY}`);
    assert.equal(afterScroll.count, 0, "scrolled-off inline image remained visible at a stale absolute position");
    assert.ok((await s.get("terminal.session", surface)).inlineImages.includes("plot"),
      "scrolling deleted inline-image ownership instead of hiding its placement");

    await s.run("terminal.input", { bytes: `${image(blue)}; printf '\\nREPLACE_DONE\\n'\r` }, surface);
    await readScreenUntil(s, surface, (lines) => lines.includes("REPLACE_DONE"),
      "terminal did not finish the replacement fixture");
    const replaced = await terminalColorBounds(s, surface, "blue");
    assert.ok(replaced.count >= 1, `same-name replacement did not reach native pixels: ${replaced.count}`);
    const redAfterReplacement = await terminalColorBounds(s, surface, "red");
    assert.ok(redAfterReplacement.count < beforeScroll.count / 2,
      `same-name replacement retained the old image: ${redAfterReplacement.count}`);

    await s.run("terminal.image.inline.delete", { name: "plot" }, surface);
    await s.until("terminal.session", (state) => !state.inlineImages?.includes("plot"),
      "inline image deletion event was not observed", { surface });
    const deleted = await terminalColorBounds(s, surface, "blue");
    t.diagnostic(`${app.name}: after delete blue pixels ${deleted.count} y=${deleted.minY}-${deleted.maxY}`);
    assert.equal(deleted.count, 0, "inline image deletion left blue pixels in the native raster");
    const screen = await readScreenUntil(s, surface, (lines) => lines.length > 0,
      "terminal screen disappeared after inline image deletion");
    assert.ok(Array.isArray(screen), "terminal text state was not retained after image deletion");
    await s.run("host.window.resize", { width: 800, height: 920 });
    const resizedScreen = await readScreenUntil(s, surface, (lines) => lines.length > 0,
      "terminal screen disappeared after resize");
    assert.ok(Array.isArray(resizedScreen), "terminal text state was not retained after resize");
    t.diagnostic(`${app.name}: PASS inline image lifecycle (scroll/resize/replace/delete)`);
  });

  test(`${app.name}: terminal raster follows application light and dark theme`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const [terminal] = await ensureTerminals(s, 1);
    await s.until("core.surfaces", (surfaces) => surfaces.some((item) =>
      item.surface === terminal.surface && item.exposes.includes("status terminal.session")),
    "terminal session status did not register");
    await s.until("terminal.session", (state) => Boolean(state?.sessionId && state.theme),
      "terminal session did not report its effective theme", { surface: terminal.surface });
    const original = (await s.get("core.settings")).values.mode;
    const other = original === "dark" ? "light" : "dark";
    const rect = await s.rect("terminal.view", undefined, terminal.surface);
    const darkSample = original === "dark" ? await terminalBackgroundSample(s, rect) : null;
    const lightSample = original === "light" ? await terminalBackgroundSample(s, rect) : null;
    const sessionBefore = await s.get("terminal.session", terminal.surface);
    s.cleanup(async () => {
      await s.run("core.settings.theme", { name: "midnight", mode: original, scope: "common" });
      await closeTerminalTabs(s);
    });

    await s.run("core.settings.theme", { name: "midnight", mode: other, scope: "common" });
    await s.until("core.settings", (settings) => settings.values.mode === other && !settings.saving,
      `application theme did not switch to ${other}`);
    const switched = await s.until("terminal.session", (state) => state?.theme === other,
      `terminal did not acknowledge ${other} theme`, { surface: terminal.surface });
    const switchedSample = await terminalBackgroundSample(s, rect);
    if (other === "light") assert.ok(switchedSample[0] > 200 && switchedSample[1] > 200 && switchedSample[2] > 200,
      `light terminal background pixel was not light: ${switchedSample}`);
    else assert.ok(switchedSample[0] < 80 && switchedSample[1] < 80 && switchedSample[2] < 80,
      `dark terminal background pixel was not dark: ${switchedSample}`);
    assert.equal(switched.sessionId, sessionBefore.sessionId, "theme switch recreated the terminal session");
    assert.equal(switched.cellWidth, sessionBefore.cellWidth, "theme switch changed cell width");
    assert.equal(switched.cellHeight, sessionBefore.cellHeight, "theme switch changed cell height");
    if (other === "light") assert.ok(darkSample === null || switchedSample.some((value, index) => Math.abs(value - darkSample[index]) > 100),
      `light and dark background pixels did not differ: ${darkSample} -> ${switchedSample}`);
    else assert.ok(lightSample === null || switchedSample.some((value, index) => Math.abs(value - lightSample[index]) > 100),
      `dark and light background pixels did not differ: ${lightSample} -> ${switchedSample}`);
  });

  test(`${app.name}: terminal cursor policy uses declared settings, persistence, and pixels`, { timeout: 30000 }, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const [terminal] = await ensureTerminals(s, 1);
    const cursorKeys = [
      "terminal.cursor.shape", "terminal.cursor.blink", "terminal.cursor.interval",
      "terminal.cursor.idleTimeout", "terminal.cursor.unfocused",
    ];
    s.cleanup(async () => {
      for (const key of cursorKeys) await s.run("core.settings.reset", { key });
      await closeTerminalTabs(s);
    });
    await s.until("terminal.session", (state) => Boolean(state?.sessionId),
      "terminal session did not open", { surface: terminal.surface });
    const terminalView = await s.rect("terminal.view", undefined, terminal.surface);
    await s.click(terminalView.document.x + terminalView.x + terminalView.width / 2,
      terminalView.document.y + terminalView.y + terminalView.height / 2);
    await s.until("host.window", (host) => host.regions.some((region) =>
      region.surface === terminal.surface && region.focused),
    "terminal did not receive focus before cursor capture");
    const before = await terminalCursorCell(s, terminal.surface);
    await s.run("core.settings.open");
    const modalControl = async (key) => {
      const modal = await s.until("core.settings-modal", (state) =>
        state.controls.some((control) => control.key === key),
      `settings control ${key} did not appear`);
      return modal.controls.find((control) => control.key === key);
    };
    const pick = async (key) => {
      const control = await modalControl(key);
      assert.ok(control.command, `settings control ${key} has no command`);
      await s.run(control.command.name, control.command.params);
      const setting = key.slice("pick:".length).slice(0, key.slice("pick:".length).lastIndexOf(":"));
      const expected = key.slice(key.lastIndexOf(":") + 1);
      await s.until("core.settings", (state) => state.values[setting] === expected && !state.saving,
        `settings command did not apply ${setting}=${expected}`);
    };
    await modalControl("pick:terminal.cursor.shape:underline");
    await pick("pick:terminal.cursor.shape:underline");
    await pick("pick:terminal.cursor.blink:Never");
    await pick("pick:terminal.cursor.unfocused:beam");
    await s.run("core.settings.close");

    await s.run("core.settings.set", {
      patch: {
        "terminal.cursor.interval": 900,
        "terminal.cursor.idleTimeout": 0,
      },
      scope: "common",
    });
    await s.until("core.settings", (state) => state.values["terminal.cursor.unfocused"] === "beam" && !state.saving,
      "cursor settings were not saved");
    await s.until("terminal.cursor", (state) => state.unfocused === "beam" && state.blink === "Never",
      "terminal did not receive the effective cursor settings", { surface: terminal.surface });
    await s.presented();
    const after = await terminalCursorCell(s, terminal.surface);
    assert.ok(differentPixels(before.surface, after.surface) > 0,
      "cursor policy did not change actual terminal surface pixels");
    await s.run("core.settings.set", {
      patch: { "terminal.cursor.shape": "beam" },
      scope: "project",
    });
    await s.until("core.settings", (state) => state.values["terminal.cursor.shape"] === "beam" && !state.saving,
      "project cursor setting was not persisted");
    await s.until("terminal.cursor", (state) => state.shape === "beam",
      "project cursor setting did not reach the sidecar", { surface: terminal.surface });
    await s.run("core.settings.reset", { key: "terminal.cursor.shape" });
    await s.until("core.settings", (state) => state.values["terminal.cursor.shape"] === "underline" && !state.saving,
      "project cursor reset did not restore the common value");
    await s.until("terminal.cursor", (state) => state.shape === "underline",
      "common cursor value was not restored after project reset", { surface: terminal.surface });
    assert.equal(await failure(s.run("core.settings.set", {
      patch: { "terminal.cursor.interval": 0 }, scope: "common",
    })), -32602, "invalid cursor setting must fail explicitly");
    assert.equal((await s.get("core.settings")).values["terminal.cursor.interval"], 900,
      "invalid cursor setting must not replace the effective value");
  });

  test(`${app.name}: native terminal selection renders and copies through one explicit paste`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const [terminal] = await ensureTerminals(s, 1);
    const surface = terminal.surface;
    s.cleanup(() => closeTerminalTabs(s));
    await s.until("core.surfaces", (surfaces) => surfaces.some((item) =>
      item.surface === surface && item.exposes.includes("status terminal.session")),
    "terminal selection status did not register");
    await s.until("terminal.session", (state) => Boolean(state?.sessionId),
      "terminal selection session did not open", { surface });

    const transcript = await s.transcript();
    s.cleanup(() => transcript.stop());
    // 선택 제스처 동안 터미널 화면이 바뀌었는지 실패 보고에 쓴다.
    const screens = [];
    const offScreens = s.client.on("status.changed", (params) => {
      if (params?.name === "terminal.screen" && params.surface === surface) {
        screens.push(params.value.map((cells) => cells.map((cell) => cell.ch).join("").trimEnd()).slice(0, 3));
      }
    });
    await s.request("status.watch", { name: "terminal.screen", surface });
    s.cleanup(async () => {
      offScreens();
      await s.request("status.unwatch", { name: "terminal.screen", surface });
    });
    const marker = "SELECTION-CLIP-123";
    await s.run("terminal.input", { bytes: `printf '\\033[2J\\033[H${marker}\\n'\r` }, surface);
    const lines = await readScreenUntil(s, surface,
      (screen) => screen.some((line) => line.trim() === marker),
      "terminal selection marker did not render");
    const row = lines.findIndex((line) => line.trim() === marker);
    assert.ok(row >= 0, "terminal selection marker row was not found");
    const col = lines[row].indexOf(marker);
    assert.ok(col >= 0, "terminal selection marker column was not found");

    const view = await s.rect("terminal.view", undefined, surface);
    const metrics = await s.get("terminal.session", surface);
    assert.ok(metrics.cellWidth > 0 && metrics.cellHeight > 0, "terminal cell metrics are unavailable");
    const before = await terminalFrame(s);
    const viewX = view.document.x + view.x;
    const viewY = view.document.y + view.y;
    const start = {
      x: viewX + (col + 0.5) * metrics.cellWidth,
      y: viewY + (row + 0.5) * metrics.cellHeight,
    };
    const end = {
      x: viewX + (col + marker.length - 0.5) * metrics.cellWidth,
      y: start.y,
    };
    const screensBefore = screens.length;
    await s.pointer(start.x, start.y, "down", { button: "left" });
    await s.pointer(end.x, end.y, "drag", { button: "left" });
    await s.pointer(end.x, end.y, "up", { button: "left" });
    await s.presented();
    const selected = await s.get("terminal.session", surface);
    if (selected.error !== undefined) {
      const screen = await s.get("terminal.screen", surface);
      assert.fail(`native selection reported ${selected.error}; marker at row ${row}, col ${col}; ` +
        `pointer ${JSON.stringify(start)} → ${JSON.stringify(end)}; screen before selection ${JSON.stringify(lines.slice(0, row + 3))}; ` +
        `screen after selection ${JSON.stringify(screen.slice(0, row + 3).map((cells) => cells.map((cell) => cell.inverse ? cell.ch.toUpperCase() + "*" : cell.ch).join("")))}; ` +
        `grid before ${metrics.cols}×${metrics.rows} at ${metrics.cellWidth}×${metrics.cellHeight}, ` +
        `after ${selected.cols}×${selected.rows} at ${selected.cellWidth}×${selected.cellHeight}; ` +
        `transcript ${JSON.stringify(transcript.lines.slice(-10))}; ` +
        `screens during the gesture ${JSON.stringify(screens.slice(screensBefore))}, last before ${JSON.stringify(screens[screensBefore - 1])}`);
    }

    const after = await terminalFrame(s);
    let changed = 0;
    const x0 = Math.max(0, Math.round(viewX + col * metrics.cellWidth));
    const x1 = Math.min(after.width, Math.round(viewX + (col + marker.length) * metrics.cellWidth));
    const y0 = Math.max(0, Math.round(viewY + row * metrics.cellHeight));
    const y1 = Math.min(after.height, Math.round(viewY + (row + 1) * metrics.cellHeight));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const oldPixel = pixel(before, x, y);
        const newPixel = pixel(after, x, y);
        if (oldPixel.some((value, index) => value !== newPixel[index])) changed++;
      }
    }
    assert.ok(changed > 0, "native selection did not change the selected raster pixels");

    await s.run("terminal.paste", {}, surface);
    const pasted = await readScreenUntil(s, surface,
      (screen) => screen.filter((line) => line.includes(marker)).length >= 2,
      "explicit paste did not return the selected text to the terminal");
    assert.ok(pasted.filter((line) => line.includes(marker)).length >= 2,
      "selection clipboard text was not pasted exactly as selected");
  });

  test(`${app.name}: terminal file drop pastes quoted paths without executing`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const [terminal] = await ensureTerminals(s, 1);
    const surface = terminal.surface;
    const dropped = "'/tmp/dropped file.txt' '/tmp/quote'\\''name.txt'";
    await s.run("terminal.drop", {
      urls: ["file:///tmp/dropped%20file.txt", "file:///tmp/quote%27name.txt"],
    }, surface);
    const lines = await readScreenUntil(s, surface,
      (screen) => screen.some((line) => line.includes(dropped)),
      "terminal file drop did not paste its quoted paths");
    assert.ok(lines.some((line) => line.includes(dropped)), "file drop payload was not visible in the terminal");
    assert.ok(!lines.some((line) => line.includes("command not found")), "file drop must not execute a command");
  });

  // 진단 빌드의 표면은 플러그인 진단 모듈(diagnostics.json)이 등록한 항목을 갖는다.
  test(`${app.name}: diagnostic terminal entries inject preedit and record terminal input`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const [terminal] = await ensureTerminals(s, 1);
    const surface = terminal.surface;
    assert.deepEqual(await s.run("terminal.ime.trace", { action: "start" }, surface),
      { enabled: true, overflow: false, entries: [] });
    s.cleanup(() => s.run("terminal.ime.trace", { action: "stop" }, surface));
    await s.run("terminal.compose.update", { text: "한", selectedRange: { location: 1, length: 0 } }, surface);
    await s.until("terminal.compose", (compose) => compose.text === "한",
      "the injected preedit did not reach terminal.compose", { surface });
    await s.run("terminal.compose.update", { text: "" }, surface);
    await s.until("terminal.compose", (compose) => compose.text === "",
      "the empty preedit did not clear terminal.compose", { surface });
    const trace = await s.run("terminal.ime.trace", { action: "stop" }, surface);
    assert.deepEqual(trace.entries.map((entry) => [entry.kind, entry.input?.type, entry.input?.text]),
      [["terminal-input", "compose", "한"], ["terminal-input", "compose", ""]]);
  });

  // 세션 오류는 관련 없는 이벤트(테마 확인)가 지우지 않고, 그 오류를 해소하는 이벤트(새 trace)만 지운다.
  test(`${app.name}: a terminal session error stays until the event that resolves it`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const [terminal] = await ensureTerminals(s, 1);
    const surface = terminal.surface;
    await s.until("terminal.session", (state) => Boolean(state?.sessionId && state.theme),
      "terminal session did not report its effective theme", { surface });
    const original = (await s.get("core.settings")).values.mode;
    const other = original === "dark" ? "light" : "dark";
    s.cleanup(() => s.run("core.settings.theme", { name: "midnight", mode: original, scope: "common" }));
    await s.run("terminal.ime.trace", { action: "start" }, surface);
    s.cleanup(() => s.run("terminal.ime.trace", { action: "stop" }, surface));
    // trace 용량은 256 이다. Control-U 는 셸의 입력 줄만 지운다.
    for (let i = 0; i < 257; i++) await s.run("terminal.input", { bytes: "\u0015" }, surface);
    const overflow = "IME diagnostic trace capacity exceeded";
    await s.until("terminal.session", (state) => state.error === overflow,
      "the trace overflow did not reach terminal.session", { surface });
    await s.run("core.settings.theme", { name: "midnight", mode: other, scope: "common" });
    const switched = await s.until("terminal.session", (state) => state.theme === other,
      `terminal did not acknowledge ${other} theme`, { surface });
    assert.equal(switched.error, overflow, "a theme acknowledgement hid the trace overflow");
    await s.run("terminal.ime.trace", { action: "start" }, surface);
    await s.until("terminal.session", (state) => state.error === undefined,
      "a new trace did not resolve the trace overflow", { surface });
  });

  test(`${app.name}: terminal image follows a window resize`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    await assertGridFillsPlane(s, "initial terminal resize layout");

    // 터미널 탭을 활성화한다. core.grid 는 상태이므로 상태 읽기로 카드와 탭을 얻는다.
    const grid = await s.get("core.grid");
    const card = grid.cards.find((c) => c.tabs.some((tab) => tab.plugin === "terminal"));
    if (!card) return t.skip("terminal tab not found");
    const terminalTab = card.tabs.find((tab) => tab.plugin === "terminal");

    await s.run("core.tab.select", { tab: terminalTab.id });

    let terminalSurface;
    await s.until(
      "core.surfaces",
      (surfaces) => {
        const terminal = surfaces.find(
          (surf) => surf.visible && surf.plugin === "terminal" &&
            surf.exposes.includes("status terminal.session")
        );
        if (!terminal) return false;
        terminalSurface = terminal.surface;
        return true;
      },
      "terminal surface did not become visible with terminal.session registered"
    );

    await s.until(
      "terminal.session",
      (session) => session && session.sessionId,
      "terminal session did not report sessionId",
      { surface: terminalSurface }
    );

    // 화면에 글자를 둔다.
    await s.run("terminal.input", { bytes: "echo hi\r" }, terminalSurface);
    await readScreenUntil(
      s,
      terminalSurface,
      (screen) => screen.some((line) => line.trim() === "hi"),
      "terminal did not print hi"
    );

    const before = await s.get("terminal.session", terminalSurface);

    const marker = "AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH-IIII-JJJJ-KKKK-LLLL-MMMM-NNNN-OOOO-PPPP";

    // 먼저 좁은 터미널에 긴 논리 행을 출력한다. 화면에 보이는 줄을 보존하는 것만으로는
    // 충분하지 않으므로, 모든 셀의 문자열을 합쳐 잘림이 없는지 확인한다.
    await s.run("host.window.resize", { width: 800, height: 920 });
    await s.until(
      "host.window",
      (w) => w.content.width === 800 && w.content.height > 0,
      "the window did not become narrow"
    );
    await s.until("core.grid", (grid) =>
      grid && Math.round(grid.width) === Math.round(grid.plane.w)
      && Math.round(grid.height) === Math.round(grid.plane.h),
      "the narrow window did not resize the DOM plane");

    const narrow = await s.until(
      "terminal.session",
      (session) => session && !session.error && session.cols < before.cols,
      `terminal session did not become narrow after the window resize: ${JSON.stringify(before)}`,
      { surface: terminalSurface }
    );
    await s.run("terminal.input", { bytes: `printf '${marker}\\n'\r` }, terminalSurface);
    const narrowLines = await readScreenUntil(
      s,
      terminalSurface,
      (screen) => screen.join("").includes(marker),
      "narrow terminal lost characters from the long logical row"
    );
    const narrowMarkerLines = narrowLines.filter((line) => line === marker);
    assert.equal(narrowMarkerLines.length, 0,
      `narrow terminal must wrap the logical row instead of keeping it on one line: ${JSON.stringify(narrowLines)}`);
    assert.ok(narrowLines.some((line, index) =>
      index > 0 && (narrowLines.slice(0, index).join("") + line).includes(marker)),
    "narrow terminal did not preserve the marker across wrapped rows");

    // 다시 넓히면 sidecar의 열 수와 화면의 논리 행이 함께 복원되어야 한다.
    await s.run("host.window.resize", { width: 1500, height: 920 });
    await s.until(
      "host.window",
      (w) => w.content.width === 1500 && w.content.height > 0,
      "the window did not become wide"
    );
    await s.until("core.grid", (grid) =>
      grid && Math.round(grid.width) === Math.round(grid.plane.w)
      && Math.round(grid.height) === Math.round(grid.plane.h),
      "the wide window did not resize the DOM plane");

    // 사이드카의 resize 응답 state 이벤트가 세션 상태에 도달해야 한다.
    // 셀 크기가 빠진 state 이벤트는 플러그인이 오류로 내놓으므로 cols 가 그대로 남는다.
    const after = await s.until(
      "terminal.session",
      (session) =>
        session &&
        !session.error &&
        session.cols > narrow.cols &&
        session.rows > before.rows,
      `terminal session did not grow after the narrow resize: ${JSON.stringify(narrow)}`,
      { surface: terminalSurface }
    );
    assert.equal(after.error, undefined, "resize state event must not set an error");

    const wideLines = await readScreenUntil(
      s,
      terminalSurface,
      (screen) => screen.join("").includes(marker)
      && screen.filter((line) => line === marker).length === 1,
      "wide terminal did not reflow the logical row back to one line"
    );
    assert.ok(wideLines.some((line) => line.includes(marker)),
      "wide terminal does not contain the complete logical row");

    await s.presented();

    // 커진 영역 안에서 그림이 영역을 덮는지 수치로 잰다.
    const terminalRect = await s.rect("terminal.view", undefined, terminalSurface);
    assert.ok(
      terminalRect.width > 0 && terminalRect.height > 0,
      "terminal view rect is empty"
    );

    const capture = await s.request("diagnostics.capture.start", {});
    const { frames: frameDir } = await s.request("diagnostics.capture.stop", {
      after: (await s.presented()).displayed,
    });

    s.cleanup(async () => {
      await closeTerminalTabs(s);
      try {
        rmSync(frameDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    });

    const frameFiles = frames(frameDir);
    assert.ok(frameFiles.length > 0, "no frames were captured");
    const frame = readFrame(frameFiles[frameFiles.length - 1]);

    const BG_COLOR = [30, 30, 30];
    const COLOR_TOLERANCE = 10;
    const BRIGHT_TEXT_THRESHOLD = 160;
    const BG_SAMPLE_RATIO_MIN = 0.5;

    const termX = Math.round(terminalRect.x);
    const termY = Math.round(terminalRect.y);
    const termWidth = Math.round(terminalRect.width);
    const termHeight = Math.round(terminalRect.height);

    let bgPixelCount = 0;
    let totalSampleCount = 0;
    let brightTextCount = 0;
    for (let y = termY; y < termY + termHeight; y += 2) {
      for (let x = termX; x < termX + termWidth; x += 2) {
        if (y < 0 || y >= frame.height || x < 0 || x >= frame.width) continue;
        const px = pixel(frame, x, y);
        totalSampleCount++;
        if (px.every((v, i) => Math.abs(v - BG_COLOR[i]) <= COLOR_TOLERANCE)) {
          bgPixelCount++;
        }
        if ((px[0] + px[1] + px[2]) / 3 >= BRIGHT_TEXT_THRESHOLD) brightTextCount++;
      }
    }

    const bgRatio = totalSampleCount > 0 ? bgPixelCount / totalSampleCount : 0;
    assert.ok(
      bgRatio >= BG_SAMPLE_RATIO_MIN,
      `terminal image does not cover the resized region: ${(bgRatio * 100).toFixed(1)}% background over ${termWidth}x${termHeight} (need >= ${(BG_SAMPLE_RATIO_MIN * 100).toFixed(0)}%)`
    );
    assert.ok(
      brightTextCount >= 20,
      `terminal text not visible after resize: ${brightTextCount} bright pixels (need >= 20)`
    );
  });

  test(`${app.name}: multiple terminals keep fixed cells during a divider drag`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    s.cleanup(() => closeTerminalTabs(s));
    const terminals = await ensureTerminals(s, 3);
    assert.ok(terminals.length >= 3, `expected at least three visible terminals, got ${terminals.length}`);
    await s.presented();

    const before = new Map();
    for (const [index, surface] of terminals.entries()) {
      const session = await s.get("terminal.session", surface.surface);
      before.set(surface.surface, { cellWidth: session.cellWidth, cellHeight: session.cellHeight });
      const marker = `DRAG-TEXT-${index}`;
      await s.run("terminal.input", { bytes: `printf '\\033[2J\\033[H${marker}\\n'\r` }, surface.surface);
      await readScreenUntil(
        s,
        surface.surface,
        (screen) => screen[0].trim() === marker,
        `${surface.surface} did not render its marker before the divider drag`
      );
      before.get(surface.surface).marker = marker;
    }
    const beforeGrid = await s.get("core.grid");
    const terminalY = (await s.rect("terminal.view", undefined, terminals[0].surface)).y;
    // 여러 터미널이 있는 상태에서 한 번의 빠른 드래그를 수행한다. 반복 왕복과
    // 프로젝트 복귀는 F1.3에서 별도의 전체 캡처 행렬로 검사한다.
    const terminalCard = beforeGrid.cards.filter((card) => terminals.some((surface) => card.active === surface.surface))
      .sort((a, b) => a.x - b.x)[0];
    assert.ok(terminalCard, "terminal card is missing");
    const result = await drag(t, s, { axis: "x", line: terminalCard.c1, dx: 500, dy: 0, ms: 96, times: 1 }, { capture: true });
    assert.ok(result.count > 20, `divider recording contained too few frames: ${result.count}`);
    assert.ok(result.longestGap <= 100, `divider recording dropped a gesture interval: ${result.longestGap}ms`);
    assert.equal(result.late, 0, `divider input arrived late: ${result.late} steps`);
    assert.equal(result.deepest, 0, `divider input queue accumulated ${result.deepest} steps`);

    // 왕복의 끝은 시작 좌표와 같아야 한다. 실제 이동은 각 캡처의 카드 좌표로 검사한다.
    await s.presented();
    const host = await s.get("host.window");
    const positions = [];
    let firstGlyph = null;
    for (const [index, file] of frames(result.frameDir).entries()) {
      const frame = readFrame(file);
      const boxes = surfaceBoxes(frame, [30, 30, 30]);
      const terminalBoxes = boxes.filter((box) =>
        Math.abs(box.row / frame.scale - terminalY) <= 5);
      assert.equal(terminalBoxes.length, terminals.length, `frame ${index}: every terminal must be measurable`);
      positions.push([...terminalBoxes].sort((a, b) => a.card.l - b.card.l)[1].card.l / frame.scale);
      for (const box of terminalBoxes) {
        assert.ok(box.l > box.card.l && box.r - 1 < box.card.r,
          `frame ${index}: terminal ${box.l}..${box.r - 1} invades DOM card ${box.card.l}..${box.card.r}`);
        const scale = frame.scale;
        const leftGap = box.l - box.card.l;
        const rightGap = box.card.r - box.r;
        assert.ok(leftGap >= scale && leftGap <= 2 * scale,
          `frame ${index}: terminal left gap is ${leftGap}px; ` +
          `(surface=${box.l}..${box.r}, card=${box.card.l}..${box.card.r}, scale=${scale})`);
        // surfaceBoxes.r는 배타적 좌표이고 span().card.r는 카드의 마지막 픽셀이다.
        // 네이티브 영역은 오른쪽 보더의 안쪽 경계 바로 앞에서 끝나야 한다.
        assert.ok(rightGap >= 0 && rightGap <= 2 * scale,
          `frame ${index}: terminal right gap is ${rightGap}px; ` +
          `(surface=${box.l}..${box.r}, card=${box.card.l}..${box.card.r}, scale=${scale})`);
        assert.ok(box.r - box.l >= box.card.r - box.card.l - 4 * scale,
          `frame ${index}: terminal native area is narrower than its card`);
        assert.equal(whitePixels(frame, { l: box.l, r: box.r, t: box.t, b: box.b }), 0,
          `frame ${index}: terminal contains white pixels`);
        const metrics = before.values().next().value;
        const shape = glyphShape(frame, { l: box.l, r: box.l + Math.round(metrics.cellWidth * scale),
          t: box.t, b: box.t + Math.round(metrics.cellHeight * scale) });
        firstGlyph ??= shape;
        assert.equal(shape.height, firstGlyph.height,
          `frame ${index}: terminal glyph height changed during drag`);
        assert.ok(Math.abs(shape.width - firstGlyph.width) <= 1,
          `frame ${index}: terminal glyph raster width changed beyond subpixel rounding`);
      }
    }
    assertRoundTrips(positions, 1);
    for (const surface of await s.surfaces("terminal")) {
      const session = await s.get("terminal.session", surface.surface);
      const original = before.get(surface.surface);
      await readScreenUntil(
        s,
        surface.surface,
        (screen) => screen.join("").includes(original.marker),
        `${surface.surface} lost terminal text during the divider drag`
      );
      assert.equal(session.cellWidth, original.cellWidth, `${surface.surface} changed terminal cell width`);
      assert.equal(session.cellHeight, original.cellHeight, `${surface.surface} changed terminal cell height`);
      const region = host.regions.find((item) => item.surface === surface.surface);
      assert.ok(region, `${surface.surface} has no native region after divider drag`);
      assert.equal(region.presented.width, Math.round(region.frame.width * region.presented.scale),
        `${surface.surface} raster width does not match its frame after divider drag`);
      assert.equal(region.presented.height, Math.round(region.frame.height * region.presented.scale),
        `${surface.surface} raster height does not match its frame after divider drag`);
    }
  });
}
