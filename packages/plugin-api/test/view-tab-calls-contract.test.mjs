// Runs the published view tab call cases (packages/plugin-api/contract/view-tab-calls.json) against the call layer of createViewBridge
// over a jsdom window on sok://probe/. Each case sends one tab call with its parameters, the host answers it with a reply or an error,
// and the runner compares the posted call, the result and the error of each step with the published output.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createViewBridge } from "../view.js";

const CONTRACT = JSON.parse(readFileSync(new URL("../contract/view-tab-calls.json", import.meta.url), "utf8"));
const EXPECTED_IDS = [
  "view.tab.title-request-reply-and-refusal",
  "view.tab.footer-request-reply-and-refusal",
  "view.tab.directory-request-reply-and-refusal",
  "view.tab.notify-request-reply-and-refusal",
  "view.tab.modified-request-reply-and-refusal",
  "view.tab.error-request-reply-and-refusal",
  "view.tab.keep-request-reply-and-refusal",
];

// Lets every pending promise of the call layer settle before a step reports its output.
const settle = async () => {
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve));
};

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
    posted.splice(0);
    const outputs = [];
    for (const step of testCase.steps) {
      let result = null;
      let throws = null;
      try {
        const call = bridge.calls.request(step.call.command, step.call.params);
        if (step.answer) host({ sok: 1, id: posted.at(-1).id, ...step.answer });
        result = (await call) ?? null;
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

test("view tab call contract publishes the required cases in order", () => {
  assert.deepEqual(CONTRACT.cases.map(({ id }) => id), EXPECTED_IDS);
});

for (const testCase of CONTRACT.cases) {
  test(`view tab call ${testCase.id} matches each ordered step`, async () => {
    const actual = await runCase(testCase);
    assert.deepEqual(actual, testCase.steps.map(({ output }) => output));
  });
}
