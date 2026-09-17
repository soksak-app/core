// 250pt를 400ms에 이동하는 두 왕복을 녹화해 표면의 카드 내부 표시를 검사한다.
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, drag, fresh, open } from "./app.mjs";
import { frames, readFrame } from "./frame.mjs";
import { outside } from "./outside.mjs";
import { alignment } from "./alignment.mjs";

const PLAN = { axis: "x", line: 2, dx: -250, dy: 0, ms: 400, times: 2 };

const READ = 0.5;

function assertAligned(run) {
  const files = frames(run.frames);
  assert.ok(files.length > 30, `only ${files.length} frames were recorded`);

  let worst = { out: 0, frame: -1, at: null };
  let read = 0;
  let broke = 0;
  const positions = [];
  let initial = null;
  let delayed = { delta: 0, frame: -1, geometry: null };
  files.forEach((path, index) => {
    const frame = readFrame(path);
    const at = outside(frame);
    if (!at) return;
    const geometry = alignment(frame, at);
    assert.ok(geometry, `the terminal line, sidebar, or rail could not be measured in frame ${index}`);
    initial ??= geometry;
    const delta = Math.max(...Object.keys(initial).map((key) => Math.abs(geometry[key] - initial[key])));
    if (delta > delayed.delta) delayed = { delta, frame: index, geometry };
    read++;
    positions.push(at.card.l / at.scale);
    if (at.out <= 0) return;
    broke++;
    if (at.out > worst.out) worst = { out: at.out, frame: index, at };
  });
  assert.ok(read > files.length * READ,
    `only ${read} of ${files.length} frames could be measured, so this run checked nothing. ` +
      "The surface or its card was not found in the rest.");

  const low = Math.min(...positions), high = Math.max(...positions);
  const span = high - low;
  assert.ok(span >= 50, `the card moved only ${span}pt; the requested drag was not recorded`);
  const ends = [];
  for (const position of positions) {
    const end = position <= low + span * .2 ? "low" : position >= high - span * .2 ? "high" : null;
    if (end && ends.at(-1) !== end) ends.push(end);
  }
  assert.deepEqual(ends, ["high", "low", "high", "low", "high"], "the recording must contain both complete round trips");
  assert.ok(Math.abs(positions[0] - positions.at(-1)) <= 1,
    `the recorded card must return to its initial position: ${positions[0]} → ${positions.at(-1)}`);

  assert.ok(delayed.delta <= 1,
    `native content, card, sidebar, and rail geometry differ by ${delayed.delta.toFixed(1)}pt in frame ` +
      `${delayed.frame} of ${files.length}: initial ${JSON.stringify(initial)}, frame ${JSON.stringify(delayed.geometry)}`);

  const { at } = worst;
  assert.equal(broke, 0,
    `${broke} of ${read} measured frames draw the surface outside its own card. The worst is frame ` +
      `${worst.frame}, ${worst.out.toFixed(1)}pt out` +
      (at?.onNeighbour > 0 ? `, ${at.onNeighbour.toFixed(1)}pt of it over the neighbouring card` : "") +
      (at ? `: the card spans ${at.card.l}..${at.card.r} and the surface ${at.surface.l}..${at.surface.r} ` +
        `on row ${at.row}, at ${at.scale} pixels to the point` : ""));
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: native content, cards, and the sidebar rail stay aligned`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    assertAligned(await drag(t, s, PLAN, { capture: true }));
  });
}
