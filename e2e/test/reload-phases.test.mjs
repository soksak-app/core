import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { currentEventOffsets } from "@soksak/window-check/event-log.mjs";
import { failureWithSlowestPhase, readPhases, slowestPhase } from "../reload-phases.mjs";

/** A configuration folder whose host event log holds the lines, numbered by seq; it is removed when the test ends. */
function configFolder(t, lines) {
  const configDir = mkdtempSync(join(tmpdir(), "reload-phases-"));
  t.after(() => rmSync(configDir, { recursive: true, force: true }));
  mkdirSync(join(configDir, "logs"));
  writeFile(configDir, lines, 0);
  return configDir;
}

const LOG = (configDir) => join(configDir, "logs", "host-100-200.jsonl");

function writeFile(configDir, lines, firstSeq) {
  const text = lines.map((line, index) => `${JSON.stringify({ ts_us: 1000 + index, seq: firstSeq + index + 1, ...line })}\n`).join("");
  writeFileSync(LOG(configDir), text, { flag: firstSeq === 0 ? "w" : "a" });
}

/** A host event of an endpoint request, as the host writes it (docs/spec/logging.md#entrances). */
const endpointCall = (fields) => ({ level: "debug", layer: "host", event: "host.endpoint.call", fields });

test("a command request reads the command name from its args as the phase, and another request reads its method", (t) => {
  const configDir = configFolder(t, [
    { level: "info", layer: "host", event: "log.open", fields: { pid: 200, role: "host" } },
    endpointCall({ name: "command.run", args: JSON.stringify({ name: "core.card.split", params: { card: "terminal" } }), micros: 42000, ok: true }),
    endpointCall({ name: "status.get", args: JSON.stringify({ name: "core.grid" }), micros: 900, ok: true }),
    endpointCall({ name: "command.run", args: JSON.stringify({ name: "host.window.reload", params: {} }), micros: 2100000, ok: false,
      error: "1005: the reloaded page did not report ready within 10s" }),
    { level: "info", layer: "host", event: "host.window.event", fields: { window: "main", kind: "focus" } },
  ]);
  const { phases } = readPhases(configDir, {});
  assert.deepEqual(phases.map(({ phase, micros, ok, error }) => ({ phase, micros, ok, error })), [
    { phase: "core.card.split", micros: 42000, ok: true, error: null },
    { phase: "status.get", micros: 900, ok: true, error: null },
    { phase: "host.window.reload", micros: 2100000, ok: false, error: "1005: the reloaded page did not report ready within 10s" },
  ]);
  assert.ok(phases.every((phase) => Number.isInteger(phase.seq)), "a phase carries the seq of its event");
});

test("the flush that a read sends is not a phase of the check", (t) => {
  const configDir = configFolder(t, [
    endpointCall({ name: "diagnostics.log.flush", args: null, micros: 800, ok: true }),
    endpointCall({ name: "command.run", args: JSON.stringify({ name: "core.card.close", params: { card: "browser" } }), micros: 9000, ok: true }),
  ]);
  assert.deepEqual(readPhases(configDir, {}).phases.map((phase) => phase.phase), ["core.card.close"]);
});

test("a read starts after the offsets, so a phase that an earlier read returned is not returned again", (t) => {
  const configDir = configFolder(t, [
    endpointCall({ name: "command.run", args: JSON.stringify({ name: "host.window.resize", params: {} }), micros: 5000, ok: true }),
  ]);
  const start = currentEventOffsets(configDir);
  writeFile(configDir, [endpointCall({ name: "command.run", args: JSON.stringify({ name: "host.window.presented", params: {} }),
    micros: 70000, ok: true })], 1);
  const first = readPhases(configDir, start);
  assert.deepEqual(first.phases.map((phase) => phase.phase), ["host.window.presented"]);
  assert.deepEqual(readPhases(configDir, first.offsets).phases, [], "a read that follows the previous read returns no phase");
});

test("a command request whose args are truncated is refused with the seq of its event", (t) => {
  const configDir = configFolder(t, [
    endpointCall({ name: "command.run", args: '{"name":"core.card.split","params":{"card":"', micros: 1000, ok: true, truncated: true }),
  ]);
  assert.throws(() => readPhases(configDir, {}), /seq 1: .*truncated/);
});

test("the slowest phase is the phase with the greatest micros, and the first of equal ones", () => {
  const phases = [
    { seq: 1, phase: "core.card.split", micros: 40000, ok: true, error: null },
    { seq: 2, phase: "host.window.reload", micros: 2100000, ok: true, error: null },
    { seq: 3, phase: "host.window.presented", micros: 2100000, ok: true, error: null },
  ];
  assert.equal(slowestPhase(phases).seq, 2);
  assert.equal(slowestPhase([]), null, "no phase has no slowest phase");
});

test("a failure names the slowest phase and its time in its message and keeps the original error as its cause", () => {
  const original = new Error("stress round 3 did not finish");
  const phases = [
    { seq: 1, phase: "core.card.split", micros: 40000, ok: true, error: null },
    { seq: 2, phase: "host.window.presented", micros: 117800, ok: true, error: null },
  ];
  const named = failureWithSlowestPhase(original, phases);
  assert.equal(named.message, "stress round 3 did not finish; slowest phase host.window.presented took 118 ms");
  assert.equal(named.cause, original);
  assert.equal(failureWithSlowestPhase(original, []).message, "stress round 3 did not finish; no host.endpoint.call phase was read");
});

test("the phase of a command request is the command name that the check runs", (t) => {
  const configDir = configFolder(t, [
    endpointCall({ name: "command.run", args: JSON.stringify({ name: "host.window.reload", params: {} }), micros: 300000, ok: true }),
  ]);
  const { phases } = readPhases(configDir, {});
  assert.equal(failureWithSlowestPhase(new Error("x"), phases).message, "x; slowest phase host.window.reload took 300 ms");
});
