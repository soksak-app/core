// 250pt를 400ms에 이동하는 두 왕복을 녹화해 표면의 카드 내부 표시를 검사한다.
import assert from "node:assert/strict";
import { availableParallelism, loadavg } from "node:os";
import test from "node:test";

import { APPS, drag, keepCommonSettings, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";
import { frames, readFrame } from "@soksak/window-check/frame.mjs";
import { outside, terminalMarks, whitePixels } from "./outside.mjs";
import { alignment, alignmentDelta } from "./alignment.mjs";
import { assertHeldStatesShown, assertRoundTrips, lagStages, pointerLag, transactionCadence } from "./drag-measurement.mjs";

// 1번 세로 선은 왼쪽 고정 사이드바와 터미널 카드 사이 경계다. 끌면 터미널 카드의 왼쪽 가장자리가 움직인다.
const PLAN = { axis: "x", line: 1, dx: 250, dy: 0, ms: 400, times: 2 };

const READ = 0.5;

// 격자가 한 배치를 떠난 뒤 그 배치가 화면에 남아 있어도 되는 시간. 화면 갱신 주기의 프레임 수다
// (docs/spec/native-surfaces.md). 표시는 입력 도착, 이전 배치의 프레임, WebKit 렌더링 갱신, 화면 vsync 의 경계를
// 지나므로 최대는 4 프레임이고, 평소 지연은 중앙값 2.5 프레임과 p90 3 프레임 안에 있다.
const LAG_FRAMES = { median: 2.5, p90: 3, worst: 4 };

function assertAligned(run, marks, refreshRate) {
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
    const delta = alignmentDelta(initial, geometry);
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
  assert.ok(Number.isFinite(refreshRate) && refreshRate > 0, `the display refresh rate is unknown (${refreshRate})`);
  const frame = 1000 / refreshRate;
  const over = Object.entries(LAG_FRAMES).filter(([key, frames]) => (key === "worst" ? lag.lag : lag[key]) > frames * frame);
  assert.deepEqual(over.map(([key]) => key), [],
    `the card showed a layout ${lag.lag.toFixed(1)}ms after the grid left it (limits at ${refreshRate}Hz: median ` +
      `${(LAG_FRAMES.median * frame).toFixed(1)}ms, p90 ${(LAG_FRAMES.p90 * frame).toFixed(1)}ms, worst ${(LAG_FRAMES.worst * frame).toFixed(1)}ms): ` +
      `offset ${lag.shown?.toFixed(1)}pt at ${lag.time?.toFixed(1)}ms matches step ${lag.step} while step ${lag.sent} was sent; ` +
      `median ${lag.median.toFixed(1)}ms, p90 ${lag.p90.toFixed(1)}ms; ` +
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
    assert.ok(measured, `${message}: terminal/card geometry could not be measured in frame ${frameIndex}`);
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
    // 터미널의 오른쪽 오버라이드가 고정 사이드바와 레일을 터미널 카드에 묶는다.
    await keepCommonSettings(s);
    await s.run("core.settings.link", { place: "window-right", plugin: "terminal", set: "set-install", scope: "common" });
    await s.until("core.rail", (rail) => rail.groups.length === 1, "the terminal override drew no rail");
    const marks = await terminalMarks(s, { measured: true });
    const run = await drag(t, s, PLAN, { capture: true });
    // 트랜잭션 주기는 지연 판정 전에 알린다. 판정이 실패해도 그 주기가 출력에 남는다(F92).
    t.diagnostic(`transaction cadence (ms): ${JSON.stringify(transactionCadence(run.layouts))}`);
    const lag = assertAligned(run, marks, (await s.get("host.window")).refreshRate);
    t.diagnostic(`pointer lag: worst ${lag.lag.toFixed(1)}ms, p90 ${lag.p90.toFixed(1)}ms, median ${lag.median.toFixed(1)}ms; transactions ${lag.stages}`);
    t.diagnostic(`page handling per step (ms), first 12: ${JSON.stringify(run.handled?.slice(0, 12))}, steps 40-51: ${JSON.stringify(run.handled?.slice(40, 52))}`);
  });

  test(`${app.name}: terminal divider drag does not leave a white surface frame`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    // 왼쪽 고정 사이드바와 터미널 카드 사이 경계를 끈다.
    const marks = await terminalMarks(s, { measured: true });
    const narrow = await drag(t, s,
      { axis: "x", line: 1, dx: 290, dy: 0, ms: 96, times: 4 }, { capture: true });
    assertNoWhiteSurfaceBleed(narrow, "terminal divider drag to narrow", marks);
    const wide = await drag(t, s,
      { axis: "x", line: 1, dx: -70, dy: 0, ms: 96, times: 4 }, { capture: true });
    assertNoWhiteSurfaceBleed(wide, "terminal divider drag back to wide", marks);
  });
}

// 터미널 표면은 카드와 같은 색이므로 픽셀로는 네이티브 자리와 문서의 폭을 가를 수 없다. 표면 문서가 알리는 크기
// (core.surface.document)와 호스트가 앉힌 네이티브 자리(host.window)를 비교한다.
async function assertDocumentFillsFrame(s, surface, label) {
  await s.presented();
  const frame = (await s.get("host.window")).surfaces.find((item) => item.id === surface)?.frame;
  assert.ok(frame?.width > 0, `${label}: the terminal surface ${surface} has no native frame`);
  const { body, viewport } = await s.get("core.surface.document", surface);
  for (const [name, size] of [["body", body], ["viewport", viewport]]) {
    assert.ok(Math.abs(size.width - frame.width) <= 0.5 && Math.abs(size.height - frame.height) <= 0.5,
      `${label}: the terminal document ${name} is ${size.width}×${size.height} in a native frame of ${frame.width}×${frame.height}`);
  }
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: the terminal document fills its native frame before and after a divider drag`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const surface = (await s.get("core.grid")).cards.find((card) => card.id === "terminal").active;
    await assertDocumentFillsFrame(s, surface, "at rest");
    await drag(t, s, { axis: "x", line: 1, dx: 250, dy: 0, ms: 96, times: 1 });
    await assertDocumentFillsFrame(s, surface, "after the drag");
  });
}
