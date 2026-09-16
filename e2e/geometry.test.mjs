// 실제 화면 배율과 AppKit 입력으로 표면의 문서 좌표를 검사한다.
import assert from "node:assert/strict";
import test from "node:test";
import { APPS, ask, nativeProbe } from "./app.mjs";

async function geometry(binary, scale) {
  const until = Date.now() + 10_000;
  let state, surface, document, slot, mainScale;
  for (;;) {
    await nativeProbe(binary, { op: "presentation" });
    state = await nativeProbe(binary, { op: "state" });
    surface = state.views.find(view => !view.hidden && view.url.includes("terminal.html"));
    assert.ok(surface, "the terminal surface must be visible");
    const id = new URL(surface.url).searchParams.get("id");
    [mainScale, slot] = await nativeProbe(binary, { op: "eval", match: "main", script: `(() => {
      const r = document.querySelector('[data-native-surface-id="${id}"]').getBoundingClientRect();
      return [devicePixelRatio, [r.x, r.y, r.width, r.height]];
    })()` });
    document = await nativeProbe(binary, { op: "eval", match: surface.url, script: `(() => {
      const r = document.body.getBoundingClientRect();
      return [devicePixelRatio, r.width, r.height, visualViewport.width, visualViewport.height];
    })()` });
    if (state.scale === scale && mainScale === scale && document[0] === scale &&
      [surface.x, surface.y, surface.w, surface.h].every((n, i) => n === slot[i]) &&
      document.slice(1).every((n, i) => n === (i % 2 === 0 ? surface.w : surface.h))) break;
    assert.ok(Date.now() < until, `native/document geometry did not converge: ${JSON.stringify({
      scale, mainScale, surface, slot, document,
    })}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return { state, surface };
}

async function clickLastPixel(binary, scale) {
  const { state, surface } = await geometry(binary, scale);
  const x = surface.w / 2, y = surface.h - 0.5 / scale;
  const point = { x: surface.x + x, y: surface.y + y };
  assert.equal((await nativeProbe(binary, { op: "hit", ...point })).url, surface.url);
  await nativeProbe(binary, { op: "eval", match: surface.url, script: `
    window.geometryEvents = {};
    for (const type of ['pointerdown', 'click'])
      addEventListener(type, e => { window.geometryEvents[type] = [e.isTrusted, e.clientX, e.clientY]; }, {once:true});
    null;
  ` });
  for (const [phase, type] of [["down", "pointerdown"], ["up", "click"]]) {
    await nativeProbe(binary, { op: "mouse", phase, ...point });
    const until = Date.now() + 5_000;
    let event;
    while (!(event = await nativeProbe(binary, { op: "eval", match: surface.url,
      script: `window.geometryEvents['${type}'] ?? null` }))) {
      assert.ok(Date.now() < until, `the final device pixel did not receive ${type}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(event[0], true, "the event must come through native event handling");
    const tolerance = type === "pointerdown" ? 0.001 : 1;
    assert.ok(Math.abs(event[1] - x) < tolerance && Math.abs(event[2] - y) < tolerance,
      `native input coordinates changed: expected ${x},${y}, received ${event.slice(1)}`);
  }
  assert.equal((await nativeProbe(binary, { op: "state" })).front, state.front,
    "the input probe must not activate the application");
}

for (const [name, binary] of Object.entries(APPS)) {
  test(`${name}: resizing preserves document geometry and native input`, async (t) => {
    const initial = await nativeProbe(binary, { op: "state" }, true);
    if (!initial) return t.skip(`${binary} is not built`);
    await clickLastPixel(binary, initial.scale);
    await ask(binary, ["transcript on", "size 997,647"],
      text => /host presentSurfaces .*"settled":true.* ->/.test(text), { from: false });
    await clickLastPixel(binary, initial.scale);
  });

  test(`${name}: display-scale changes preserve document geometry and native input`, async (t) => {
    const initial = await nativeProbe(binary, { op: "state" }, true);
    if (!initial) return t.skip(`${binary} is not built`);
    const other = initial.screens.find(screen => screen.scale !== initial.scale);
    if (!other) return t.skip("two displays with different scale factors are required");
    try {
      await ask(binary, ["transcript on", "native " + JSON.stringify({ op: "eval", match: "main", script: `
        import('./plane.js').then(p => {
          const g = p.currentGrid();
          g.moveBoundary('y', 1, Math.floor(g.boundaryPos('y', 1)) + 10.5, false);
          p.settle();
        }); null;
      ` })], text => /host presentSurfaces .*"settled":true.* ->/.test(text), { from: false });
      await clickLastPixel(binary, initial.scale);
      await nativeProbe(binary, { op: "position", x: other.x + 20, y: other.y + 20 });
      await clickLastPixel(binary, other.scale);
      await nativeProbe(binary, { op: "position", x: initial.x, y: initial.y });
      await clickLastPixel(binary, initial.scale);
    } finally {
      await nativeProbe(binary, { op: "position", x: initial.x, y: initial.y });
    }
  });
}
