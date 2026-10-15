// The gate of the external application surface (F194.3): the card of the connector plugin (connector-fixture.mjs) runs
// the test application of the embed kit,
// which draws a frame every display interval into shared buffers, and the check moves the native pointer across it. From
// the records of every step it computes, per pointer move, the time from the native injection to the answer of the host
// for the first frame that shows that input, and the gaps between the frames that the host accepted:
//   native.record.info `input inject`              the native pointer move at window coordinates
//   host.trace.sidecar.send `input`                the page sends the pointer message with its input number
//   sidecar `input <n> <us>`                        the application received the input
//   sidecar `frame <sequence> input <n>`           the first frame that shows the input
//   host.trace.image.frame `consumed`              the host accepted the frame of that sequence
// The application is the executable that SOKSAK_EMBED_TEST_APP names; the check fails with that name when it is not set.
// SOKSAK_EMBED_TEST_ARGS gives its arguments as a JSON array (default none), and SOKSAK_EMBED_DRAG_X and
// SOKSAK_EMBED_DRAG_Y the start of the drag as shares of the region from its left and top (default 0.05 and 0.5), so a
// drag runs over a part of the application that changes under it. The card is shown full screen, and the drag runs to
// 0.95 of the width of the region. The check presses, drags and releases; each step waits for host.window.presented, so the steps follow the
// display and the check has no timer.
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { currentEventOffsets, eventLine, readEvents } from "@soksak/window-check/event-log.mjs";
import { PLUGIN, connectApplication } from "./connector-fixture.mjs";
import { fresh } from "./fixture.mjs";

const SIDECAR = "@soksak/sidecar-app";
const MOVES = 100;
const INTERVAL_MS = 1000 / 60;
const percentile = (sorted, share) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))];
const summary = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return { count: sorted.length, median: percentile(sorted, 0.5), p90: percentile(sorted, 0.9), p99: percentile(sorted, 0.99), max: sorted.at(-1) };
};
const round = (value) => Number(value.toFixed(2));
const ARGS = process.env.SOKSAK_EMBED_TEST_ARGS ?? "[]";
const DRAG_Y = Number(process.env.SOKSAK_EMBED_DRAG_Y ?? "0.5");
const DRAG_X = Number(process.env.SOKSAK_EMBED_DRAG_X ?? "0.05");

for (const app of Object.values(APPS)) {
  test(`${app.name}: the card of the connector plugin answers a native pointer drag within the gate`, { timeout: 180000 }, async (t) => {
    const program = process.env.SOKSAK_EMBED_TEST_APP;
    assert.ok(program, "SOKSAK_EMBED_TEST_APP is not set; it names the test application of the embed kit");
    const s = await open(t, app);
    assert.ok(s, `${app.binary} is not built`);
    await fresh(s, { performanceTrace: true });
    await connectApplication(s, program, { place: false });
    await s.run("core.settings.set", { patch: { [`${PLUGIN}.arguments`]: ARGS } });
    const grid = await s.get("core.grid");
    const [card] = grid.cards.filter((item) => item.active).sort((a, b) => b.w * b.h - a.w * a.h);
    await s.run("core.card.split", { card: card.id, side: "right", plugin: PLUGIN });
    const owner = (await s.get("core.grid")).cards.find((item) => item.tabs.some((tab) => tab.plugin === PLUGIN));
    await s.run("core.card.fullscreen", { card: owner.id });
    const [surface] = await s.until("core.surfaces",
      (surfaces) => surfaces.some((item) => item.visible && item.plugin === PLUGIN && item.exposes.includes(`status ${PLUGIN}.state`)),
      `no visible surface of ${PLUGIN} registered ${PLUGIN}.state`).then(() => s.surfaces(PLUGIN));
    await s.until(`${PLUGIN}.state`, (state) => state.toolkit !== null, "the application did not connect",
      { surface: surface.surface });
    const window = await s.until("host.window", (state) => state.regions.some((item) =>
      item.surface === surface.surface && item.name === "view" && item.frame?.width >= 600),
    "the region of the full-screen card is not 600 points wide");
    const region = window.regions.find((item) => item.surface === surface.surface && item.name === "view");
    assert.ok(DRAG_Y > 0 && DRAG_Y < 1, `SOKSAK_EMBED_DRAG_Y is ${process.env.SOKSAK_EMBED_DRAG_Y}, not a share between 0 and 1`);
    assert.ok(DRAG_X > 0 && DRAG_X < 0.9, `SOKSAK_EMBED_DRAG_X is ${process.env.SOKSAK_EMBED_DRAG_X}, not a share between 0 and 0.9`);
    // Whole points between the moves, so each move has its own position in the records.
    const step = Math.floor((region.frame.width * (0.95 - DRAG_X)) / MOVES);
    assert.ok(step >= 1, `the region is ${region.frame.width} points wide, too narrow for ${MOVES} moves`);
    const startX = Math.round(region.frame.x + region.frame.width * DRAG_X);
    const y = region.frame.y + region.frame.height * DRAG_Y;
    const offsets = currentEventOffsets(s.app.configDir);
    // A hover move needs the key window, which only an activation gives, so the check drags: a press, a drag step per
    // presentation and a release reach the view of an application that is not active.
    for (let move = 0; move < MOVES; move += 1) {
      await s.pointer(startX + move * step, y, move === 0 ? "down" : "drag");
      await s.presented();
    }
    await s.pointer(startX + (MOVES - 1) * step, y, "up");
    // The writer stores events in batches, so the records of the last moves can be missing; the check counts only the moves
    // that have a record of every step and requires at least half of them.
    const { events } = readEvents(s.app.configDir, offsets);
    const injected = new Map();
    const sends = new Map();
    const shown = new Map();
    const received = new Map();
    const consumed = new Map();
    const refused = [];
    for (const event of events) {
      if (event.event === "native.record.info" && event.fields?.where === "input inject") {
        const input = JSON.parse(event.fields.text);
        // The release repeats the position of the last drag step, so the first injection at a position is kept.
        const local = Math.round(input.x - region.frame.x);
        if (input.kind === "pointer" && input.result === "delivered" && !injected.has(local)) injected.set(local, event.ts_us);
      } else if (event.event === "host.trace.sidecar.send" && event.fields?.sidecar === SIDECAR && event.fields.body?.operation === "input" &&
        event.fields.body.message?.type === "pointer") {
        if (event.fields.body.message.phase === "up") continue;
        sends.set(event.fields.body.message.input, { x: Math.round(event.fields.body.message.x), ts: event.ts_us });
      } else if (event.event === "host.trace.image.frame" && event.fields?.surface === surface.surface) {
        const image = event.fields.response?.image;
        if (image?.consumed) consumed.set(image.consumed.sequence, event.ts_us);
        else refused.push(image);
      } else if (event.layer === "sidecar") {
        const line = eventLine(event);
        const frame = /: frame (\d+) input (\d+)$/.exec(line);
        if (frame) shown.set(Number(frame[2]), Number(frame[1]));
        const input = /: input (\d+) (\d+)$/.exec(line);
        if (input) received.set(Number(input[1]), Number(input[2]));
      }
    }
    // Each step of every input whose first frame the host accepted, in milliseconds after the native injection.
    const steps = [];
    for (const [input, send] of sends) {
      const native = injected.get(send.x);
      const sequence = shown.get(input);
      const answer = consumed.get(sequence);
      if (native === undefined || answer === undefined) continue;
      steps.push({ input, page: (send.ts - native) / 1000, application: ((received.get(input) ?? NaN) - native) / 1000,
        host: (answer - native) / 1000 });
    }
    const sequences = [...consumed.keys()].sort((a, b) => a - b);
    const gaps = sequences.slice(1).map((sequence, index) => (consumed.get(sequence) - consumed.get(sequences[index])) / 1000);
    const skipped = sequences.slice(1).filter((sequence, index) => sequence !== sequences[index] + 1);
    const result = {
      moves: MOVES, injected: injected.size, inputs: sends.size, measured: steps.length, refused: refused.length, skipped: skipped.length,
      delay: Object.fromEntries(Object.entries(summary(steps.map((step) => step.host))).map(([key, value]) => [key, round(value)])),
      page: round(summary(steps.map((step) => step.page)).median),
      application: round(summary(steps.map((step) => step.application)).median),
      gaps: Object.fromEntries(Object.entries(summary(gaps)).map(([key, value]) => [key, round(value)])),
    };
    t.diagnostic(`${app.name} application gate ${JSON.stringify(result)}`);
    console.log(`${app.name} application gate ${JSON.stringify(result)}`);
    assert.ok(steps.length >= MOVES / 2, `only ${steps.length} of ${MOVES} moves have a record of every step: ${JSON.stringify(result)}`);
    assert.deepEqual(refused, [], `the host refused frames: ${JSON.stringify(refused.slice(0, 4))}`);
    assert.deepEqual(skipped, [], `the host answered no frame before sequences ${skipped.slice(0, 8).join(", ")}`);
    assert.ok(result.gaps.p99 <= 2 * INTERVAL_MS, `the p99 frame gap ${result.gaps.p99} ms exceeds two frames: ${JSON.stringify(result)}`);
    assert.ok(result.delay.median <= 25, `the median delay ${result.delay.median} ms exceeds 25 ms: ${JSON.stringify(result)}`);
    assert.ok(result.delay.p90 <= 40, `the p90 delay ${result.delay.p90} ms exceeds 40 ms: ${JSON.stringify(result)}`);
  });
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: the card of the connector plugin follows a maximize and a restore of its window`, { timeout: 120000 }, async (t) => {
    const program = process.env.SOKSAK_EMBED_TEST_APP;
    assert.ok(program, "SOKSAK_EMBED_TEST_APP is not set; it names the application that the card of the connector plugin runs");
    const s = await open(t, app);
    assert.ok(s, `${app.binary} is not built`);
    await fresh(s, { performanceTrace: true });
    await connectApplication(s, program, { place: false });
    await s.run("core.settings.set", { patch: { [`${PLUGIN}.arguments`]: ARGS } });
    const grid = await s.get("core.grid");
    const [card] = grid.cards.filter((item) => item.active).sort((a, b) => b.w * b.h - a.w * a.h);
    await s.run("core.card.split", { card: card.id, side: "right", plugin: PLUGIN });
    await s.until("core.surfaces", (surfaces) => surfaces.some((item) => item.visible && item.plugin === PLUGIN &&
      item.exposes.includes(`status ${PLUGIN}.state`)), `no visible surface of ${PLUGIN} registered ${PLUGIN}.state`);
    const [surface] = await s.surfaces(PLUGIN);
    await s.until(`${PLUGIN}.state`, (state) => state.toolkit !== null, "the application did not connect", { surface: surface.surface });
    // Each step waits until the window presents its new size with the region of the card; the time of each step is
    // recorded, and an error that the application logs during the steps fails the check.
    const steps = [];
    for (const on of [true, false, true, false]) {
      const started = performance.now();
      await s.run("host.window.maximize", { on });
      await s.presented();
      steps.push({ on, ms: Number((performance.now() - started).toFixed(1)) });
    }
    t.diagnostic(`${app.name} application resize ${JSON.stringify(steps)}`);
    console.log(`${app.name} application resize ${JSON.stringify(steps)}`);
    for (const step of steps) assert.ok(step.ms < 2000, `a ${step.on ? "maximize" : "restore"} took ${step.ms} ms: ${JSON.stringify(steps)}`);
  });
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: the card of the connector plugin plays at the rate of the display`, { timeout: 120000 }, async (t) => {
    const program = process.env.SOKSAK_EMBED_TEST_APP;
    assert.ok(program, "SOKSAK_EMBED_TEST_APP is not set; it names the application that the card of the connector plugin runs");
    // SOKSAK_EMBED_PLAY names the control that starts playback as shares of the region, `<x>,<y>`.
    const play = process.env.SOKSAK_EMBED_PLAY;
    if (play === undefined) return t.skip("SOKSAK_EMBED_PLAY names no control that starts playback");
    const [shareX, shareY] = play.split(",").map(Number);
    assert.ok(shareX > 0 && shareX < 1 && shareY > 0 && shareY < 1, `SOKSAK_EMBED_PLAY is ${play}, not two shares between 0 and 1`);
    const s = await open(t, app);
    assert.ok(s, `${app.binary} is not built`);
    await fresh(s, { performanceTrace: true });
    await connectApplication(s, program, { place: false });
    await s.run("core.settings.set", { patch: { [`${PLUGIN}.arguments`]: ARGS } });
    const grid = await s.get("core.grid");
    const [card] = grid.cards.filter((item) => item.active).sort((a, b) => b.w * b.h - a.w * a.h);
    await s.run("core.card.split", { card: card.id, side: "right", plugin: PLUGIN });
    const owner = (await s.get("core.grid")).cards.find((item) => item.tabs.some((tab) => tab.plugin === PLUGIN));
    await s.run("core.card.fullscreen", { card: owner.id });
    await s.until("core.surfaces", (surfaces) => surfaces.some((item) => item.visible && item.plugin === PLUGIN &&
      item.exposes.includes(`status ${PLUGIN}.state`)), `no visible surface of ${PLUGIN} registered ${PLUGIN}.state`);
    const [surface] = await s.surfaces(PLUGIN);
    await s.until(`${PLUGIN}.state`, (state) => state.toolkit !== null, "the application did not connect", { surface: surface.surface });
    const window = await s.until("host.window", (state) => state.regions.some((item) =>
      item.surface === surface.surface && item.name === "view" && item.frame?.width >= 600),
    "the region of the full-screen card is not 600 points wide");
    const region = window.regions.find((item) => item.surface === surface.surface && item.name === "view");
    const x = Math.round(region.frame.x + region.frame.width * shareX);
    const y = Math.round(region.frame.y + region.frame.height * shareY);
    await s.pointer(x, y, "down");
    await s.pointer(x, y, "up");
    const offsets = currentEventOffsets(s.app.configDir);
    // About three seconds of playback, counted in presentations of the window, so the check has no timer.
    for (let frame = 0; frame < 180; frame += 1) await s.presented();
    await s.pointer(x, y, "down");
    await s.pointer(x, y, "up");
    const { events } = readEvents(s.app.configDir, offsets);
    const accepted = [];
    const refused = [];
    for (const event of events) {
      if (event.event !== "host.trace.image.frame" || event.fields?.surface !== surface.surface) continue;
      const image = event.fields.response?.image;
      if (image?.consumed) accepted.push({ sequence: image.consumed.sequence, ts: event.ts_us });
      else refused.push(image);
    }
    const gaps = accepted.slice(1).map((frame, index) => (frame.ts - accepted[index].ts) / 1000);
    const skipped = accepted.slice(1).filter((frame, index) => frame.sequence !== accepted[index].sequence + 1);
    const result = { frames: accepted.length, refused: refused.length, skipped: skipped.length,
      gaps: Object.fromEntries(Object.entries(summary(gaps)).map(([key, value]) => [key, round(value)])) };
    t.diagnostic(`${app.name} application playback ${JSON.stringify(result)}`);
    console.log(`${app.name} application playback ${JSON.stringify(result)}`);
    assert.ok(accepted.length >= 90, `only ${accepted.length} frames came during about three seconds of playback: ${JSON.stringify(result)}`);
    assert.deepEqual(refused, [], `the host refused frames: ${JSON.stringify(refused.slice(0, 4))}`);
    assert.deepEqual(skipped.map((frame) => frame.sequence), [], "the host answered no frame before these sequences");
    assert.ok(result.gaps.p99 <= 2 * INTERVAL_MS, `the p99 frame gap ${result.gaps.p99} ms exceeds two frames: ${JSON.stringify(result)}`);
  });
}
