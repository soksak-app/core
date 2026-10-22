// Runs the published view composition cases (packages/plugin-api/contract/view-composition.json) against the composition of
// createViewBridge over a jsdom window on sok://probe/. The host answers each call the page posts, in the order of the posted calls,
// and the test compares the posted calls, the listener calls, the results, the errors and the region state and history of each step.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createViewBridge } from "../view.js";

const CONTRACT = JSON.parse(readFileSync(new URL("../contract/view-composition.json", import.meta.url), "utf8"));
const EXPECTED_IDS = [
  "view.composition.create-attaches-and-places",
  "view.composition.document-calls-in-order",
  "view.composition.state-and-onstate-in-order",
  "view.composition.history-of-the-attach-reply",
  "view.composition.update-and-region-refusals",
  "view.composition.dispose-detaches-the-region",
  "view.composition.message-listener-receives-document-messages",
  "view.composition.stream-subscribe-and-close",
  "view.composition.reload-and-restored-state",
];

// Lets every pending promise of the call layer settle before a step reports its output.
const settle = async () => {
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve));
};

async function runCase(testCase) {
  const view = new JSDOM("", { url: "sok://probe/", runScripts: "outside-only" }).window;
  // The view module reads the global window, which Node does not define; the test defines it for the case only.
  Object.defineProperty(globalThis, "window", { value: view, configurable: true, writable: true });
  try {
    view.webkit = { messageHandlers: { "sok-view": { postMessage: () => {} } } };
    view.eval(readFileSync(new URL("../view-start.js", import.meta.url), "utf8"));
    view.document.body.innerHTML = Object.keys(CONTRACT.elements).map((name) => `<div id="${name}"></div>`).join("");
    // The composition measures the elements and the viewport; animation frames are not run by the case.
    view.ResizeObserver = class { observe() {} disconnect() {} };
    view.requestAnimationFrame = () => 1;
    view.cancelAnimationFrame = () => {};
    view.visualViewport = { width: 800, height: 600 };
    for (const [name, rect] of Object.entries(CONTRACT.elements)) {
      const { left, top, width, height } = rect;
      view.document.getElementById(name).getBoundingClientRect = () => ({
        left, top, width, height, right: left + width, bottom: top + height,
      });
    }

    const posted = [];
    const delivered = [];
    const host = (data) => view.dispatchEvent(new view.MessageEvent("message", { data, source: view }));
    const bridge = createViewBridge({
      handler: { postMessage: (message) => posted.push(structuredClone(message)) },
      report: () => {},
    });
    let controller = null;
    let answered = 0;
    let mark = 0;
    let queue = [];

    // Answers each call that the page posted and has no answer yet, in the order of the posted calls, while answers remain.
    const answer = async () => {
      for (let round = 0; round < 20; round += 1) {
        await settle();
        const before = answered;
        while (answered < posted.length && queue.length > 0) {
          const message = posted[answered];
          answered += 1;
          const next = queue.shift();
          if ("error" in next) host({ sok: 1, id: message.id, error: next.error });
          else host({ sok: 1, id: message.id, result: next.result ?? null });
        }
        if (answered === before) break;
      }
      await settle();
    };

    // A listener argument records each message under its name; noop is a change function that changes nothing.
    const mapArg = (arg) => {
      if (arg === "noop") return () => {};
      if (typeof arg === "string" && arg.startsWith("listener:")) {
        const listener = arg.slice("listener:".length);
        return (message) => delivered.push({ listener, message });
      }
      return arg;
    };
    const subscriptions = [];
    const outputs = [];
    for (const step of testCase.steps) {
      queue = [...(step.answers ?? [])];

      let result = null;
      let throws = null;
      let done = false;
      const track = (promise) => {
        Promise.resolve(promise).then((value) => {
          done = true;
          result = value ?? null;
        }, (error) => {
          done = true;
          throws = error.message;
        });
      };
      try {
        if ("create" in step) {
          const regions = Object.fromEntries(step.create.regions.map((name) => [name, view.document.getElementById(name)]));
          const overlays = Object.fromEntries(step.create.overlays.map((name) => [name, view.document.getElementById(name)]));
          track(bridge.composition.create({ regions, overlays }).then((created) => {
            controller = created;
            return created.kind;
          }));
        } else if ("do" in step && "region" in step.do) {
          track(Promise.resolve().then(() => controller.region(step.do.region)[step.do.call](...step.do.args.map(mapArg))).then((value) => {
            // A subscription is kept by its index for a close step; its output is the stream and the handle of the host reply.
            if (typeof value?.close !== "function") return value;
            subscriptions.push(value);
            return { stream: value.stream, handle: value.handle };
          }));
        } else if ("do" in step && "composition" in step.do) {
          const args = step.do.args.map(mapArg);
          track(Promise.resolve().then(() => {
            const value = controller[step.do.composition](...args);
            return typeof value?.name === "string" ? value.name : value;
          }));
        } else if ("listen" in step) {
          const { region, listener, kind = "state" } = step.listen;
          const target = controller.region(region);
          const remove = kind === "message"
            ? target.onMessage((message) => delivered.push({ listener, message }))
            : target.onState((state) => delivered.push({ listener, state }));
          track(Promise.resolve(typeof remove === "function" ? "function" : null));
        } else if ("event" in step) {
          // A document-state event has state, a document-message event has message, and a document-stream event has handle.
          const { document, state, message, handle } = step.event;
          if ("handle" in step.event) host({ sok: 1, event: "document-stream", data: { document, handle, message } });
          else if ("message" in step.event) host({ sok: 1, event: "document-message", data: { document, message } });
          else host({ sok: 1, event: "document-state", data: { document, state } });
          track(Promise.resolve(null));
        } else if ("close" in step) {
          track(Promise.resolve().then(() => subscriptions[step.close.subscription].close()));
        } else if ("dispose" in step) {
          track(controller.dispose());
        } else {
          throw new Error(`unsupported composition step ${Object.keys(step).join(", ")}`);
        }
      } catch (error) {
        throws = error.message;
      }
      await answer();
      await settle();
      assert.equal(queue.length, 0, `step has answers that no call posted: ${JSON.stringify(queue)}`);
      const region = controller ? controller.region("doc") : null;
      outputs.push({
        posted: posted.slice(mark),
        delivered: delivered.splice(0),
        settled: done,
        result: done && throws === null ? result : null,
        throws,
        state: region ? region.state : null,
        history: region ? region.history : null,
      });
      mark = posted.length;
    }
    return outputs;
  } finally {
    delete globalThis.window;
    view.close();
  }
}

test("view composition contract publishes the required cases in order", () => {
  assert.deepEqual(CONTRACT.cases.map(({ id }) => id), EXPECTED_IDS);
});

for (const testCase of CONTRACT.cases) {
  test(`view composition ${testCase.id} matches each ordered step`, async () => {
    const actual = await runCase(testCase);
    assert.deepEqual(actual, testCase.steps.map(({ output }) => output));
  });
}
