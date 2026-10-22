// Runs the published call limit cases (packages/plugin-api/contract/calls.json) against createCalls of core. The time limit of a call
// is the timer of the call layer, so the runner drives the node:test mock timers and no case waits for real time. Each step
// sends or delivers a message, advances the clock or runs nothing, and reports the messages sent, the reports of the layer and the
// settled outcome of the request that a step watches.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createCalls } from "../calls.js";

const CONTRACT = JSON.parse(readFileSync(new URL("../contract/calls.json", import.meta.url), "utf8"));
const EXPECTED_IDS = [
  "calls.limit.default-limit-rejects-a-silent-call",
  "calls.limit.declared-timeout-replaces-the-default",
  "calls.limit.reply-after-limit-is-a-late-reply",
  "calls.limit.reply-in-time-resolves-and-clears-the-timer",
];

// Lets the promise chains of the call layer settle before a step reports its output.
const settle = async () => {
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve));
};

async function runCase(t, testCase) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
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
  const outputs = [];
  try {
    for (const step of testCase.steps) {
      if ("request" in step) {
        const { name, command, params, timeout } = step.request;
        const options = timeout === undefined ? {} : { timeout };
        calls.request(command, params, options).then(
          (value) => settled.set(name, { resolved: value }),
          (error) => settled.set(name, { rejected: error.message, code: error.code ?? null }),
        );
      } else if ("advance" in step) {
        t.mock.timers.tick(step.advance);
      } else if ("reply" in step) {
        for (const listener of [...listeners]) listener(step.reply);
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
  return outputs;
}

test("call limit contract publishes the required cases in order", () => {
  assert.deepEqual(CONTRACT.cases.map(({ id }) => id), EXPECTED_IDS);
});

for (const testCase of CONTRACT.cases) {
  test(`call limit ${testCase.id} matches each ordered step`, { timeout: 10000 }, async (t) => {
    const actual = await runCase(t, testCase);
    assert.deepEqual(actual, testCase.steps.map(({ output }) => output));
  });
}
