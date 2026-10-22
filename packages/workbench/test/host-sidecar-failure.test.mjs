// The failure of a sidecar session of a plugin host is not an application error alert: the document leaves it to the plugin host
// (docs/spec/sidecars.md#failure, docs/spec/plugin-host.md#channel). A failure of any other surface with no handler still shows the alert.
import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { JSDOM } from "jsdom";

const listeners = new Map();
mock.module("@soksak/runtime", { namedExports: {
  host: {
    call: () => Promise.resolve(null),
    on: (name, listener) => {
      let set = listeners.get(name);
      if (!set) listeners.set(name, set = new Set());
      set.add(listener);
      return Promise.resolve(() => set.delete(listener));
    },
  },
  page: null,
} });

const dom = new JSDOM("<body></body>", { url: "https://example.test/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.ErrorEvent = dom.window.ErrorEvent;
const dispatched = [];
globalThis.dispatchEvent = (event) => { dispatched.push(event); return true; };

const { windowSidecar } = await import("../host.js");
const emit = (name, event) => { for (const listener of [...(listeners.get(name) ?? [])]) listener(event); };
const tick = () => new Promise((resolve) => setImmediate(resolve));

// contract: plugin-host.sidecar.failure
test("a failure of a plugin session with no listener shows no application error alert, and a failure of another surface does", async () => {
  const sidecar = windowSidecar("fixture-sidecar");
  // The first subscription installs the document's sidecar-failure listener.
  await sidecar.onFailure("view-a", () => {});
  emit("sidecar-failure", { surface: "plugin:probe:p1:fixture-sidecar", sidecar: "fixture-sidecar", reason: "exited" });
  await tick();
  assert.equal(dispatched.length, 0, "a plugin session failure showed an application error alert");
  emit("sidecar-failure", { surface: "view-b", sidecar: "fixture-sidecar", reason: "exited" });
  await tick();
  assert.equal(dispatched.length, 1, "a surface failure with no listener did not show the application error alert");
  assert.equal(dispatched[0].message, "sidecar fixture-sidecar failed for surface view-b: exited");
});
