// Checks the view transport of a declared status (declared-source.js): the channel of a view source acknowledges through the
// view event of its surface and delivers the snapshots that the host relays, and the pull runs through the command layer of
// the view. The runtime is a fake host, and the command layer of the view is the real registry of view-commands.js.
import assert from "node:assert/strict";
import test, { mock } from "node:test";

// The runtime of the tests: it records the calls, refuses the next call while refusal names a reason, and delivers the events
// that the tests name.
const calls = [];
const listeners = new Map();
let refusal = null;
mock.module("@soksak/runtime", { namedExports: {
  host: {
    call: (name, arg) => {
      calls.push({ name, arg });
      return refusal === null ? Promise.resolve(null) : Promise.reject(new Error(refusal));
    },
    on: (name, listener) => {
      let set = listeners.get(name);
      if (!set) listeners.set(name, set = new Set());
      set.add(listener);
      return Promise.resolve(() => set.delete(listener));
    },
  },
  page: null,
} });
/** Delivers one event of name to every registered listener, as the host does. */
const emit = (name, event) => { for (const listener of [...(listeners.get(name) ?? [])]) listener(event); };
globalThis.ErrorEvent ??= class ErrorEvent extends Event {
  constructor(type, init = {}) { super(type); this.message = init.message ?? ""; }
};
globalThis.dispatchEvent ??= () => true;
const reported = [];
const previousDispatch = globalThis.dispatchEvent;
globalThis.dispatchEvent = (event) => { reported.push(event.message); return previousDispatch(event); };

const { createDeclaredSource } = await import("../declared-source.js");
const { keepViewCommands } = await import("../view-commands.js");

test("the channel of a view source acknowledges a snapshot through the view event of its surface", () => {
  const { channel } = createDeclaredSource({ plugin: "probe", status: "lines" });
  const link = channel({ id: "view-a", surface: "view-a" });
  link.send({ event: "declared-ui.snapshot.ack", plugin: "probe", status: "lines", seq: 3 });
  assert.deepEqual(calls, [{
    name: "viewEvent",
    arg: { surface: "view-a", event: "declared-ui.snapshot.ack", data: { plugin: "probe", status: "lines", seq: 3 } },
  }], "the acknowledgement was not the view event of the source");
});

test("an expansion update reaches the plugin view as declared-ui.expanded", async () => {
  const { expanded } = createDeclaredSource({ plugin: "probe", status: "tree" });
  await expanded({ id: "view-a", surface: "view-a" }, { status: "tree", tree: "file-tree", path: ["folder"], expanded: true });
  assert.deepEqual(calls.at(-1), {
    name: "viewEvent",
    arg: { surface: "view-a", event: "declared-ui.expanded", data: { status: "tree", tree: "file-tree", path: ["folder"], expanded: true } },
  });
});

test("an expansion update reaches a plugin host as declared-ui.expanded", async () => {
  const { expanded } = createDeclaredSource({ plugin: "probe", status: "tree" });
  await expanded({ id: "plugin:probe", surface: null }, { status: "tree", tree: "file-tree", path: ["folder"], expanded: false });
  assert.deepEqual(calls.at(-1), {
    name: "pluginHostEvent",
    arg: { plugin: "probe", event: "declared-ui.expanded", data: { status: "tree", tree: "file-tree", path: ["folder"], expanded: false } },
  });
});

test("a declared-ui.expanded request is sent to its view source", async () => {
  const { expanded } = createDeclaredSource({ plugin: "probe", status: "lines" });
  await expanded({ id: "view-a", surface: "view-a" }, { status: "lines", tree: "t1", path: ["root", "child"], expanded: true });
  assert.deepEqual(calls.at(-1), {
    name: "viewEvent",
    arg: { surface: "view-a", event: "declared-ui.expanded", data: { status: "lines", tree: "t1", path: ["root", "child"], expanded: true } },
  });
});

test("a declared-ui.expanded request is sent through the plugin host event call", async () => {
  const { expanded } = createDeclaredSource({ plugin: "probe", status: "lines" });
  await expanded({ id: "plugin:probe", surface: null }, { status: "lines", tree: "t1", path: ["root"], expanded: false });
  assert.deepEqual(calls.at(-1), {
    name: "pluginHostEvent",
    arg: { plugin: "probe", event: "declared-ui.expanded", data: { status: "lines", tree: "t1", path: ["root"], expanded: false } },
  });
});

test("the channel delivers each snapshot of its surface and plugin, and the unsubscribe ends the delivery", async () => {
  const { channel } = createDeclaredSource({ plugin: "probe", status: "lines" });
  const link = channel({ id: "view-a", surface: "view-a" });
  const received = [];
  const unsubscribe = link.onMessage((message) => received.push(message));
  await new Promise((resolve) => setImmediate(resolve));
  emit("declared-ui-snapshot", { surface: "view-a", plugin: "probe", status: "lines", seq: 2, value: { n: 1 }, skipped: 1 });
  emit("declared-ui-snapshot", { surface: "view-b", plugin: "probe", status: "lines", seq: 3, value: null, skipped: 0 });
  emit("declared-ui-snapshot", { surface: "view-a", plugin: "other", status: "lines", seq: 4, value: null, skipped: 0 });
  assert.deepEqual(received, [{
    event: "declared-ui.snapshot", plugin: "probe", status: "lines", seq: 2, value: { n: 1 }, skipped: 1,
  }], "the channel delivered a snapshot of another source");
  unsubscribe();
  await new Promise((resolve) => setImmediate(resolve));
  emit("declared-ui-snapshot", { surface: "view-a", plugin: "probe", status: "lines", seq: 5, value: null, skipped: 0 });
  assert.deepEqual(received.length, 1, "the unsubscribe did not end the delivery");
});

test("the channel of a plugin host source acknowledges through pluginHostEvent and delivers the snapshots of its plugin", async () => {
  const { channel } = createDeclaredSource({ plugin: "probe", status: "lines" });
  const link = channel({ id: "plugin:probe", surface: null });
  assert.notEqual(link, null, "a plugin host source has no channel");
  link.send({ event: "declared-ui.snapshot.ack", plugin: "probe", status: "lines", seq: 3 });
  assert.deepEqual(calls.at(-1), {
    name: "pluginHostEvent",
    arg: { plugin: "probe", event: "declared-ui.snapshot.ack", data: { plugin: "probe", status: "lines", seq: 3 } },
  }, "the acknowledgement was not the plugin host event of the source");
  const received = [];
  const unsubscribe = link.onMessage((message) => received.push(message));
  emit("declared-ui-snapshot", { plugin: "probe", status: "lines", seq: 5, value: null, skipped: 0 });
  emit("declared-ui-snapshot", { surface: "view-a", plugin: "probe", status: "lines", seq: 6, value: null, skipped: 0 });
  emit("declared-ui-snapshot", { plugin: "other", status: "lines", seq: 7, value: null, skipped: 0 });
  assert.deepEqual(received, [
    { event: "declared-ui.snapshot", plugin: "probe", status: "lines", seq: 5, value: null, skipped: 0 },
  ], "the channel delivered a snapshot of another source");
  unsubscribe();
  await new Promise((resolve) => setImmediate(resolve));
  emit("declared-ui-snapshot", { plugin: "probe", status: "lines", seq: 8, value: null, skipped: 0 });
  assert.deepEqual(received.length, 1, "the unsubscribe did not end the delivery");
});

test("the pull of a view source runs the snapshot request through the command layer of its view", async () => {
  const forget = keepViewCommands("view-a", {
    run: (command, params) => {
      assert.equal(command, "declared-ui.snapshot.request");
      assert.deepEqual(params, { status: "lines" });
      return Promise.resolve({ seq: 4, value: { n: 1 } });
    },
  });
  const { pull } = createDeclaredSource({ plugin: "probe", status: "lines" });
  assert.deepEqual(await pull({ id: "view-a", surface: "view-a" }), { seq: 4, value: { n: 1 } });
  forget();
});

test("the pull of a plugin host source runs the snapshot request through the layer of its host", async () => {
  const { keepHostCommands } = await import("../plugin-host.js");
  const { pull } = createDeclaredSource({ plugin: "probe", status: "lines" });
  const forget = keepHostCommands("probe", {
    run: (command, params) => {
      assert.equal(command, "declared-ui.snapshot.request");
      assert.deepEqual(params, { status: "lines" });
      return Promise.resolve({ seq: 4, value: { n: 1 } });
    },
  });
  assert.deepEqual(await pull({ id: "plugin:probe", surface: null }), { seq: 4, value: { n: 1 } });
  forget();
  await assert.rejects(pull({ id: "plugin:probe", surface: null }), /probe.lines: the plugin host has no channel/);
});

test("the pull of a view without a command layer rejects with its surface", async () => {
  const { pull } = createDeclaredSource({ plugin: "probe", status: "lines" });
  await assert.rejects(pull({ id: "view-a", surface: "view-a" }), {
    message: "probe.lines: surface view-a has no view command layer",
  });
});

test("a refused acknowledgement is reported through the page errors", async () => {
  const { channel } = createDeclaredSource({ plugin: "probe", status: "lines" });
  const link = channel({ id: "view-a", surface: "view-a" });
  refusal = "view-a has no ready document";
  link.send({ event: "declared-ui.snapshot.ack", plugin: "probe", status: "lines", seq: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(reported, ["probe.lines: view-a has no ready document"], "the refusal of the host was not reported");
  refusal = null;
});
