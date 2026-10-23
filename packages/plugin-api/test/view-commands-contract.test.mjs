// Runs the published view command cases (packages/plugin-api/contract/view-commands.json) against the commands of createViewBridge
// over a jsdom window on soksak://probe/. Each step registers a command or delivers a host request, and compares the messages the page
// posted, the result and the error with the published output.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createViewBridge } from "../view.js";

const CONTRACT = JSON.parse(readFileSync(new URL("../contract/view-commands.json", import.meta.url), "utf8"));
const EXPECTED_IDS = [
  "view.commands.register-answers-and-refuses-unregistered",
  "view.commands.run-failure-and-empty-result",
  "view.commands.run-passes-cids-to-handler",
];

const RUNS = {
  echo: (params) => structuredClone(params),
  fail: () => { throw new Error("save failed"); },
  none: () => undefined,
  text: "not a function",
  // The context that the handler receives with the request: the cids of the request, and no key when the request has none.
  context: (params, context) => structuredClone(context),
};

// Lets every pending promise of the call layer settle before a step reports its output.
const settle = async () => {
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve));
};

async function runCase(testCase) {
  const dom = new JSDOM("", { url: "soksak://probe/", runScripts: "outside-only" });
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
    posted.splice(0);
    const outputs = [];
    for (const step of testCase.steps) {
      let result = null;
      let throws = null;
      try {
        if ("register" in step) {
          const pending = bridge.commands.register(step.register.name, RUNS[step.register.run]);
          if (step.answer) host({ sok: 1, id: posted.at(-1).id, ...step.answer });
          result = (await pending) ?? null;
        } else if ("request" in step) {
          host({ sok: 1, ...step.request });
        } else {
          throw new Error(`unsupported view command step ${Object.keys(step).join(", ")}`);
        }
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

test("view command contract publishes the required cases in order", () => {
  assert.deepEqual(CONTRACT.cases.map(({ id }) => id), EXPECTED_IDS);
});

for (const testCase of CONTRACT.cases) {
  test(`view command ${testCase.id} matches each ordered step`, async () => {
    const actual = await runCase(testCase);
    assert.deepEqual(actual, testCase.steps.map(({ output }) => output));
  });
}
