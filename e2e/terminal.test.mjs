// 터미널 표면의 입력이 터미널 사이드카를 거쳐 같은 표면의 출력으로 돌아오는지 검사한다.
// 창 크기가 바뀌어도 터미널 그림이 영역과 DOM 을 따라가는지 검사한다.
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test from "node:test";

import { APPS, drag, fresh, open } from "./app.mjs";
import { frames, pixel, readFrame } from "./frame.mjs";


function textLines(screen) {
  assert.ok(screen && Array.isArray(screen.lines), `invalid terminal screen: ${JSON.stringify(screen)}`);
  return screen.lines.map((row) => row.map((cell) => cell.ch ?? "").join(""));
}

async function readScreenUntil(session, surface, predicate, message) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const screen = await session.run("terminal.screen.read", {}, surface);
    const lines = textLines({ lines: screen });
    if (predicate(lines)) return lines;
  }
  throw new Error(`${message}; the screen never reached the required content`);
}

async function ensureTerminals(session, count) {
  let terminals = (await session.surfaces("terminal")).length;
  while (terminals < count) {
    const grid = await session.get("core.grid");
    const card = grid.cards.find((item) =>
      item.active && item.tabs.some((tab) => tab.plugin === "terminal"));
    assert.ok(card, "a visible terminal card was not found for splitting");
    await session.run("core.card.split", { card: card.id, axis: "x", plugin: "terminal" });
    terminals = await session.until(
      "core.surfaces",
      (surfaces) => surfaces.filter((item) => item.visible && item.plugin === "terminal").length,
      `terminal count did not reach ${terminals + 1}`
    );
  }
  return session.surfaces("terminal");
}

async function closeTerminalTabs(session) {
  const grid = await session.get("core.grid");
  for (const tab of grid.cards.flatMap((card) => card.tabs).filter((tab) => tab.plugin === "terminal")) {
    await session.run("core.tab.close", { tab: tab.id });
  }
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: terminal input returns terminal output through the terminal sidecar`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);

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
          (surf) => surf.visible && surf.plugin === "terminal"
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

  test(`${app.name}: terminal image follows a window resize`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);

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
          (surf) => surf.visible && surf.plugin === "terminal"
        );
        if (!terminal) return false;
        terminalSurface = terminal.surface;
        return true;
      },
      "terminal surface did not become visible"
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
    await s.presented();

    const before = new Map();
    for (const surface of terminals) {
      const session = await s.get("terminal.session", surface.surface);
      before.set(surface.surface, { cellWidth: session.cellWidth, cellHeight: session.cellHeight });
    }
    const beforeGrid = await s.get("core.grid");
    const result = await drag(t, s, { axis: "x", line: 1, dx: 80, dy: 0, ms: 320, times: 1 }, { capture: true });
    assert.ok(result.count > 10, `divider recording contained too few frames: ${result.count}`);
    assert.ok(result.longestGap <= 100, `divider recording dropped a gesture interval: ${result.longestGap}ms`);
    assert.equal(result.late, 0, `divider input arrived late: ${result.late} steps`);
    assert.equal(result.deepest, 0, `divider input queue accumulated ${result.deepest} steps`);

    const afterGrid = await s.get("core.grid");
    assert.notDeepEqual(afterGrid.lines.x, beforeGrid.lines.x, "divider drag did not change a vertical boundary");
    await s.presented();
    const host = await s.get("host.window");
    for (const surface of await s.surfaces("terminal")) {
      const session = await s.get("terminal.session", surface.surface);
      const original = before.get(surface.surface);
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
