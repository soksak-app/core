// The gate of the external application surface (F192.3): an appview card runs the test application of the embed kit,
// which draws a frame every display interval into shared buffers, and the check moves the native pointer across it. From
// the records of every step it computes, per pointer move, the time from the native injection to the answer of the host
// for the first frame that shows that input, and the gaps between the frames that the host accepted:
//   native.record.info `input inject`              the native pointer move at window coordinates
//   host.trace.sidecar.send `input`                the page sends the pointer message with its input number
//   sidecar `input <n> <us>`                        the application received the input
//   sidecar `frame <sequence> input <n>`           the first frame that shows the input
//   host.trace.image.frame `consumed`              the host accepted the frame of that sequence
// The test application is the executable that SOKSAK_EMBED_TEST_APP names; the check fails with that name when it is not
// set. The check presses, drags and releases; each step waits for host.window.presented, so the steps follow the
// display and the check has no timer.
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { currentEventOffsets, eventLine, readEvents } from "@soksak/window-check/event-log.mjs";
import { fresh } from "./fixture.mjs";

const SIDECAR = "@soksak/sidecar-app";
const MOVES = 100;
const STEP = 3;
const INTERVAL_MS = 1000 / 60;
const percentile = (sorted, share) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))];
const summary = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return { count: sorted.length, median: percentile(sorted, 0.5), p90: percentile(sorted, 0.9), p99: percentile(sorted, 0.99), max: sorted.at(-1) };
};
const round = (value) => Number(value.toFixed(2));

for (const app of Object.values(APPS)) {
  test(`${app.name}: an appview card answers a native pointer drag within the gate`, { timeout: 180000 }, async (t) => {
    const program = process.env.SOKSAK_EMBED_TEST_APP;
    assert.ok(program, "SOKSAK_EMBED_TEST_APP is not set; it names the test application of the embed kit");
    const s = await open(t, app);
    assert.ok(s, `${app.binary} is not built`);
    await fresh(s, { performanceTrace: true, settings: { "appview.program": program } });
    const grid = await s.get("core.grid");
    const [card] = grid.cards.filter((item) => item.active).sort((a, b) => b.w * b.h - a.w * a.h);
    await s.run("core.card.split", { card: card.id, side: "right", plugin: "appview" });
    const [surface] = await s.until("core.surfaces",
      (surfaces) => surfaces.some((item) => item.visible && item.plugin === "appview" && item.exposes.includes("status appview.state")),
      "no visible appview surface registered appview.state").then(() => s.surfaces("appview"));
    await s.until("appview.state", (state) => state.toolkit !== null, "the application did not connect",
      { surface: surface.surface });
    const window = await s.until("host.window", (state) => state.regions.some((item) =>
      item.surface === surface.surface && item.name === "view" && item.frame?.width > MOVES * STEP + 40),
    "the appview region has no frame wide enough for the moves");
    const region = window.regions.find((item) => item.surface === surface.surface && item.name === "view");
    const y = region.frame.y + region.frame.height / 2;
    const offsets = currentEventOffsets(s.app.configDir);
    // A hover move needs the key window, which only an activation gives, so the check drags: a press, a drag step per
    // presentation and a release reach the view of an application that is not active.
    for (let move = 0; move < MOVES; move += 1) {
      await s.pointer(region.frame.x + 20 + move * STEP, y, move === 0 ? "down" : "drag");
      await s.presented();
    }
    await s.pointer(region.frame.x + 20 + (MOVES - 1) * STEP, y, "up");
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
    t.diagnostic(`${app.name} appview gate ${JSON.stringify(result)}`);
    console.log(`${app.name} appview gate ${JSON.stringify(result)}`);
    assert.ok(steps.length >= MOVES / 2, `only ${steps.length} of ${MOVES} moves have a record of every step: ${JSON.stringify(result)}`);
    assert.deepEqual(refused, [], `the host refused frames: ${JSON.stringify(refused.slice(0, 4))}`);
    assert.deepEqual(skipped, [], `the host answered no frame before sequences ${skipped.slice(0, 8).join(", ")}`);
    assert.ok(result.gaps.p99 <= 2 * INTERVAL_MS, `the p99 frame gap ${result.gaps.p99} ms exceeds two frames: ${JSON.stringify(result)}`);
    assert.ok(result.delay.median <= 25, `the median delay ${result.delay.median} ms exceeds 25 ms: ${JSON.stringify(result)}`);
    assert.ok(result.delay.p90 <= 40, `the p90 delay ${result.delay.p90} ms exceeds 40 ms: ${JSON.stringify(result)}`);
  });
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: an appview card follows a maximize and a restore of its window`, { timeout: 120000 }, async (t) => {
    const program = process.env.SOKSAK_EMBED_TEST_APP;
    assert.ok(program, "SOKSAK_EMBED_TEST_APP is not set; it names the application that the appview card runs");
    const s = await open(t, app);
    assert.ok(s, `${app.binary} is not built`);
    await fresh(s, { performanceTrace: true, settings: { "appview.program": program } });
    const grid = await s.get("core.grid");
    const [card] = grid.cards.filter((item) => item.active).sort((a, b) => b.w * b.h - a.w * a.h);
    await s.run("core.card.split", { card: card.id, side: "right", plugin: "appview" });
    await s.until("core.surfaces", (surfaces) => surfaces.some((item) => item.visible && item.plugin === "appview" &&
      item.exposes.includes("status appview.state")), "no visible appview surface registered appview.state");
    const [surface] = await s.surfaces("appview");
    await s.until("appview.state", (state) => state.toolkit !== null, "the application did not connect", { surface: surface.surface });
    // Each step waits until the window presents its new size with the region of the card; the time of each step is
    // recorded, and an error that the application logs during the steps fails the check.
    const steps = [];
    for (const on of [true, false, true, false]) {
      const started = performance.now();
      await s.run("host.window.maximize", { on });
      await s.presented();
      steps.push({ on, ms: Number((performance.now() - started).toFixed(1)) });
    }
    t.diagnostic(`${app.name} appview resize ${JSON.stringify(steps)}`);
    console.log(`${app.name} appview resize ${JSON.stringify(steps)}`);
    for (const step of steps) assert.ok(step.ms < 2000, `a ${step.on ? "maximize" : "restore"} took ${step.ms} ms: ${JSON.stringify(steps)}`);
  });
}
