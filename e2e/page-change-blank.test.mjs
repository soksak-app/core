// 페이지가 바뀌는 동안 창이 비어 보이는 시간을 녹화로 잰다(docs/spec/surface-composition.md). 머리 줄의 로고 그림은
// 라이브러리와 프로젝트 화면 모두 그리므로, 그 자리에 그림 픽셀이 하나도 없는 프레임을 빈 창으로 센다.
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test from "node:test";

import { APPS, fresh, open } from "./app.mjs";
import { frames, pixel, readFrame } from "./frame.mjs";

/** 녹화한 프레임마다 로고 자리(창 좌표 rect)에 배경과 다른 픽셀이 있는지 센다. */
function logoInk(frame, rect, background) {
  const scale = frame.scale * frame.contentScale;
  let ink = 0;
  for (let y = rect.y; y < rect.y + rect.height; y++) {
    for (let x = rect.x; x < rect.x + rect.width; x++) {
      const rgb = pixel(frame, Math.floor(frame.content.x * frame.scale + x * scale),
        Math.floor(frame.content.y * frame.scale + y * scale));
      if (rgb.some((value, index) => Math.abs(value - background[index]) > 40)) ink++;
    }
  }
  return ink;
}

/** 빈 프레임이 이어진 가장 긴 시간(ms)과 빈 프레임 수. 빈 프레임은 다음 프레임까지 보인 것으로 센다. */
function blankTime(captured, rect) {
  const background = (() => {
    const frame = captured[0];
    const scale = frame.scale * frame.contentScale;
    return pixel(frame, Math.floor(frame.content.x * frame.scale + (rect.x - 4) * scale),
      Math.floor(frame.content.y * frame.scale + (rect.y + rect.height / 2) * scale));
  })();
  let longest = 0, count = 0, start = null;
  captured.forEach((frame, index) => {
    const blank = logoInk(frame, rect, background) === 0;
    if (blank) { count++; start ??= frame.time; }
    const end = captured[index + 1]?.time ?? frame.time;
    if (blank) longest = Math.max(longest, end - start);
    else start = null;
  });
  return { longest, count, frames: captured.length };
}

async function record(s, action) {
  const { displayed } = await s.presented();
  const recording = await s.request("diagnostics.capture.start", {});
  let stopped = false;
  try {
    await action();
    const shown = await s.presented();
    const stop = await s.request("diagnostics.capture.stop", { after: Math.max(displayed, shown.displayed) + 100 });
    stopped = true;
    assert.equal(stop.limited, false, "the recording reached its frame cap");
    return frames(recording.frames).map(readFrame);
  } finally {
    // 동작이 실패해도 녹화를 끝내야 다음 검사가 녹화를 시작할 수 있다.
    if (!stopped) await s.request("diagnostics.capture.stop", { after: displayed });
    rmSync(recording.frames, { recursive: true, force: true });
  }
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: page changes keep the window drawn`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    assert.ok(s, `${app.binary} is not built`);
    await fresh(s);
    // 로고 그림은 창 머리 줄 왼쪽의 아이콘이다(신호등 단추 오른쪽).
    const logo = { x: 86, y: 12, width: 14, height: 14 };
    const reload = blankTime(await record(s, async () => {
      const before = (await s.get("core.window.document")).timeOrigin;
      await s.run("host.window.reload");
      await s.until("core.window.document", (doc) => doc.timeOrigin !== before && doc.readyState === "complete",
        "the main document did not reload");
    }), logo);
    const library = blankTime(await record(s, async () => {
      await s.run("core.projects.browse");
      await s.until("core.screen", (value) => value.screen === "library", "the library did not open");
      await s.run("core.library.return");
      await s.until("core.screen", (value) => value.screen === "workspace", "the library did not return to the workspace");
    }), logo);
    t.diagnostic(`reload: ${JSON.stringify(reload)}; library: ${JSON.stringify(library)}`);
    assert.equal(library.count, 0, `opening and leaving the library showed ${library.count} empty frames (${library.longest}ms)`);
  });
}
