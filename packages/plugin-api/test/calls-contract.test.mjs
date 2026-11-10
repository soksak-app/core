// Runs the published call end cases (packages/plugin-api/contract/calls.json) against createCalls of core. A call has no time
// limit: each step sends a request, delivers a reply, aborts the signal of a request or ends the peer, and reports the messages
// sent, the reports of the layer and the settled outcome of the request that a step watches. No step moves a clock. The clock
// is fixed so that the start of a call and the delay of a late reply are 0, and the runner finds that the layer started no timer.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createCalls } from "../calls.js";

const CONTRACT = JSON.parse(readFileSync(new URL("../contract/calls.json", import.meta.url), "utf8"));
const EXPECTED_IDS = [
  "calls.end.reply-resolves-the-call",
  "calls.end.error-reply-rejects-with-its-code",
  "calls.end.cancel-ends-the-call-and-a-later-reply-is-late",
  "calls.end.peer-end-rejects-each-open-call",
];

// Lets the promise chains of the call layer settle before a step reports its output.
const settle = async () => {
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve));
};

async function runCase(t, testCase) {
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  const timers = t.mock.method(globalThis, "setTimeout");
  const sent = [];
  const reports = [];
  const listeners = new Set();
  const calls = createCalls({
    plugin: "probe",
    send: (message) => sent.push(structuredClone(message)),
    onMessage: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    report: (event) => reports.push(structuredClone(event)),
  });
  // The settled outcome of each named request: {resolved} or {rejected, code}; absent while the call is open.
  const settled = new Map();
  const signals = new Map();
  const outputs = [];
  try {
    for (const step of testCase.steps) {
      if ("request" in step) {
        const { name, command, params, signal } = step.request;
        const options = {};
        if (signal) {
          const controller = new AbortController();
          signals.set(name, controller);
          options.signal = controller.signal;
        }
        calls.request(command, params, options).then(
          (value) => settled.set(name, { resolved: value }),
          (error) => settled.set(name, { rejected: error.message, code: error.code ?? null }),
        );
      } else if ("reply" in step) {
        for (const listener of [...listeners]) listener(step.reply);
      } else if ("cancel" in step) {
        signals.get(step.cancel).abort();
      } else if ("peerLost" in step) {
        calls.peerLost(step.peerLost);
      } else {
        throw new Error(`unsupported call step ${Object.keys(step).join(", ")}`);
      }
      await settle();
      outputs.push({
        sent: sent.splice(0),
        reports: reports.splice(0),
        // A step with watch reports the settled outcome of the named request, or null while that call is open.
        outcome: step.watch ? settled.get(step.watch) ?? null : null,
      });
    }
  } finally {
    calls.close();
    t.mock.timers.reset();
  }
  // settle() makes no timer, so a timer is one that the call layer started.
  return { outputs, timers: timers.mock.callCount() };
}

test("call end contract publishes the required cases in order", () => {
  assert.deepEqual(CONTRACT.cases.map(({ id }) => id), EXPECTED_IDS);
});

test("call end contract steps neither move a clock nor declare a time limit", () => {
  for (const { id, steps } of CONTRACT.cases) {
    for (const step of steps) {
      assert.equal("advance" in step, false, `${id} moves a clock`);
      assert.equal(step.request !== undefined && "timeout" in step.request, false, `${id} declares a time limit`);
    }
  }
});

for (const testCase of CONTRACT.cases) {
  // contract: exposure.command.ends-by-reply-or-peer-end
  test(`call end ${testCase.id} matches each ordered step`, async (t) => {
    const { outputs, timers } = await runCase(t, testCase);
    assert.deepEqual(outputs, testCase.steps.map(({ output }) => output));
    assert.equal(timers, 0, "the call layer started a timer for a call");
  });
}
