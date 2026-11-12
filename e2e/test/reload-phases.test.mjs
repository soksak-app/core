import assert from "node:assert/strict";
import test from "node:test";

import { failureWithSlowestPhase, phasedSession, slowestPhase, timePhase } from "../reload-phases.mjs";

/** A session whose requests answer with their name and arguments, and whose request named `failing` fails with `message`. */
function fakeSession(failing, message) {
  const answer = (method, args) => (args[0] === failing ? Promise.reject(new Error(message)) : Promise.resolve({ method, args }));
  return {
    run: (...args) => answer("run", args),
    get: (...args) => answer("get", args),
    until: (...args) => answer("until", args),
    presented: () => answer("presented", []),
  };
}

test("a phased request names its phase by the command, the status read, the status waited for or the presentation", async () => {
  const phases = [];
  const requests = phasedSession(fakeSession(null), (phase) => phases.push(phase));
  const predicate = () => true;
  assert.deepEqual(await requests.run("core.card.split", { card: "c1" }), { method: "run", args: ["core.card.split", { card: "c1" }] });
  assert.deepEqual(await requests.get("core.grid"), { method: "get", args: ["core.grid"] });
  assert.deepEqual(await requests.until("host.window", predicate, "the resize did not arrive"),
    { method: "until", args: ["host.window", predicate, "the resize did not arrive"] }, "a wait passes its predicate and message");
  await requests.presented();
  assert.deepEqual(phases.map(({ phase, ok, error }) => ({ phase, ok, error })), [
    { phase: "core.card.split", ok: true, error: null },
    { phase: "status core.grid", ok: true, error: null },
    { phase: "until host.window", ok: true, error: null },
    { phase: "host.window.presented", ok: true, error: null },
  ]);
  assert.ok(phases.every((phase) => Number.isInteger(phase.micros) && phase.micros >= 0), "a phase carries whole microseconds");
});

test("a failed request is a failed phase with its error, and the request still fails with that error", async () => {
  const phases = [];
  const requests = phasedSession(fakeSession("host.window.reload", "1005: the reloaded page did not report ready"),
    (phase) => phases.push(phase));
  await assert.rejects(requests.run("host.window.reload"), /^Error: 1005: the reloaded page did not report ready$/);
  assert.deepEqual(phases.map(({ phase, ok, error }) => ({ phase, ok, error })),
    [{ phase: "host.window.reload", ok: false, error: "1005: the reloaded page did not report ready" }]);
});

test("a phase is recorded when its request answers, not when it is sent", async () => {
  const phases = [];
  let answer;
  const pending = timePhase("host.window.presented", () => new Promise((resolve) => { answer = resolve; }), (phase) => phases.push(phase));
  assert.deepEqual(phases, [], "a request without its answer has no phase yet");
  answer("done");
  assert.equal(await pending, "done");
  assert.deepEqual(phases.map(({ phase, ok }) => ({ phase, ok })), [{ phase: "host.window.presented", ok: true }]);
});

test("a phase without a name is refused", async () => {
  await assert.rejects(timePhase("", () => Promise.resolve(), () => {}), /a phase needs a name/);
});

test("the slowest phase is the phase with the greatest micros, and the first of equal ones", () => {
  const phases = [
    { phase: "core.card.split", micros: 40000, ok: true, error: null },
    { phase: "host.window.reload", micros: 2100000, ok: true, error: null },
    { phase: "host.window.presented", micros: 2100000, ok: true, error: null },
  ];
  assert.equal(slowestPhase(phases).phase, "host.window.reload");
  assert.equal(slowestPhase([]), null, "no phase has no slowest phase");
});

test("a failure names the slowest phase and its time in its message and keeps the original error as its cause", () => {
  const original = new Error("stress round 3 did not finish");
  const phases = [
    { phase: "core.card.split", micros: 40000, ok: true, error: null },
    { phase: "host.window.presented", micros: 117800, ok: true, error: null },
  ];
  const named = failureWithSlowestPhase(original, phases);
  assert.equal(named.message, "stress round 3 did not finish; slowest phase host.window.presented took 118 ms");
  assert.equal(named.cause, original);
  assert.equal(failureWithSlowestPhase(original, []).message, "stress round 3 did not finish; no phase was timed");
});
