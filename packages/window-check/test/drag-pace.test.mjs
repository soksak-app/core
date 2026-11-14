import assert from "node:assert/strict";
import test from "node:test";
import { drag, Session } from "../app.mjs";
import { playSession } from "../fixtures/endpoint-player.mjs";

// A drag that does not run at the asked rate measured nothing, and a second drag that does would make the check pass by
// chance, so the first drag that is not paced fails the check with the values that tell its cause. Each case holds one drag
// request: a second request fails the player.
const plan = { axis: "x", line: 0, dx: 10, dy: 0, ms: 400, times: 2 };

test("a drag that is not paced fails at once with its took, asked, press waits, range and load", { timeout: 5000 }, async (t) => {
  const { session } = await playSession(t, Session, "window-check-drag-slow", "mygo");
  const failure = await drag(session, plan).then(() => null, (error) => error.message);
  assert.notEqual(failure, null, "a drag that took 1700ms for 800ms passed");
  assert.match(failure, /took 1700ms for 800ms/);
  assert.match(failure, /between 640ms and 1000ms/);
  assert.match(failure, /pressWaits \[4,31\]/);
  assert.match(failure, /handled 703ms in 3 steps, the longest 400ms/);
  assert.match(failure, /delivered presses in 21ms, the longest 12ms, steps in 24ms, the longest 20ms, releases in 23ms, the longest 15ms/);
  assert.match(failure, /1-minute load average \d+(\.\d+)?/);
  assert.match(failure, /a slow drag passing is not a pass/);
});

test("a drag that is paced passes after one gesture", { timeout: 5000 }, async (t) => {
  const { session } = await playSession(t, Session, "window-check-drag-paced", "mygo");
  const result = await drag(session, plan);
  assert.equal(result.took, 900);
});

test("a drag that is not paced and reports no handling says so", { timeout: 5000 }, async (t) => {
  const { session } = await playSession(t, Session, "window-check-drag-slow-unreported", "mygo");
  const failure = await drag(session, plan).then(() => null, (error) => error.message);
  assert.match(failure, /handled not reported/);
  assert.match(failure, /deliveries not reported/);
});
