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

test("shell module reports written lines as shell.history and pending runs as shell.jobs", async () => {
  const lines = [];
  const output = { children: lines, clientHeight: 0, scrollTop: 0, append(el) { lines.push(el); },
    get lastElementChild() { return lines.at(-1); }, replaceChildren() { lines.length = 0; } };
  globalThis.document = { createElement: () => ({ textContent: "", append(part) { this.textContent += part; } }) };
  const root = {
    set innerHTML(value) {},
    querySelector(selector) { return selector === "#out" ? output : { value: "" }; },
    replaceChildren() {},
  };
  const commands = new Map();
  const statuses = new Map();
  const sent = [];
  const context = {
    surfaceId: "shell-test",
    composition: { create: async () => ({ dispose: async () => {} }) },
    runtime: { sidecar: () => ({ send: async (_surface, body) => { sent.push(body); }, on: async () => () => {} }) },
    exposure: {
      command: async (name, run) => { commands.set(name, run); },
      status: async (name, read, subscribe) => { statuses.set(name, { read, subscribe }); },
      dom: async () => {}, delegate: async () => {}, bind: async () => {},
    },
    status: { report: () => {} },
  };
  const { mount } = await import("../ui/shell.js");
  await mount(root, context);
  const seen = [];
  statuses.get("shell.history").subscribe((value) => seen.push(value));
  await commands.get("shell.write")({ data: "ls\npwd\n" });
  await commands.get("shell.write")({ data: "\n" });
  assert.deepEqual(statuses.get("shell.history").read(), ["ls", "pwd"]);
  assert.deepEqual(seen.at(-1), ["ls", "pwd"]);
  commands.get("shell.run")({ command: "sleep 5" });
  assert.deepEqual(statuses.get("shell.jobs").read(), [{ id: "run-1", command: "sleep 5" }]);
  delete globalThis.document;
});

test("shell module opens in its origin directory and reports each directory to its tab", async () => {
  const input = { value: "" };
  const output = { children: [], append() {}, replaceChildren() {} };
  const root = {
    set innerHTML(value) {},
    querySelector(selector) { return { "#in": input, "#out": output }[selector] ?? {}; },
    replaceChildren() {},
  };
  const opened = [];
  const directories = [];
  let listener = null;
  const context = {
    surfaceId: "shell-origin", origin: Object.freeze({ directory: "/work/sub" }),
    tab: { title() {}, directory: (path) => directories.push(path), notify() {} },
    composition: { create: async () => ({ dispose: async () => {} }) },
    runtime: { sidecar: () => ({
      send: async (_surface, body) => { if (body.operation === "open") opened.push(body); },
      on: async (_surface, fn) => { listener = fn; return () => {}; },
    }) },
    exposure: {
      command: async () => {}, status: async () => {}, dom: async () => {},
      delegate: async () => {}, bind: async () => {}, dispose: async () => {},
    },
    status: { report: () => {} },
  };
  const { mount } = await import("../ui/shell.js");
  await mount(root, context);
  assert.deepEqual(opened, [{ operation: "open", directory: "/work/sub" }]);
  listener({ cwd: "/work/sub/deeper" });
  assert.deepEqual(directories, ["/work/sub/deeper"]);
});
