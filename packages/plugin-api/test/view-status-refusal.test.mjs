// A refused runtime.status.watch rejects the `ready` promise of the stop function that the watch returned, with the code and the
// message of the refusal, and it still writes the refusal as a runtime.error call (docs/spec/native-surfaces.md#view-surfaces).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createViewBridge } from "../view.js";

// Lets every pending promise of the call layer settle before the test reads the result.
const settle = async () => {
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve));
};

test("a refused status watch rejects its ready promise with the refusal code and text", async () => {
  const dom = new JSDOM("", { url: "soksak://probe/", runScripts: "outside-only" });
  const posted = [];
  Object.defineProperty(globalThis, "window", { value: dom.window, configurable: true, writable: true });
  try {
    dom.window.webkit = { messageHandlers: { "sok-view": { postMessage: () => {} } } };
    dom.window.sokTheme = { scheme: "dark", tokens: {} };
    dom.window.eval(readFileSync(new URL("../view-start.js", import.meta.url), "utf8"));
    const bridge = createViewBridge({
      handler: {
        postMessage: (message) => posted.push(structuredClone(message)),
      },
      report: () => {},
    });
    const stop = bridge.runtime.status.watch("probe.count", () => {});
    await settle();
    const watch = posted.find((message) => message.command === "runtime.status.watch");
    assert.deepEqual(watch?.params, { name: "probe.count" });
    const refusal = { code: -32000, message: "status probe.count is not declared" };
    dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data: { sok: 1, id: watch.id, error: refusal }, source: dom.window }));
    await assert.rejects(stop.ready, (error) => error.code === refusal.code && error.message === refusal.message);
    await settle();
    const errors = posted.filter((message) => message.command === "runtime.error");
    assert.equal(errors.length, 1, "the refusal is also written as a runtime.error call of the view");
    assert.match(JSON.stringify(errors[0].params), /status probe\.count is not declared/);
  } finally {
    delete globalThis.window;
    dom.window.close();
  }
});
