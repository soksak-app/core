// Runs the published command registration cases (packages/plugin-api/contract/command-registration.json) against createExpose of
// core. Each case registers declared commands with run functions and forwards command.run requests from the host, and compares the
// registrations, replies, results and errors of each step with the published output.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createExpose } from "../index.js";

const CONTRACT = JSON.parse(readFileSync(new URL("../contract/command-registration.json", import.meta.url), "utf8"));
const EXPECTED_IDS = [
  "command.register.runs-declared-command-through-the-request",
  "command.register.answers-a-command-without-a-result-as-null",
];

// The run function of each behavior that a case names.
const BEHAVIORS = {
  echo: (params) => structuredClone(params),
  fail: () => { throw new Error("save failed"); },
  none: () => undefined,
};

// Lets every pending promise of the registration and reply chain settle before a step reports its output.
const settle = async () => {
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve));
};

async function runCase(testCase) {
  const registered = [];
  const replies = [];
  let request = null;
  const port = {
    onRequest(listener) {
      request = listener;
      return () => {};
    },
    reply(id, payload) {
      replies.push({ id, payload: structuredClone(payload) });
      return Promise.resolve();
    },
    register(kind, name) {
      registered.push({ kind, name });
      return Promise.resolve();
    },
    report() {},
  };
  const expose = createExpose(port, () => structuredClone(testCase.declarations));
  const outputs = [];
  for (const step of testCase.steps) {
    let result = null;
    let throws = null;
    try {
      if ("command" in step) {
        result = await expose.command(step.command.name, BEHAVIORS[step.command.behavior]);
      } else if ("request" in step) {
        request(structuredClone(step.request));
      } else {
        throw new Error(`unsupported command step ${Object.keys(step).join(", ")}`);
      }
    } catch (error) {
      throws = error.message;
    }
    await settle();
    outputs.push({ registered: registered.splice(0), replies: replies.splice(0), result: result ?? null, throws });
  }
  return outputs;
}

test("command registration contract publishes the required cases in order", () => {
  assert.deepEqual(CONTRACT.cases.map(({ id }) => id), EXPECTED_IDS);
});

for (const testCase of CONTRACT.cases) {
  test(`command registration ${testCase.id} matches each ordered step`, async () => {
    const actual = await runCase(testCase);
    assert.deepEqual(actual, testCase.steps.map(({ output }) => output));
  });
}
