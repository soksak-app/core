// Runs the published exposure cases (packages/plugin-api/contract/expose.json) against createExpose of core. Each case registers
// statuses and dom names on a page, forwards host requests, and compares the registrations, replies, element effects, results and
// errors of each step with the published output.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createExpose } from "../index.js";

const CONTRACT = JSON.parse(readFileSync(new URL("../contract/expose.json", import.meta.url), "utf8"));
const EXPECTED_IDS = [
  "expose.status.get-watch-and-next-in-order",
  "expose.status.refuses-undeclared-and-duplicate",
  "expose.dom.act-rect-and-refusals",
  "expose.dispose.ends-registrations-and-requests",
];

// Lets every pending promise of the registration and reply chain settle before a step reports its output.
const settle = async () => {
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve));
};

async function runCase(testCase) {
  const { window } = new JSDOM(`<body>${testCase.markup ?? ""}</body>`);
  try {
    const { document } = window;
    const registered = [];
    const replies = [];
    const effects = [];
    let request = null;
    for (const element of document.querySelectorAll("[id]")) {
      const rect = testCase.rects?.[element.id];
      if (rect) element.getBoundingClientRect = () => ({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height });
      element.addEventListener("click", () => effects.push(`click ${element.id}`));
    }
    const port = {
      // The remover of the request listener is the one that the host port returns; dispose must call it.
      onRequest(listener) {
        request = listener;
        return () => {
          request = null;
        };
      },
      reply(id, payload) {
        replies.push({ id, payload: structuredClone(payload) });
        return Promise.resolve();
      },
      register(kind, name) {
        registered.push({ kind, name });
        return Promise.resolve();
      },
      // The unregister of the surface port: the page registration ends, which the case records as an unregister.
      unregister() {
        registered.push({ kind: "unregister" });
        return Promise.resolve();
      },
      report() {},
    };
    const expose = createExpose(port, () => structuredClone(testCase.declarations));
    let value = testCase.initial ?? null;
    const subscribers = new Set();
    const outputs = [];
    for (const step of testCase.steps) {
      let result = null;
      let throws = null;
      try {
        if ("status" in step) {
          result = await expose.status(step.status.name, () => value, (listener) => {
            subscribers.add(listener);
            return () => subscribers.delete(listener);
          });
        } else if ("dom" in step) {
          result = await expose.dom(step.dom.name, document.querySelector(step.dom.selector));
        } else if ("request" in step) {
          // A request after the listener is removed is not dispatched, so no reply is sent.
          request?.(step.request);
        } else if ("dispose" in step) {
          await expose.dispose();
        } else if ("set" in step) {
          value = step.set;
          for (const listener of [...subscribers]) listener(value);
        } else {
          throw new Error(`unsupported expose step ${Object.keys(step).join(", ")}`);
        }
      } catch (error) {
        throws = error.message;
      }
      await settle();
      outputs.push({
        registered: registered.splice(0),
        replies: replies.splice(0),
        effects: effects.splice(0),
        result: result ?? null,
        throws,
      });
    }
    return outputs;
  } finally {
    window.close();
  }
}

test("exposure contract publishes the required cases in order", () => {
  assert.deepEqual(CONTRACT.cases.map(({ id }) => id), EXPECTED_IDS);
});

for (const testCase of CONTRACT.cases) {
  test(`exposure ${testCase.id} matches each ordered step`, async () => {
    const actual = await runCase(testCase);
    assert.deepEqual(actual, testCase.steps.map(({ output }) => output));
  });
}
