import assert from "node:assert/strict";
import test from "node:test";

test("terminal module waits for composition presentation, publishes state, and disposes the controller", async () => {
  const view = { addEventListener() {}, removeEventListener() {} };
  const root = {
    childNodes: [],
    set innerHTML(value) { this.childNodes = value ? [view] : []; },
    querySelector(selector) { return selector === "#view" ? view : null; },
    replaceChildren() { this.childNodes = []; },
  };
  globalThis.window = { TextEncoder };
  const imageListeners = new Map();
  const image = {
    on(type, listener) {
      imageListeners.set(type, listener);
      return () => imageListeners.delete(type);
    },
    focus: async () => {}, setCaret: async () => {},
  };
  const sidecarListeners = new Map();
  const messages = [];
  const sidecar = {
    async on(id, listener) { sidecarListeners.set(id, listener); return () => sidecarListeners.delete(id); },
    async send(id, body) { messages.push({ id, body }); },
  };
  const statuses = new Map();
  const context = {
    surfaceId: "terminal-test",
    runtime: { sidecar: () => sidecar },
    composition: {
      async create() {
        await presentation;
        return { region: () => image, dispose: async () => { compositionDisposed = true; } };
      },
    },
    exposure: {
      status: async (name, read, subscribe) => statuses.set(name, { read, subscribe }),
      command: async () => {}, dom: async () => {}, bind: async () => {}, delegate: async () => {},
      dispose: async () => { exposureDisposed = true; },
    },
    status: { report: (phase) => { phases.push(phase); } },
  };
  let resolvePresentation;
  const presentation = new Promise((resolve) => { resolvePresentation = resolve; });
  let compositionDisposed = false;
  let exposureDisposed = false;
  const phases = [];
  const { mount } = await import("../ui/terminal-module.js");
  const mounting = mount(root, context);
  await Promise.resolve();
  assert.deepEqual(phases, [], "ready is not reported before native presentation");
  resolvePresentation();
  const mounted = await mounting;
  assert.deepEqual(phases, ["ready"]);
  sidecarListeners.get("terminal-test")({ event: "state", sessionId: "s1", cols: 80, rows: 24, cellWidth: 8, cellHeight: 16 });
  assert.equal(statuses.get("terminal.session").read().sessionId, "s1");
  await mounted.dispose();
  assert.equal(compositionDisposed, true);
  assert.equal(exposureDisposed, true);
  assert.equal(messages.at(-1).body.op, "close");
  assert.equal(root.childNodes.length, 0);
  delete globalThis.window;
});
