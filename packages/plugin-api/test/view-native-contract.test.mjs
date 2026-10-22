// Runs the published view native cases (packages/plugin-api/contract/view-native.json) against the runtime.native calls and the
// exposure calls of createViewBridge over a jsdom window on sok://probe/.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createViewBridge } from "../view.js";

const CONTRACT = JSON.parse(readFileSync(new URL("../contract/view-native.json", import.meta.url), "utf8"));
const EXPECTED_IDS = [
  "view.native.on-subscribes-once-per-name",
  "view.native.refused-subscription-is-requested-again",
  "view.native.exposure-calls-and-refusals",
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
        if ("on" in step) {
          const { name, listener } = step.on;
          const subscription = bridge.runtime.native.on(name, (data) => delivered.push({ listener, data: structuredClone(data) }));
          pending.set(listener, subscription);
          if (step.answer) host({ sok: 1, id: posted.at(-1).id, ...step.answer });
          result = typeof (await subscription) === "function" ? "function" : null;
        } else if ("off" in step) {
          const remove = await pending.get(step.off);
          remove();
        } else if ("event" in step) {
          host({ sok: 1, event: step.event.event, data: step.event.data });
        } else if ("exposureRegister" in step) {
          const call = bridge.exposure.register(step.exposureRegister.kind, step.exposureRegister.name);
          if (step.answer) host({ sok: 1, id: posted.at(-1).id, ...step.answer });
          result = (await call) ?? null;
        } else if ("exposureReply" in step) {
          const call = bridge.exposure.reply(step.exposureReply.id, step.exposureReply.payload);
          if (step.answer) host({ sok: 1, id: posted.at(-1).id, ...step.answer });
          result = (await call) ?? null;
        } else {
          throw new Error(`unsupported view native step ${Object.keys(step).join(", ")}`);
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

test("view native contract publishes the required cases in order", () => {
  assert.deepEqual(CONTRACT.cases.map(({ id }) => id), EXPECTED_IDS);
});

for (const testCase of CONTRACT.cases) {
  test(`view native ${testCase.id} matches each ordered step`, async () => {
    const actual = await runCase(testCase);
    assert.deepEqual(actual, testCase.steps.map(({ output }) => output));
  });
}
