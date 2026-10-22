// Runs the published view settings and text size cases (packages/plugin-api/contract/view-settings.json) against the
// runtime.settings and runtime.textSize calls of createViewBridge over a jsdom window on sok://probe/. Each step reads a value,
// subscribes a listener, delivers a host event, removes a listener, or refuses a subscription, and the runner compares the posted
// calls, the listener calls, the results and the errors of each step with the published output.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createViewBridge } from "../view.js";

const CONTRACT = JSON.parse(readFileSync(new URL("../contract/view-settings.json", import.meta.url), "utf8"));
const EXPECTED_IDS = [
  "view.settings.read-returns-the-host-values",
  "view.textSize.read-returns-the-host-scale",
  "view.settings.on-delivers-each-host-change",
  "view.textSize.on-delivers-each-host-change",
  "view.settings.on-refuses-a-missing-listener",
  "view.settings.refused-subscription-is-removed",
  "view.settings.listeners-share-one-subscription",
];

// Lets every pending promise of the call layer settle before a step reports its output.
const settle = async () => {
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve));
};

async function runCase(testCase) {
  const dom = new JSDOM("", { url: "sok://probe/", runScripts: "outside-only" });
  const posted = [];
  const delivered = [];
  const pending = new Map();
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
        if ("read" in step) {
          const call = step.read === "settings" ? bridge.runtime.settings.read() : bridge.runtime.textSize.read();
          if (step.answer) host({ sok: 1, id: posted.at(-1).id, ...step.answer });
          result = (await call) ?? null;
        } else if ("subscribe" in step) {
          const { kind, listener } = step.subscribe;
          // A step with a null listener calls on without a listener, which the bridge refuses.
          const on = bridge.runtime[kind].on;
          const subscription = listener === null
            ? on(undefined)
            : on((data) => delivered.push({ listener, data: structuredClone(data) }));
          if (listener !== null) pending.set(listener, subscription);
          if (step.answer) host({ sok: 1, id: posted.at(-1).id, ...step.answer });
          result = typeof (await subscription) === "function" ? "function" : null;
        } else if ("off" in step) {
          const remove = await pending.get(step.off);
          remove();
        } else if ("event" in step) {
          host({ sok: 1, event: step.event.event, data: step.event.data });
        } else {
          throw new Error(`unsupported settings step ${Object.keys(step).join(", ")}`);
        }
      } catch (error) {
        throws = error.message;
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

test("view settings contract publishes the required cases in order", () => {
  assert.deepEqual(CONTRACT.cases.map(({ id }) => id), EXPECTED_IDS);
});

for (const testCase of CONTRACT.cases) {
  test(`view settings ${testCase.id} matches each ordered step`, async () => {
    const actual = await runCase(testCase);
    assert.deepEqual(actual, testCase.steps.map(({ output }) => output));
  });
}
