// Runs the published view status cases (packages/plugin-api/contract/view-status.json) against the runtime.status calls of
// createViewBridge over a jsdom window on sok://probe/. Each step watches a status with a named listener, stops a listener,
// or delivers a host event, and the runner compares the posted calls, the listener calls, the results and the errors of each
// step with the published output.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createViewBridge } from "../view.js";

const CONTRACT = JSON.parse(readFileSync(new URL("../contract/view-status.json", import.meta.url), "utf8"));
const EXPECTED_IDS = [
  "view.status.watch-posts-the-name-and-returns-a-stop",
  "view.status.delivers-each-value-of-its-name",
  "view.status.unwatch-ends-the-watch",
  "view.status.refused-name-removes-the-listener",
  "view.status.watch-refuses-a-missing-name-and-listener",
];

// Lets every pending promise of the call layer settle before a step reports its output.
const settle = async () => {
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve));
};

async function runCase(testCase) {
  const dom = new JSDOM("", { url: "sok://probe/", runScripts: "outside-only" });
  const posted = [];
  const delivered = [];
  const stops = new Map();
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
    posted.splice(0);
    const outputs = [];
    for (const step of testCase.steps) {
      let result = null;
      let throws = null;
      try {
        if ("watch" in step) {
          const { name, listener } = step.watch;
          const stop = bridge.runtime.status.watch(name, listener === null ? undefined : (value) => delivered.push({ listener, data: structuredClone(value) }));
          if (listener !== null) stops.set(listener, stop);
          result = typeof stop === "function" ? "function" : null;
        } else if ("stop" in step) {
          stops.get(step.stop)();
          result = null;
        } else if ("event" in step) {
          host({ sok: 1, event: step.event.event, data: step.event.data });
        } else {
          throw new Error(`unsupported status step ${Object.keys(step).join(", ")}`);
        }
      } catch (error) {
        throws = error.message;
      }
      await settle();
      for (const [id, payload] of Object.entries(step.replies ?? {})) {
        host({ sok: 1, id: Number(id), ...payload });
      }
      await settle();
      outputs.push({ posted: posted.splice(0), delivered: delivered.splice(0), result, throws });
    }
    return outputs;
  } finally {
    delete globalThis.window;
    dom.window.close();
  }
}

test("view status contract publishes the required cases in order", () => {
  assert.deepEqual(CONTRACT.cases.map(({ id }) => id), EXPECTED_IDS);
});

for (const testCase of CONTRACT.cases) {
  test(`view status ${testCase.id} matches each ordered step`, async () => {
    const actual = await runCase(testCase);
    assert.deepEqual(actual, testCase.steps.map(({ output }) => output));
  });
}
