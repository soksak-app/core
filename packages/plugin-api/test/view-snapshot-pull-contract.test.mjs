// Runs the published view snapshot pull cases (packages/plugin-api/contract/view-snapshot-pull.json) against createViewBridge over a
// jsdom window on sok://probe/. Each step pushes a declared UI snapshot from the view or delivers a declared-ui.snapshot.request from
// the host, and the runner compares the posted messages of each step with the published output.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createViewBridge } from "../view.js";

const CONTRACT = JSON.parse(readFileSync(new URL("../contract/view-snapshot-pull.json", import.meta.url), "utf8"));
const EXPECTED_IDS = [
  "view.snapshot.pull-without-a-pushed-value-replies-null",
  "view.snapshot.pull-replies-the-pushed-value",
  "view.snapshot.pull-replies-the-last-pushed-value",
  "view.snapshot.pull-refuses-a-missing-status",
  "view.snapshot.pull-reports-a-store-fault",
];

// Lets every pending promise of the call layer settle before a step reports its output.
const settle = async () => {
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve));
};

async function runCase(t, testCase) {
  const dom = new JSDOM("", { url: "sok://probe/", runScripts: "outside-only" });
  const posted = [];
  // The view module reads the global window, which Node does not define; the test defines it for the case only.
  Object.defineProperty(globalThis, "window", { value: dom.window, configurable: true, writable: true });
  try {
    dom.window.webkit = { messageHandlers: { "sok-view": { postMessage: () => {} } } };
    dom.window.eval(readFileSync(new URL("../view-start.js", import.meta.url), "utf8"));
    const reports = [];
    const bridge = createViewBridge({
      handler: { postMessage: (message) => posted.push(structuredClone(message)) },
      report: (event) => reports.push(structuredClone(event)),
    });
    // A host message is a window message event whose source is the window.
    const host = (data) => dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data, source: dom.window }));
    posted.splice(0);
    const outputs = [];
    for (const step of testCase.steps) {
      if ("fault" in step) {
        // A fault of the snapshot store: every pull after this step throws the message of the fault.
        t.mock.method(bridge.snapshots, "pull", () => {
          throw new Error(step.fault);
        });
      } else if ("push" in step) {
        bridge.snapshots.push(step.push.status, step.push.value);
      } else if ("request" in step) {
        host({ sok: 1, id: step.request.id, command: "declared-ui.snapshot.request", params: step.request.params });
      } else {
        throw new Error(`unsupported snapshot step ${Object.keys(step).join(", ")}`);
      }
      await settle();
      outputs.push({ posted: posted.splice(0), reports: reports.splice(0) });
    }
    return outputs;
  } finally {
    delete globalThis.window;
    dom.window.close();
  }
}

test("view snapshot pull contract publishes the required cases in order", () => {
  assert.deepEqual(CONTRACT.cases.map(({ id }) => id), EXPECTED_IDS);
});

for (const testCase of CONTRACT.cases) {
  test(`view snapshot pull ${testCase.id} matches each ordered step`, async (t) => {
    const actual = await runCase(t, testCase);
    assert.deepEqual(actual, testCase.steps.map(({ output }) => output));
  });
}
