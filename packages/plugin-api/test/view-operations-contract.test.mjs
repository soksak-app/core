// Runs the published view operation cases (packages/plugin-api/contract/view-operations.json) against runtime.beginOperation,
// runtime.sidecar(name).send and runtime.command of createViewBridge over a jsdom window on sok://probe/. Each step starts an
// operation, sends with the identifiers of a stored operation, or runs a command with them, and compares the messages the page
// posted, the result and the error with the published output.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createViewBridge } from "../view.js";

const CONTRACT = JSON.parse(readFileSync(new URL("../contract/view-operations.json", import.meta.url), "utf8"));
const EXPECTED_IDS = [
  "view.operation.begin-logs-first-event-and-carries-cids",
  "view.operation.each-begin-takes-the-next-identifier",
];
// The time origin of the page that the view module reads: the identifiers of the output name it as $ORIGIN.
const ORIGIN = Math.round(performance.timeOrigin);
const IDENTIFIER = /^p\d+\.\d+$/;

// Lets every pending promise of the call layer settle before a step reports its output.
const settle = async () => {
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve));
};

const normalize = (value) => JSON.parse(JSON.stringify(value).replaceAll(`p${ORIGIN}.`, "p$ORIGIN."));

async function runCase(testCase) {
  const dom = new JSDOM("", { url: "sok://probe/", runScripts: "outside-only" });
  const posted = [];
  // The view module reads the global window, which Node does not define; the test defines it for the case only.
  Object.defineProperty(globalThis, "window", { value: dom.window, configurable: true, writable: true });
  try {
    dom.window.webkit = { messageHandlers: { "sok-view": { postMessage: () => {} } } };
    dom.window.eval(readFileSync(new URL("../view-start.js", import.meta.url), "utf8"));
    const bridge = createViewBridge({
      handler: { postMessage: (message) => posted.push(structuredClone(message)) },
      report: () => {},
    });
    // A host message is a window message event whose source is the window.
    const host = (data) => dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data, source: dom.window }));
    const stored = new Map();
    posted.splice(0);
    const outputs = [];
    for (const step of testCase.steps) {
      let result = null;
      let throws = null;
      try {
        let pending = null;
        if ("operation" in step) {
          const { event, fields, as } = step.operation;
          result = bridge.runtime.beginOperation(event, fields);
          assert.equal(result.length, 1, "an operation has one identifier");
          assert.match(result[0], IDENTIFIER, "an operation identifier has the page form");
          stored.set(as, result);
        } else if ("sidecar" in step) {
          const { name, id, body, cids } = step.sidecar;
          pending = bridge.runtime.sidecar(name).send(id, body, stored.get(cids));
        } else if ("command" in step) {
          const { name, params, cids } = step.command;
          pending = bridge.runtime.command(name, params, { cids: stored.get(cids) });
        } else {
          throw new Error(`unsupported view operation step ${Object.keys(step).join(", ")}`);
        }
        if (step.answer) host({ sok: 1, id: posted.at(-1).id, ...step.answer });
        if (pending) result = (await pending) ?? null;
      } catch (error) {
        throws = error.message;
      }
      await settle();
      outputs.push({ posted: posted.splice(0), result, throws });
    }
    return outputs;
  } finally {
    delete globalThis.window;
    dom.window.close();
  }
}

test("view operation contract publishes the required cases in order", () => {
  assert.deepEqual(CONTRACT.cases.map(({ id }) => id), EXPECTED_IDS);
});

for (const testCase of CONTRACT.cases) {
  test(`view operation ${testCase.id} matches each ordered step`, async () => {
    const actual = normalize(await runCase(testCase));
    assert.deepEqual(actual, testCase.steps.map(({ output }) => output));
  });
}
