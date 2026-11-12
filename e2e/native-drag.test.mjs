// A native drag of `diagnostics.drag` reaches the window as a person's drag: each round trip presses once, moves with the button
// held at each step and releases once, and each press follows the presentation of the current layout (docs/spec/endpoint.md).
// On a host whose workbench records the steps of its native callbacks (`host.frame.step`, the mygo host), the window received
// one mouseDown and one mouseUp for each round trip and one mouseDragged for each step; the page of a host whose workbench
// WebKit draws answers the steps that it applied. After the last input of the drag, the layout that the window keeps is sent
// within two display periods, and each view stands on its slot within 2 pt then and at the next presentation
// (docs/spec/native-surfaces.md).
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, drag, open } from "@soksak/window-check/app.mjs";
import { currentEventOffsets, readEvents } from "@soksak/window-check/event-log.mjs";
import { displayPeriod, lastInputConvergence } from "@soksak/window-check/layout-timing.mjs";
import { fresh } from "./fixture.mjs";

const PLAN = Object.freeze({ axis: "x", line: 2, dx: -120, dy: 0, ms: 400, times: 2, native: true });

for (const app of Object.values(APPS)) {
  test(`${app.name}: each round trip of a native drag presses once, moves at each step and releases once`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s, { log: { frame: "debug" }, reads: ["host.frame.step"] });
    const offsets = currentEventOffsets(app.configDir);
    const result = await drag(s, PLAN);
    const steps = Array.isArray(result.steps) ? result.steps.length : result.steps;
    t.diagnostic(`steps ${steps}, took ${result.took} ms for ${result.asked} ms, pressWaits ${JSON.stringify(result.pressWaits)}`);
    assert.ok(Array.isArray(result.pressWaits) && result.pressWaits.length === PLAN.times,
      `the drag reports ${JSON.stringify(result.pressWaits)} as the waits before its ${PLAN.times} presses`);
    assert.ok(Number.isInteger(steps) && steps > 0, `the drag answered ${JSON.stringify(result.steps)} as its steps`);
    if ((await s.get("host.window")).frames === null) return;
    await s.flushLog();
    const callbacks = readEvents(app.configDir, offsets).events
      .filter((event) => event.event === "host.frame.step" && event.fields?.kind === "selector")
      .map((event) => event.fields.callback);
    const count = (name) => callbacks.filter((callback) => callback === name).length;
    const received = { down: count("mouseDown:"), dragged: count("mouseDragged:"), up: count("mouseUp:") };
    t.diagnostic(`the window received ${JSON.stringify(received)}`);
    assert.deepEqual(received, { down: PLAN.times, dragged: steps, up: PLAN.times },
      `the window of ${app.name} received ${JSON.stringify(received)} for ${PLAN.times} round trips of ${steps} steps`);
  });

  test(`${app.name}: after the last input of a native drag the views stand on their slots within two display periods`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    const period = displayPeriod((await s.get("host.window")).refreshRate);
    const result = await drag(s, PLAN);
    const converged = lastInputConvergence(result.layouts, { lastInput: result.ticks.at(-1), period });
    t.diagnostic(`last input at ${result.ticks.at(-1)} ms, last layout sent at ${converged.settled} ms, ${converged.delay} ms later ` +
      `(limit ${converged.limit} ms), ${result.layouts.length} layout transactions`);
    assert.deepEqual(converged.failures, [], `the layout after the native drag of ${app.name}`);
    // The card and the native placement of a view are one layout transaction, so the slot that the page declared and the frame
    // that the host applied are the card edges and the content edges of the view.
    const apart = (declared, applied) => Math.max(Math.abs(applied.x - declared.x), Math.abs(applied.y - declared.y),
      Math.abs(applied.x + applied.w - (declared.x + declared.w)), Math.abs(applied.y + applied.h - (declared.y + declared.h)));
    for (const moment of ["after the drag", "at the next presentation"]) {
      if (moment !== "after the drag") await s.presented();
      const views = (await s.get("core.surfaces")).filter((row) => row.visible && row.declared && row.applied);
      assert.ok(views.length > 0, `no visible view has a slot ${moment}`);
      const off = views.filter((row) => apart(row.declared, row.applied) > 2)
        .map((row) => ({ surface: row.surface, declared: row.declared, applied: row.applied }));
      assert.deepEqual(off, [], `views whose content edges are more than 2 pt from their card edges ${moment}`);
    }
  });
}
