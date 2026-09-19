// 터미널 표면의 입력이 터미널 사이드카를 거쳐 같은 표면의 출력으로 돌아오는지 검사한다.
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test from "node:test";

import { APPS, fresh, open } from "./app.mjs";
import { frames, pixel, readFrame } from "./frame.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: terminal input returns terminal output through the terminal sidecar`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);

    // 터미널 탭을 활성화한다.
    const rect = await s.rect("core.grid");
    const shellCard = rect.cards.find((card) => card.id === "shell");
    const terminalTab = shellCard.tabs.find((tab) => tab.plugin === "terminal");
    if (!terminalTab) return t.skip("terminal tab not found in shell card");

    // 터미널 탭을 클릭하여 활성화한다.
    await s.act("core.tab", "click", {
      event: {
        type: "click",
      },
      value: terminalTab.id,
    });

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
    const lines = await s.until(
      "terminal.screen.read",
      (screen) => {
        if (!screen || !screen.lines) return false;
        return screen.lines.some((line) => line.trim() === "hi");
      },
      "terminal did not print hi",
      { surface: terminalSurface }
    );

    // 화면이 읽혔는지 확인한다.
    const screen = await s.get("terminal.screen.read", terminalSurface);
    assert.ok(
      screen.lines.some((line) => line.trim() === "hi"),
      `terminal output does not contain "hi": ${JSON.stringify(screen.lines)}`
    );

    // 창 캡처로 터미널 영역에 글자가 나왔는지 확인한다.
    const terminalRect = await s.rect("terminal.view", undefined, terminalSurface);
    const capture = await s.request("diagnostics.capture.start", {});

    // 캡처를 즉시 중지하되, 마지막 표시 시각까지의 프레임을 기록한다.
    const { frames: frameDir } = await s.request("diagnostics.capture.stop", {
      after: (await s.presented()).displayed,
    });

    t.after(async () => {
      await s.run("terminal.close", {}, terminalSurface);
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
}
