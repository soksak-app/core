// 소수점 입력에서도 DOM 슬롯, 네이티브 표면, 문서 크기와 푸터 표시가 일치하는지 검사한다.
import assert from "node:assert/strict";
import test from "node:test";
import { APPS, drag, fresh, halfPointRow, open } from "./app.mjs";
import { frames, pixel, readFrame } from "./frame.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: vertical dragging preserves the footer border with fractional input`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    const terminal = await fresh(s);
    const initial = await s.get("host.window");
    assert.equal(initial.scale, 2, "fractional rendering verification requires a 2× display");
    await halfPointRow(s);
    const state = await s.get("host.window");
    const surface = state.surfaces.find((x) => x.id === terminal.surface).frame;
    assert.equal(surface.height % 1, .5, "the check must retain a half-point native height");
    const document = await s.until("core.surface.document",
      (doc) => doc.body.height === surface.height, "the document did not take the half-point height",
      { surface: terminal.surface });
    t.diagnostic(`native ${surface.width}×${surface.height}; document ${document.body.width}×${document.body.height}`);
    assert.deepEqual([document.body.width, document.body.height], [surface.width, surface.height],
      "the document must cover the complete fractional native surface");
    const slot = (await s.surfaces()).find((x) => x.surface === terminal.surface).declared;
    assert.deepEqual([surface.width, surface.height], [slot.w, slot.h], "the native surface must exactly fill its DOM slot");
    const lastPixel = await s.run("core.surface.hit", { x: surface.width / 2, y: surface.height - .25 }, terminal.surface);
    assert.equal(lastPixel, true, "the document must receive input in the final device pixel");

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
