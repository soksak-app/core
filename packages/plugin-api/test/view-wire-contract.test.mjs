// Runs the view wire contract cases (packages/plugin-api/contract/view-wire.json) against the injected view script of core
// (packages/plugin-api/view-start.js). Each case is one ordered list of steps; each step's output is compared literally with
// what the script posts to the sok-view handler, delivers to the listener, or throws. A plugin's literal fakes copy these steps.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const CONTRACT = JSON.parse(readFileSync(new URL("../contract/view-wire.json", import.meta.url), "utf8"));
const SCRIPT = readFileSync(new URL("../view-start.js", import.meta.url), "utf8");
const PAGE = "1700000000000.5";

/**
 * Starts the view script in a fresh context with a window that records what it posts and where it attaches its message
 * listener. Returns the window, the posted messages and the delivered messages.
 */
function startView(host, document) {
  const posted = [];
  const delivered = [];
  const messages = { listener: null };
  const window = {
    location: { host },
    webkit: { messageHandlers: { "sok-view": { postMessage: (message) => posted.push(JSON.parse(JSON.stringify(message))) } } },
    addEventListener(type, listener) {
      if (type === "message") messages.listener = listener;
    },
  };
  vm.runInNewContext(SCRIPT, { window, crypto: { randomUUID: () => document }, performance: { timeOrigin: Number(PAGE) } });
  return { window, posted, delivered, messages };
}

/** The listener that a step names: `record` keeps each message, and any other input is passed as it is. */
function listenerFor(view, name) {
  return name === "record" ? (message) => view.delivered.push(JSON.parse(JSON.stringify(message))) : 42;
}

/** Runs the steps of one case in order and returns what each step produced, in the form of its output. */
export function runViewWireCase(testCase) {
  let view = null;
  return testCase.steps.map((step) => {
    if (step.load) {
      view = startView(step.load.host, step.load.document);
    } else {
      assert.ok(view, `${testCase.id}: the first step must load the view script`);
    }
    const before = { posted: view?.posted.length ?? 0, delivered: view?.delivered.length ?? 0 };
    let throws = null;
    if (step.attach) {
      try {
        view.window.sokView.attach(listenerFor(view, step.attach.listener));
      } catch (error) {
        throws = error.message;
      }
    } else if (step.message) {
      const source = step.message.source === "window" ? view.window : {};
      for (let index = 0; index < (step.repeat ?? 1); index += 1) {
        view.messages.listener({ source, data: JSON.parse(JSON.stringify(step.message.data)) });
      }
    }
    if (step.load) return { posted: view.posted.slice(0), delivered: [], throws: null };
    return {
      posted: view.posted.slice(before.posted),
      delivered: view.delivered.slice(before.delivered),
      throws,
    };
  });
}

test("the view wire contract cases have ids that are unique and steps that name what they run", () => {
  const ids = CONTRACT.cases.map((testCase) => testCase.id);
  assert.equal(new Set(ids).size, ids.length, `duplicate case id in ${ids.join(", ")}`);
  for (const testCase of CONTRACT.cases) {
    assert.ok(testCase.steps.length > 0, `${testCase.id} has no steps`);
    for (const step of testCase.steps) {
      const kinds = ["load", "attach", "message"].filter((kind) => kind in step);
      assert.equal(kinds.length, 1, `${testCase.id} has a step that is not one load, attach or message`);
      assert.ok("posted" in step.output && "throws" in step.output, `${testCase.id} has a step without posted or throws`);
      assert.ok("delivered" in step.output || "deliveredCount" in step.output, `${testCase.id} has a step without delivered`);
    }
  }
});

for (const testCase of CONTRACT.cases) {
  test(`view wire ${testCase.id} matches the view script step by step`, () => {
    const actual = runViewWireCase(testCase);
    testCase.steps.forEach((step, index) => {
      const where = `${testCase.id} step ${index + 1}`;
      assert.deepStrictEqual(actual[index].posted, step.output.posted, `${where} posted`);
      if ("deliveredCount" in step.output) {
        assert.equal(actual[index].delivered.length, step.output.deliveredCount, `${where} delivered count`);
      } else {
        assert.deepStrictEqual(actual[index].delivered, step.output.delivered, `${where} delivered`);
      }
      assert.equal(actual[index].throws, step.output.throws, `${where} throws`);
    });
  });
}
