import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { connect } from "@soksak/client";
import { startCasePlayer } from "@soksak/client/testing";
import { Session } from "@soksak/window-check/app.mjs";
import { failureWithSlowestPhase, phasedSession, slowestPhase, timePhase } from "../reload-phases.mjs";

const app = { name: "fixture", configDir: mkdtempSync(join(tmpdir(), "soksak-reload-phases-")) };
process.once("exit", () => rmSync(app.configDir, { recursive: true, force: true }));

/** The check session of the case `name`, on a client that is connected to the case player; closing the player fails when the case was not played. */
async function play(t, name) {
  const server = await startCasePlayer(name);
  t.after(() => server.close());
  const client = await connect({ configDir: server.configDir });
  t.after(() => client.close());
  return new Session(app, client);
}

test("a phased request names its phase by the command, the status read, the status waited for or the presentation", async (t) => {
  const phases = [];
  const requests = phasedSession(await play(t, "window-check-phases-session"), (phase) => phases.push(phase));
  assert.deepEqual(await requests.run("core.card.split", { card: "c1" }), { card: "c2" });
  assert.deepEqual(await requests.get("core.grid"), { cards: [] });
  const seen = [];
  assert.deepEqual(await requests.until("host.window", (value) => { seen.push(value); return true; }, "the resize did not arrive"),
    { width: 640 }, "a wait passes its predicate and message");
  assert.deepEqual(seen, [{ width: 640 }]);
  assert.deepEqual(await requests.presented(), { displayed: 5 });
  assert.deepEqual(phases.map(({ phase, ok, error }) => ({ phase, ok, error })), [
    { phase: "core.card.split", ok: true, error: null },
    { phase: "status core.grid", ok: true, error: null },
    { phase: "until host.window", ok: true, error: null },
    { phase: "host.window.presented", ok: true, error: null },
  ]);
  assert.ok(phases.every((phase) => Number.isInteger(phase.micros) && phase.micros >= 0), "a phase carries whole microseconds");
});

test("a failed request is a failed phase with its error, and the request still fails with that error", async (t) => {
  const phases = [];
  const requests = phasedSession(await play(t, "window-check-phases-reload-refused"), (phase) => phases.push(phase));
  const message = "fixture command.run host.window.reload: the reloaded page did not report ready";
  await assert.rejects(requests.run("host.window.reload"), (error) => error.code === 1005 && error.message === message);
  assert.deepEqual(phases.map(({ phase, ok, error }) => ({ phase, ok, error })), [{ phase: "host.window.reload", ok: false, error: message }]);
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
