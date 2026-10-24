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
let delayListenerRegistration = true;
let completeListenerRegistration = null;
mock.module("@soksak/runtime", { namedExports: {
  host: {
    call: (name, arg) => {
      calls.push({ name, arg });
      return refusal === null ? Promise.resolve(null) : Promise.reject(new Error(refusal));
    },
    on: (name, listener) => {
      let set = listeners.get(name);
      if (!set) listeners.set(name, set = new Set());
      if (delayListenerRegistration) {
        return new Promise((resolve) => {
          completeListenerRegistration = () => {
            set.add(listener);
            resolve(() => set.delete(listener));
          };
        });
      }
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

const { createDeclaredSource, startDeclaredSnapshotIngress, afterDeclaredSnapshotIngress } = await import("../declared-source.js");
const { keepViewCommands } = await import("../view-commands.js");

test("a view channel resolves readiness only after the runtime listener is installed", async () => {
  const { channel } = createDeclaredSource({ plugin: "probe", status: "lines" });
  const link = channel({ id: "view-a", surface: "view-a" });
  let ready = false;
  let providerStarted = false;
  const ingress = startDeclaredSnapshotIngress();
  const placement = afterDeclaredSnapshotIngress(() => { providerStarted = true; });
  const registration = link.onMessage(() => {}).then((unsubscribe) => { ready = true; return unsubscribe; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ready, false, "a section subscription became ready before ingress registration");
  assert.equal(providerStarted, false, "a provider started before ingress registration");
  assert.equal(listeners.get("declared-ui-snapshot")?.size ?? 0, 0, "the runtime installed ingress before its registration completed");
  completeListenerRegistration();
  const unsubscribe = await registration;
  await ingress;
  await placement;
  assert.equal(ready, true, "the section subscription did not become ready with ingress");
  assert.equal(providerStarted, true, "provider startup did not resume after ingress registration");
  assert.equal(listeners.get("declared-ui-snapshot")?.size, 1, "more than one window ingress listener was installed");
  unsubscribe();
  delayListenerRegistration = false;
  completeListenerRegistration = null;
});

test("the channel delivers each snapshot of its surface and plugin, and the unsubscribe ends the delivery", async () => {
  const { channel } = createDeclaredSource({ plugin: "probe", status: "lines" });
  await startDeclaredSnapshotIngress();
  delayListenerRegistration = false;
  const link = channel({ id: "view-a", surface: "view-a" });
  const delivered = [];
  let stopSecond;
  const stopFirst = await link.onMessage((message) => {
    delivered.push("first:" + message.seq);
    stopSecond();
  });
  stopSecond = await link.onMessage((message) => delivered.push("second:" + message.seq));
  emit("declared-ui-snapshot", { surface: "view-a", plugin: "probe", status: "lines", seq: 2, value: { n: 1 }, skipped: 0 });
  assert.deepEqual(delivered, ["first:2"], "an unsubscribed recipient received an already queued delivery");
  stopFirst();
  stopSecond();
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

test("the ingress ACKs each valid view event once and routes only its source and status", async () => {
  const { channel } = createDeclaredSource({ plugin: "probe", status: "lines" });
  const link = channel({ id: "view-a", surface: "view-a" });
  const received = [];
  const unsubscribe = await link.onMessage((message) => received.push(message));
  await new Promise((resolve) => setImmediate(resolve));
  emit("declared-ui-snapshot", { surface: "view-a", plugin: "probe", status: "lines", seq: 2, value: { n: 1 }, skipped: 1 });
  emit("declared-ui-snapshot", { surface: "view-b", plugin: "probe", status: "lines", seq: 3, value: null, skipped: 0 });
  emit("declared-ui-snapshot", { surface: "view-other", plugin: "other", status: "lines", seq: 4, value: null, skipped: 0 });
  emit("declared-ui-snapshot", { surface: "view-a", plugin: "probe", status: "other", seq: 5, value: null, skipped: 0 });
  assert.deepEqual(received, [{
    event: "declared-ui.snapshot", plugin: "probe", status: "lines", seq: 2, value: { n: 1 }, skipped: 1,
  }], "the channel delivered a snapshot of another source");
  assert.deepEqual(calls.slice(-4), [
    { name: "viewEvent", arg: { surface: "view-a", event: "declared-ui.snapshot.ack", data: { plugin: "probe", status: "lines", seq: 2 } } },
    { name: "viewEvent", arg: { surface: "view-b", event: "declared-ui.snapshot.ack", data: { plugin: "probe", status: "lines", seq: 3 } } },
    { name: "viewEvent", arg: { surface: "view-other", event: "declared-ui.snapshot.ack", data: { plugin: "other", status: "lines", seq: 4 } } },
    { name: "viewEvent", arg: { surface: "view-a", event: "declared-ui.snapshot.ack", data: { plugin: "probe", status: "other", seq: 5 } } },
  ], "the ingress did not ACK each valid event once before routing");
  unsubscribe();
  await new Promise((resolve) => setImmediate(resolve));
  emit("declared-ui-snapshot", { surface: "view-a", plugin: "probe", status: "lines", seq: 5, value: null, skipped: 0 });
  assert.deepEqual(received.length, 1, "the unsubscribe did not end the delivery");
});

test("the channel of a plugin host source acknowledges through pluginHostEvent and delivers the snapshots of its plugin", async () => {
  const { channel } = createDeclaredSource({ plugin: "probe", status: "lines" });
  const link = channel({ id: "plugin:probe", surface: null });
  assert.notEqual(link, null, "a plugin host source has no channel");
  const received = [];
  const unsubscribe = await link.onMessage((message) => received.push(message));
  calls.length = 0;
  emit("declared-ui-snapshot", { plugin: "probe", status: "lines", seq: 5, value: null, skipped: 0 });
  emit("declared-ui-snapshot", { surface: "view-a", plugin: "probe", status: "lines", seq: 6, value: null, skipped: 0 });
  emit("declared-ui-snapshot", { plugin: "other", status: "lines", seq: 7, value: null, skipped: 0 });
  emit("declared-ui-snapshot", { plugin: "probe", status: "other", seq: 8, value: null, skipped: 0 });
  assert.deepEqual(received, [
    { event: "declared-ui.snapshot", plugin: "probe", status: "lines", seq: 5, value: null, skipped: 0 },
  ], "the channel delivered a snapshot of another source");
  assert.deepEqual(calls, [
    { name: "pluginHostEvent", arg: { plugin: "probe", event: "declared-ui.snapshot.ack", data: { plugin: "probe", status: "lines", seq: 5 } } },
    { name: "viewEvent", arg: { surface: "view-a", event: "declared-ui.snapshot.ack", data: { plugin: "probe", status: "lines", seq: 6 } } },
    { name: "pluginHostEvent", arg: { plugin: "other", event: "declared-ui.snapshot.ack", data: { plugin: "other", status: "lines", seq: 7 } } },
    { name: "pluginHostEvent", arg: { plugin: "probe", event: "declared-ui.snapshot.ack", data: { plugin: "probe", status: "other", seq: 8 } } },
  ], "the ingress did not ACK each event once");
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

test("a refused ingress acknowledgement is reported through the page errors", async () => {
  const { channel } = createDeclaredSource({ plugin: "probe", status: "lines" });
  const link = channel({ id: "view-a", surface: "view-a" });
  const unsubscribe = await link.onMessage(() => {});
  refusal = "view-a has no ready document";
  emit("declared-ui-snapshot", { surface: "view-a", plugin: "probe", status: "lines", seq: 1, value: null, skipped: 0 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(reported, ["declared UI snapshot ingress: view-a has no ready document"], "the refusal of the host was not reported");
  refusal = null;
  unsubscribe();
});
