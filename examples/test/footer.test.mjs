// 소수점 입력에서도 DOM 슬롯, 네이티브 표면, 문서 크기와 푸터 표시가 일치하는지 검사한다.
import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { APPS, ask, nativeProbe, shake } from "./app.mjs";
import { frames, readFrame, pixel, writePNG } from "./frame.mjs";

for (const [name, binary] of Object.entries(APPS)) {
  test(`${name}: vertical dragging preserves the footer border with fractional input`, async (t) => {
    const initial = await nativeProbe(binary, { op: "state" }, true);
    if (!initial) return t.skip(`${binary} is not built`);
    assert.equal(initial.scale, 2, "fractional rendering verification requires a 2× display");
    const script = `import('./plane.js').then(p => {
      const g = p.currentGrid();
      g.moveBoundary('y', 1, Math.floor(g.boundaryPos('y', 1)) + 10.5, false);
      p.settle();
    }); null`;
    await ask(binary, ["transcript on", "native " + JSON.stringify({
      op: "eval", match: "main", script, ticket: "footer-layout",
    })], text => /host presentSurfaces .*"settled":true.* ->/.test(text), { from: false });
    const state = await nativeProbe(binary, { op: "state" });
    const surface = state.views.find(v => !v.hidden && v.url.includes("terminal.html"));
    assert.ok(surface, "the terminal surface must be visible");
    assert.equal(surface.h % 1, .5, "the check must retain a half-point native height");
    const document = await nativeProbe(binary, { op: "eval", match: surface.url,
      script: `(() => {
        const r = document.body.getBoundingClientRect();
        return { width: r.width, height: r.height,
          lastPixel: document.elementFromPoint(${surface.w / 2}, ${surface.h - .25}) !== null };
      })()` });
    t.diagnostic(`native ${surface.w}×${surface.h}; document ${document.width}×${document.height}`);
    assert.deepEqual([document.width, document.height], [surface.w, surface.h],
      "the document must cover the complete fractional native surface");
    const id = new URL(surface.url).searchParams.get("id");
    const slot = await nativeProbe(binary, { op: "eval", match: "main", script: `(() => {
      const r = document.querySelector('[data-native-surface-id="${id}"]').getBoundingClientRect();
      return [r.width, r.height];
    })()` });
    assert.deepEqual([surface.w, surface.h], slot,
      "the native surface must exactly fill its DOM slot");

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
      assert.ok(document.lastPixel, "the document must receive input in the final device pixel");
      passed = true;
    } finally {
      if (passed) run.clean();
    }
  });
}
