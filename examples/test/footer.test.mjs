// 소수점 높이의 표면 아래에 네이티브 기본 배경이 노출되는지 검사한다.
import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { APPS, nativeProbe, shake } from "./app.mjs";
import { frames, readFrame, pixel, writePNG } from "./frame.mjs";

for (const [name, binary] of Object.entries(APPS)) {
  test(`${name}: vertical dragging preserves the footer border at fractional heights`, async (t) => {
    const initial = await nativeProbe(binary, { op: "state" }, true);
    if (!initial) return t.skip(`${binary} is not built`);
    await nativeProbe(binary, { op: "eval", match: "main", script: `
      import('./plane.js').then(p => {
        const g = p.currentGrid();
        g.moveBoundary('y', 1, Math.floor(g.boundaryPos('y', 1)) + .5, false);
        p.settle();
      }); null` });
    let surface;
    const until = Date.now() + 10_000;
    do {
      const state = await nativeProbe(binary, { op: "state" });
      surface = state.views.find(v => !v.hidden && v.url.includes("terminal.html"));
      if (surface && surface.h % 1 === .5) break;
      assert.ok(Date.now() < until, "the terminal never reached a half-point height");
      await new Promise(resolve => setTimeout(resolve, 20));
    } while (true);

    const run = await shake(binary, "0,y,1,0,173,400,2", { from: false });
    let passed = false;
    try {
      const files = frames(run.into);
      assert.ok(files.length > 30, `only ${files.length} frames recorded`);
      let measured = 0, low = Infinity, high = -Infinity;
      let worst = { brightness: 0 };
      for (const path of files) {
        const frame = readFrame(path);
        const scale = frame.width / initial.w;
        const x = Math.floor((surface.x + surface.w / 2) * scale);
        let bottom = -1;
        for (let y = 0; y < frame.height; y++) {
          if (pixel(frame, x, y).every((v, i) => Math.abs(v - [13, 26, 20][i]) <= 4)) bottom = y;
        }
        if (bottom < 0) continue;
        measured++;
        low = Math.min(low, bottom / scale); high = Math.max(high, bottom / scale);
        for (let y = bottom + 1; y <= bottom + Math.ceil(3 * scale); y++) {
          const brightness = Math.min(...pixel(frame, x, y));
          if (brightness > worst.brightness) worst = { brightness, path };
        }
      }
      assert.ok(measured > files.length * .9, `only ${measured}/${files.length} footer positions measured`);
      assert.ok(high - low > 100, `the recorded surface moved only ${high - low}pt`);
      if (worst.brightness > 80) {
        const shown = join(run.into, "footer.png");
        writePNG(readFrame(worst.path), shown);
        assert.fail(`footer brightness ${worst.brightness} exceeds the dark border: ${shown}`);
      }
      passed = true;
    } finally {
      if (passed) run.clean();
    }
  });
}
