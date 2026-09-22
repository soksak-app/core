import assert from "node:assert/strict";
import test from "node:test";

test("shell module disposes its composition controller before removing the surface", async () => {
  const input = { value: "" };
  const output = { children: [], append() {}, replaceChildren() { this.children = []; } };
  const interrupt = {};
  const clear = {};
  const root = {
    set innerHTML(value) { assert.equal(typeof value, "string"); },
    querySelector(selector) {
      return { "#in": input, "#out": output, '[data-command="shell.interrupt"]': interrupt,
        '[data-command="shell.clear"]': clear }[selector] ?? null;
    },
    replaceChildren() { this.removed = true; },
  };
  let compositionDisposed = 0;
  const sent = [];
  const context = {
    surfaceId: "shell-test",
    composition: { create: async () => ({ dispose: async () => { compositionDisposed += 1; } }) },
    runtime: { sidecar: () => ({
      send: async (_surface, body) => { sent.push(body.operation); },
      on: async () => () => {},
    }) },
    exposure: {
      command: async () => {}, status: async () => {}, dom: async () => {},
      delegate: async () => {}, bind: async () => {}, dispose: async () => {},
    },
    status: { report: () => {} },
  };
  const { mount } = await import("../ui/shell.js");
  const mounted = await mount(root, context);
  await mounted.dispose();
  assert.deepEqual(sent, ["open", "close"]);
  assert.equal(compositionDisposed, 1);
  assert.equal(root.removed, true);
});
