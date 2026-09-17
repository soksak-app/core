// 세로 경계를 끄는 동안 표면 아래 footer 의 어두운 테두리가 비지 않는지 녹화로 검사한다.
// 1×·2× 배율과 반 포인트 표면 크기는 native/darwin/tests/webview_geometry_test.m 이 검사한다.
import assert from "node:assert/strict";
import test from "node:test";
import { APPS, drag, fresh, open } from "./app.mjs";
import { frames, pixel, readFrame } from "./frame.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: vertical dragging preserves the footer border`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    const shell = await fresh(s);
    const initial = await s.get("host.window");
    const surface = initial.surfaces.find((x) => x.id === shell.surface).frame;
    const run = await drag(t, s, { axis: "y", line: 1, dx: 0, dy: 173, ms: 400, times: 2 }, { capture: true });
    const files = frames(run.frames);
    assert.ok(files.length > 30, `only ${files.length} frames recorded`);
    let measured = 0, low = Infinity, high = -Infinity;
    let worst = { brightness: 0, frame: -1 };
    files.forEach((path, index) => {
      const frame = readFrame(path);
      const scale = frame.width / initial.content.width;
      const x = Math.floor((surface.x + surface.width / 2) * scale);
      let bottom = -1;
      for (let y = 0; y < frame.height; y++) {
        if (pixel(frame, x, y).every((v, i) => Math.abs(v - [13, 26, 20][i]) <= 4)) bottom = y;
      }
      if (bottom < 0) return;
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
