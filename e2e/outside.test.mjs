// 250pt를 400ms에 이동하는 두 왕복을 녹화해 표면의 카드 내부 표시를 검사한다.
import assert from "node:assert/strict";
import { availableParallelism, loadavg } from "node:os";
import test from "node:test";

import { APPS, drag, fresh, keepCommonSettings, open } from "./app.mjs";
import { frames, readFrame } from "./frame.mjs";
import { outside, shellMarks, whitePixels } from "./outside.mjs";
import { alignment } from "./alignment.mjs";
import { assertHeldStatesShown, assertRoundTrips, lagStages, pointerLag } from "./drag-measurement.mjs";

const PLAN = { axis: "x", line: 2, dx: -250, dy: 0, ms: 400, times: 2 };

const READ = 0.5;

// 격자가 한 배치를 떠난 뒤 그 배치가 화면에 남아 있어도 되는 시간(ms). 60Hz 화면의 두 프레임이다.
const LAG = 34;

function assertAligned(run, marks) {
  const files = frames(run.frames);
  assert.ok(files.length > 30, `only ${files.length} frames were recorded`);

  let worst = { out: 0, frame: -1, at: null };
  let read = 0;
  let broke = 0;
  const positions = [];
  const samples = [];
  let initial = null;
  let delayed = { delta: 0, frame: -1, geometry: null };
  files.forEach((path, index) => {
    const frame = readFrame(path);
    const at = outside(frame, marks);
    if (!at) return;
    const geometry = alignment(frame, at);
    assert.equal(geometry.missing, undefined, `frame ${index} of ${files.length}: could not measure the ${geometry.missing}`);
    initial ??= geometry;
    const delta = Math.max(...Object.keys(initial).map((key) => Math.abs(geometry[key] - initial[key])));
    if (delta > delayed.delta) delayed = { delta, frame: index, geometry };
    read++;
    positions.push(at.card.l / at.scale);
    samples.push({ time: frame.time, position: at.card.l / at.scale });
    if (at.out <= 0) return;
    broke++;
    if (at.out > worst.out) worst = { out: at.out, frame: index, at };
  });
  assert.ok(read > files.length * READ,
    `only ${read} of ${files.length} frames could be measured, so this run checked nothing. ` +
      "The surface or its card was not found in the rest.");

  assertRoundTrips(positions, 2);

  const lag = pointerLag(samples, run.ticks, run.boundary);
  lag.stages = lagStages(lag, run.ticks, run.layouts);
  assert.ok(lag.lag <= LAG,
    `the card showed a layout ${lag.lag.toFixed(1)}ms after the grid left it (limit ${LAG}ms): ` +
      `offset ${lag.shown?.toFixed(1)}pt at ${lag.time?.toFixed(1)}ms matches step ${lag.step} while step ${lag.sent} was sent; median ${lag.median.toFixed(1)}ms; ` +
      `transactions ${lag.stages}; ` +
      // 표시 지연은 다른 프로세스의 CPU 사용에 따라 달라지므로 측정 때의 시스템 부하를 함께 적는다.
      `load average ${loadavg().map((value) => value.toFixed(1)).join(" ")} on ${availableParallelism()} processors`);

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
  return lag;
}

function assertNoWhiteSurfaceBleed(run, message, marks) {
  const files = frames(run.frames);
  assert.ok(files.length > 0, `${message}: no frames were recorded`);
  const samples = [];
  let worst = { ratio: 0, frame: -1 };
  for (const [frameIndex, path] of files.entries()) {
    const frame = readFrame(path);
    const measured = outside(frame, marks);
    assert.ok(measured, `${message}: shell/card geometry could not be measured in frame ${frameIndex}`);
    const { l, r } = measured.card;
    samples.push({ time: frame.time, position: l / measured.scale });
    // 가로 끌기 동안 표면의 위아래는 움직이지 않는다. 카드 테두리 사이, 표면의 위부터 아래까지를 잰다.
    const y0 = Math.round(marks.top * frame.scale);
    const y1 = Math.round(marks.bottom * frame.scale);
    const left = l + measured.scale, right = r - measured.scale + 1;
    const white = whitePixels(frame, { l: left, r: right, t: y0, b: y1 });
    const ratio = white / ((right - left) * (y1 - y0));
    if (ratio > worst.ratio) worst = { ratio, frame: frameIndex, measured, y0, y1 };
  }
  assert.equal(worst.ratio, 0,
    `${message}: white pixels ${(worst.ratio * 100).toFixed(2)}% in frame ${worst.frame} ` +
      `within card ${worst.measured?.card?.l}..${worst.measured?.card?.r}, ` +
      `rows ${worst.y0}..${worst.y1}`);
  // 한 걸음마다 16ms 이므로 이 끌기의 짧은 되돌아오기는 한 번의 표시보다 짧을 수 있다. 오래 머문 배치만 요구한다.
  assertHeldStatesShown(samples, run.ticks, run.boundary);
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: native content, cards, and the sidebar rail stay aligned`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    await keepCommonSettings(s);
    // 이 검사는 사이드바 위치 flow 의 레일 카드를 쓴다. 기본값은 inset 이다.
    await s.run("core.settings.set", { patch: { rail: "flow" }, scope: "common" });
    const marks = await shellMarks(s);
    const run = await drag(t, s, PLAN, { capture: true });
    const lag = assertAligned(run, marks);
    t.diagnostic(`pointer lag: worst ${lag.lag.toFixed(1)}ms, median ${lag.median.toFixed(1)}ms; transactions ${lag.stages}`);
    t.diagnostic(`page handling per step (ms), first 12: ${JSON.stringify(run.handled?.slice(0, 12))}, steps 40-51: ${JSON.stringify(run.handled?.slice(40, 52))}`);
  });

  test(`${app.name}: shell divider drag does not leave a white surface frame`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    await keepCommonSettings(s);
    // 이 검사는 사이드바 위치 flow 의 레일 카드와 셸 카드 사이 경계를 끈다. 기본값은 inset 이다.
    await s.run("core.settings.set", { patch: { rail: "flow" }, scope: "common" });
    const marks = await shellMarks(s);
    const narrow = await drag(t, s,
      { axis: "x", line: 2, dx: -500, dy: 0, ms: 96, times: 4 }, { capture: true });
    assertNoWhiteSurfaceBleed(narrow, "shell divider drag to narrow", marks);
    const wide = await drag(t, s,
      { axis: "x", line: 2, dx: 500, dy: 0, ms: 96, times: 4 }, { capture: true });
    assertNoWhiteSurfaceBleed(wide, "shell divider drag back to wide", marks);
  });
}
