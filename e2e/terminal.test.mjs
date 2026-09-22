// 터미널 표면의 입력이 터미널 사이드카를 거쳐 같은 표면의 출력으로 돌아오는지 검사한다.
// 창 크기가 바뀌어도 터미널 그림이 영역과 DOM 을 따라가는지 검사한다.
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test from "node:test";

import { APPS, drag, fresh, open, within } from "./app.mjs";
import { frames, pixel, readFrame } from "./frame.mjs";
import { glyphShape, surfaceBoxes, whitePixels } from "./outside.mjs";
import { assertRoundTrips } from "./drag-measurement.mjs";
import { terminalProcessSnapshot } from "./terminal-processes.mjs";


function textLines(screen) {
  assert.ok(screen && Array.isArray(screen.lines), `invalid terminal screen: ${JSON.stringify(screen)}`);
  return screen.lines.map((row) => row.map((cell) => {
    assert.ok(Number.isInteger(cell.width) && cell.width >= 0, "cell width is required");
    return cell.ch === undefined ? " ".repeat(cell.width) : cell.ch;
  }).join("").trimEnd());
}

async function readScreenUntil(session, surface, predicate, message) {
  // 현재 화면을 한 번 읽고 이후 출력은 알림으로 기다린다. 리사이즈도 이 읽기에 반영된다.
  await session.run("terminal.screen.read", {}, surface);
  const screen = await session.until("terminal.screen",
    (lines) => predicate(textLines({ lines })), message, { surface });
  return textLines({ lines: screen });
}

async function ensureTerminals(session, count) {
  // The fixture starts with the shell tab active. Select the declared terminal
  // before measuring visible native terminal surfaces; waiting for an inactive
  // tab would turn a test setup mistake into a false runtime failure.
  const initialGrid = await session.get("core.grid");
  const terminalTab = initialGrid.cards.flatMap((card) => card.tabs)
    .find((tab) => tab.plugin === "terminal");
  assert.ok(terminalTab, "the fixture has no terminal tab");
  const owner = initialGrid.cards.find((card) => card.tabs.some((tab) => tab.id === terminalTab.id));
  if (owner?.active !== terminalTab.id) await session.run("core.tab.select", { tab: terminalTab.id });
  await session.until(
    "core.surfaces",
    (surfaces) => surfaces.some((item) => item.visible && item.plugin === "terminal"),
    "the fixture terminal did not register before splitting",
  );
  let terminals = (await session.surfaces("terminal")).length;
  while (terminals < count) {
    const grid = await session.get("core.grid");
    const card = grid.cards.find((item) =>
      item.active && item.tabs.some((tab) => tab.plugin === "terminal"));
    assert.ok(card, "a visible terminal card was not found for splitting");
    await session.run("core.card.split", { card: card.id, axis: "x", plugin: "terminal" });
    await session.until(
      "core.surfaces",
      (surfaces) => surfaces.filter((item) => item.visible && item.plugin === "terminal").length >= terminals + 1,
      `terminal count did not reach ${terminals + 1}`
    );
    terminals = (await session.get("core.surfaces"))
      .filter((item) => item.visible && item.plugin === "terminal").length;
  }
  await session.until(
    "core.surfaces",
    (surfaces) => surfaces.filter((item) => item.visible && item.plugin === "terminal").length >= count,
    `terminal native surfaces did not reach ${count}`
  );
  return session.surfaces("terminal");
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

async function assertGridFillsPlane(session, message) {
  const grid = await session.get("core.grid");
  assert.ok(grid?.plane, `${message}: grid has no plane measurement`);
  assert.equal(Math.round(grid.width), Math.round(grid.plane.w),
    `${message}: grid width ${grid.width} does not fill plane width ${grid.plane.w}`);
  assert.equal(Math.round(grid.height), Math.round(grid.plane.h),
    `${message}: grid height ${grid.height} does not fill plane height ${grid.plane.h}`);
}

for (const app of Object.values(APPS)) {
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
        await s.click(view.document.x + view.x + view.width / 2, view.document.y + view.y + view.height / 2);
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
        t.diagnostic(`${app.name}: terminal ${index + 1} session after typing ` +
          `${JSON.stringify({ sessionId: sessionAfterTyping.sessionId, error: sessionAfterTyping.error })}`);
        t.diagnostic(`${app.name}: terminal ${index + 1} screen after typing ` +
          `${JSON.stringify(textLines({ lines: screenAfterTyping }).filter(Boolean))}`);
        await readScreenUntil(s, surface, (lines) => lines.some((row) => row.endsWith(`${line}x`)), "native characters were not delivered");
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
      const positions = frames(result.frameDir).map((file, index) => {
        const frame = readFrame(file);
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
      assertRoundTrips(positions, roundTripsPerSet);
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
