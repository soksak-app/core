// 세로 경계를 끄는 동안 표면 아래 footer 의 어두운 테두리가 비지 않는지 녹화로 검사한다.
// 1×·2× 배율과 반 포인트 표면 크기는 native/darwin/tests/webview_geometry_test.m 이 검사한다.
import assert from "node:assert/strict";
import test from "node:test";
import { APPS, drag, fresh, open } from "./app.mjs";
import { frames, pixel, readFrame } from "./frame.mjs";
import { shellLine, shellMarks } from "./outside.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: vertical dragging preserves the footer border`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const initial = await s.get("host.window");
    const marks = await shellMarks(s);
    const run = await drag(t, s, { axis: "y", line: 1, dx: 0, dy: 173, ms: 400, times: 2 }, { capture: true });
    const files = frames(run.frames);
    assert.ok(files.length > 30, `only ${files.length} frames recorded`);
    let measured = 0, low = Infinity, high = -Infinity;
    let worst = { brightness: 0, frame: -1 };
    let offset = null;
    files.forEach((path, index) => {
      const frame = readFrame(path);
      const scale = frame.width / initial.content.width;
      // 셸 표면은 카드 색이므로 표면의 아래 끝은 표면이 그리는 입력 구분선으로 찾는다. 구분선은 표면 아래 끝에서
      // 입력 줄 높이만큼 위에 있고, 그 높이는 선언된 자리에서 잰다.
      const x = Math.round(marks.cx * scale);
      const line = shellLine(frame, { cx: x, top: Math.round(marks.top * scale) + 1, bottom: frame.height });
      if (!line) return;
      offset ??= Math.round(marks.bottom * scale) - line.y;
      const bottom = line.y + offset - 1;
      measured++;
      low = Math.min(low, bottom / scale); high = Math.max(high, bottom / scale);
      for (let y = bottom + 1; y <= bottom + Math.ceil(3 * scale); y++) {
        const brightness = Math.min(...pixel(frame, x, y));
        if (brightness > worst.brightness) worst = { brightness, frame: index };
      }
    });
    assert.ok(measured > files.length * .9, `only ${measured}/${files.length} footer positions measured`);
    assert.ok(high - low > 100, `the recorded surface moved only ${high - low}pt`);
    assert.ok(worst.brightness <= 80,
      `footer brightness ${worst.brightness} exceeds the dark border in frame ${worst.frame} of ${files.length}`);
  });
}
