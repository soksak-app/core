// 새 창이 처음 보이는 frame 부터 완전한 첫 화면을 그리는지 녹화로 잰다(docs/spec/surface-composition.md). 녹화는 창이 생긴
// 뒤에만 시작할 수 있으므로, 기존 창이 있는 디스플레이에서 이 앱의 창을 모두 담는 디스플레이 녹화로 새 창이 생기는 순간을
// 담는다. 새 창의 영역은 녹화가 끝난 뒤 그 창의 화면 좌표로 정한다.
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test from "node:test";

import { APPS, fresh, open } from "./app.mjs";
import { frames, pixel, readFrame } from "./frame.mjs";

/** 디스플레이 녹화 frame 에서 화면 좌표(포인트) point 의 픽셀. 디스플레이의 원점은 display 다. */
function sample(frame, display, point) {
  const scale = frame.scale * frame.contentScale;
  return pixel(frame, Math.floor((frame.content.x + point.x - display.x) * scale),
    Math.floor((frame.content.y + point.y - display.y) * scale));
}

/** rect(화면 좌표) 안에서 격자 step 마다 본 픽셀들. */
function grid(frame, display, rect, step) {
  const values = [];
  for (let y = rect.y + step / 2; y < rect.y + rect.height; y += step) {
    for (let x = rect.x + step / 2; x < rect.x + rect.width; x += step) values.push(sample(frame, display, { x, y }));
  }
  return values;
}

/** 두 격자에서 채널 차이가 tolerance 를 넘는 점의 비율. */
function differing(a, b, tolerance) {
  let count = 0;
  for (let i = 0; i < a.length; i++) if (a[i].some((value, channel) => Math.abs(value - b[i][channel]) > tolerance)) count++;
  return count / a.length;
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: a new window shows its complete first screen from its first frame`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    assert.ok(s, `${app.binary} is not built`);
    await fresh(s);
    const { displayed } = await s.presented();
    const recording = await s.request("diagnostics.capture.start", { display: true });
    let stopped = false;
    let child;
    try {
      await s.run("core.window.new");
      const list = await s.windows(2, "the new window did not open");
      child = s.on(list.find((w) => w.window !== s.window).window);
      await child.until("core.screen", (value) => value.screen === "library", "the new window did not show the library");
      const shown = await child.presented();
      const stop = await s.request("diagnostics.capture.stop", { after: Math.max(displayed, shown.displayed) + 100 });
      stopped = true;
      assert.equal(stop.limited, false, "the recording reached its frame cap");
      const window = (await child.get("host.window")).frame;
      // 디스플레이 녹화는 녹화한 창의 중심이 있는 디스플레이를 담는다(native/darwin/src/capture.m).
      const own = (await s.get("host.window")).frame;
      const centre = { x: own.x + own.width / 2, y: own.y + own.height / 2 };
      const display = (await s.get("host.screens")).find((screen) => centre.x >= screen.x && centre.x < screen.x + screen.width &&
        centre.y >= screen.y && centre.y < screen.y + screen.height);
      assert.ok(display, `no screen holds the recorded window ${JSON.stringify(own)}`);
      const captured = frames(recording.frames).map(readFrame);
      assert.ok(captured.length > 1, `the recording has ${captured.length} frames`);
      const region = { x: window.x, y: window.y, width: window.width, height: window.height };
      // 창이 열리는 애니메이션은 창을 조금 작게 시작하므로, 창이 처음부터 덮는 안쪽 영역에서 내용을 센다.
      const inner = { x: region.x + region.width * 0.06, y: region.y + region.height * 0.06,
        width: region.width * 0.88, height: region.height * 0.88 };
      const before = grid(captured[0], display, region, 16);
      const last = captured.at(-1);
      // 첫 화면의 바탕은 라이브러리 아래쪽 빈 자리의 색이다.
      const background = sample(last, display, { x: region.x + region.width / 2, y: region.y + region.height * 0.85 });
      const ink = (frame) => grid(frame, display, inner, 8)
        .filter((value) => value.some((channel, index) => Math.abs(channel - background[index]) > 40)).length;
      const complete = ink(last);
      assert.ok(complete > 0, "the last frame shows no content in the new window");
      const rows = captured.map((frame, index) => ({ index, time: Math.round(frame.time - captured[0].time),
        shown: differing(grid(frame, display, region, 16), before, 12), ink: ink(frame) }));
      const first = rows.findIndex((row) => row.shown > 0.05);
      assert.ok(first > 0, `the recording does not show the new window appear: ${JSON.stringify(rows.slice(0, 3))}`);
      const undrawn = rows.slice(first).filter((row) => row.ink < complete / 2);
      t.diagnostic(`window ${JSON.stringify(region)}; appears at frame ${first} of ${rows.length}; complete ink ${complete}; ` +
        `undrawn ${JSON.stringify(undrawn)}`);
      assert.deepEqual(undrawn, [], "the new window showed frames without its first screen");
    } finally {
      if (!stopped) await s.request("diagnostics.capture.stop", { after: displayed });
      rmSync(recording.frames, { recursive: true, force: true });
      if (child) await child.close();
    }
  });
}
