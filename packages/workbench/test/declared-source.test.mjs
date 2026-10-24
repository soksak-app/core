// Checks the view transport of a declared status (declared-source.js): the channel of a view source acknowledges through the
// view event of its surface and delivers the snapshots that the host relays, and the pull runs through the command layer of
// the view. The runtime is a fake host, and the command layer of the view is the real registry of view-commands.js.
import assert from "node:assert/strict";
import test, { beforeEach, mock } from "node:test";

// The runtime of the tests: it records the calls, refuses the next call while refusal names a reason, and delivers the events
// that the tests name.
const calls = [];
const listeners = new Map();
let refusal = null;
let callOverride = null;
let originSnapshotResponse = null;
const fixtureOrigins = { floor: 6, pluginHosts: { probe: 4, other: 5, "race-probe": 3 }, views: { "view-a": 1, "view-b": 2, "view-other": 6 } };
let originSnapshot = fixtureOrigins;
let delayListenerRegistration = true;
let pendingListenerRegistrations = [];
let completeListenerRegistration = null;
let rejectListenerRegistration = null;
mock.module("@soksak/runtime", { namedExports: {
  host: {
    call: (name, arg) => {
      calls.push({ name, arg });
      if (callOverride !== null) return callOverride(name, arg);
      if (name === "declaredSourceOrigins") return originSnapshotResponse ?? Promise.resolve(originSnapshot);
      if (refusal !== null) return Promise.reject(new Error(refusal));
      if (arg?.event === "declared-ui.snapshot.ack") return Promise.resolve(true);
      return Promise.resolve(null);
    },
    on: (name, listener) => {
      if (rejectListenerRegistration !== null) return Promise.reject(rejectListenerRegistration);
      let set = listeners.get(name);
      if (!set) listeners.set(name, set = new Set());
      if (delayListenerRegistration) {
        return new Promise((resolve) => {
          pendingListenerRegistrations.push(() => {
            set.add(listener);
            resolve(() => set.delete(listener));
          });
          completeListenerRegistration = () => {
            for (const complete of pendingListenerRegistrations.splice(0)) complete();
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
const fixtureGeneration = (plugin, surface) => surface == null
  ? fixtureOrigins.pluginHosts[plugin]
  : fixtureOrigins.views[surface];
const emit = (name, event) => {
  const delivered = name === "declared-ui-snapshot" && event?.generation === undefined
    ? { ...event, generation: fixtureGeneration(event.plugin, event.surface) }
    : event;
  for (const listener of [...(listeners.get(name) ?? [])]) listener(delivered);
};
globalThis.ErrorEvent ??= class ErrorEvent extends Event {
  constructor(type, init = {}) { super(type); this.message = init.message ?? ""; }
};
globalThis.dispatchEvent ??= () => true;
const reported = [];
const previousDispatch = globalThis.dispatchEvent;
globalThis.dispatchEvent = (event) => { reported.push(event.message); return previousDispatch(event); };

const { createDeclaredSource: makeDeclaredSource, startDeclaredSnapshotIngress, afterDeclaredSnapshotIngress } = await import("../declared-source.js");
const { registerSourceOrigin, seedSourceOrigins, sourceOrigin } = await import("../source-origins.js");
const { keepViewCommands } = await import("../view-commands.js");
const { registry } = await import("../exposure.js");
const processState = await import("../plugin-processes.js");
registry.declare("snapshot-probe", {
  status: [{ name: "snapshot-probe.tree", description: "Tree.", schema: { type: "object" } }],
  commands: [],
  dom: [],
});

function withGeneration(source, plugin) {
  return source.generation === undefined ? { ...source, generation: fixtureGeneration(plugin, source.surface) } : source;
}

const createDeclaredSource = (options) => {
  const adapter = makeDeclaredSource(options);
  return {
    ...adapter,
    channel: (source) => adapter.channel(withGeneration(source, options.plugin)),
    expanded: (source, request) => adapter.expanded(withGeneration(source, options.plugin), request),
    pull: (source) => adapter.pull(withGeneration(source, options.plugin)),
  };
};

beforeEach(() => seedSourceOrigins(fixtureOrigins));

test("a view channel resolves readiness only after the runtime listener is installed", async () => {
  let resolveOriginSnapshot;
  originSnapshotResponse = new Promise((resolve) => { resolveOriginSnapshot = resolve; });
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
  await new Promise((resolve) => setImmediate(resolve));
  emit("declared-ui-source-registered", { plugin: "created-during-seed", generation: 7 });
  emit("declared-ui-snapshot", { plugin: "created-during-seed", generation: 7, status: "lines", seq: 1, value: { n: 1 }, skipped: 0 });
  assert.equal(sourceOrigin("created-during-seed", null), undefined, "a lifecycle event escaped the startup snapshot buffer");
  resolveOriginSnapshot(fixtureOrigins);
  const unsubscribe = await registration;
  await ingress;
  await placement;
  assert.equal(ready, true, "the section subscription did not become ready with ingress");
  assert.equal(providerStarted, true, "provider startup did not resume after ingress registration");
  assert.ok(calls.some(({ name, arg }) => name === "pluginHostEvent" && arg.plugin === "created-during-seed" && arg.generation === 7),
    "the first snapshot of a source created after startup was not acknowledged with its generation");
  assert.equal(listeners.get("declared-ui-snapshot")?.size, 1, "more than one window ingress listener was installed");
  for (const name of ["declared-ui-source-registered", "declared-ui-source-ended"]) {
    assert.equal(listeners.get(name)?.size, 1, `the window ingress did not install exactly one ${name} listener`);
  }
  unsubscribe();
  delayListenerRegistration = false;
  completeListenerRegistration = null;
  originSnapshotResponse = null;
});

test("source lifecycle events advance the seeded registry and reject delayed retired generations", async () => {
  await startDeclaredSnapshotIngress();
  delayListenerRegistration = false;
  emit("declared-ui-source-registered", { plugin: "new-plugin", generation: 7 });
  assert.equal(sourceOrigin("new-plugin", null), 7, "a source created after the startup snapshot was not registered");
  emit("declared-ui-source-registered", { plugin: "new-plugin", generation: 6 });
  assert.equal(sourceOrigin("new-plugin", null), 7, "a delayed retired registration replaced the current source");
  emit("declared-ui-source-ended", { plugin: "new-plugin", generation: 6 });
  assert.equal(sourceOrigin("new-plugin", null), 7, "a delayed retired end removed the current source");
  emit("declared-ui-source-ended", { plugin: "new-plugin", generation: 7 });
  assert.equal(sourceOrigin("new-plugin", null), undefined, "the exact current end did not remove the source");
});

test("source lifecycle events clear only the replaced or ended generation watermark", async () => {
  await startDeclaredSnapshotIngress();
  delayListenerRegistration = false;
  const { acceptSnapshotSequence, acceptedSnapshots } = processState;
  acceptSnapshotSequence("lifecycle-probe", "tree", null, 6, 3);
  emit("declared-ui-source-registered", { plugin: "lifecycle-probe", generation: 7 });
  assert.deepEqual(acceptedSnapshots().filter((row) => row.plugin === "lifecycle-probe"), [], "replacement kept the previous generation watermark");
  acceptSnapshotSequence("lifecycle-probe", "tree", null, 7, 1);
  emit("declared-ui-source-ended", { plugin: "lifecycle-probe", generation: 6 });
  assert.deepEqual(acceptedSnapshots().filter((row) => row.plugin === "lifecycle-probe"), [
    { plugin: "lifecycle-probe", status: "tree", surface: null, generation: 7, seq: 1 },
  ], "a delayed end removed the replacement generation watermark");
  emit("declared-ui-source-ended", { plugin: "lifecycle-probe", generation: 7 });
  assert.deepEqual(acceptedSnapshots().filter((row) => row.plugin === "lifecycle-probe"), []);
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
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(delivered, ["first:2"], "an unsubscribed recipient received an already queued delivery");
  stopFirst();
  stopSecond();
});

test("listener registration failure remains observable without an early unhandled rejection", async () => {
  const failure = new Error("snapshot listener registration failed");
  rejectListenerRegistration = failure;
  const isolated = await import("../declared-source.js?registration-failure");
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const readiness = isolated.startDeclaredSnapshotIngress();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, [], "listener registration failed before startup observed its readiness");
    await assert.rejects(readiness, /snapshot listener registration failed/);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    rejectListenerRegistration = null;
  }
});

test("an expansion update reaches the plugin view as declared-ui.expanded", async () => {
  const { expanded } = createDeclaredSource({ plugin: "probe", status: "tree" });
  await expanded({ id: "view-a", surface: "view-a" }, { status: "tree", tree: "file-tree", path: ["folder"], expanded: true });
  assert.deepEqual(calls.at(-1), {
    name: "viewEvent",
    arg: { surface: "view-a", generation: 1, event: "declared-ui.expanded", data: { status: "tree", tree: "file-tree", path: ["folder"], expanded: true } },
  });
});

test("an expansion update reaches a plugin host as declared-ui.expanded", async () => {
  const { expanded } = createDeclaredSource({ plugin: "probe", status: "tree" });
  await expanded({ id: "plugin:probe", surface: null }, { status: "tree", tree: "file-tree", path: ["folder"], expanded: false });
  assert.deepEqual(calls.at(-1), {
    name: "pluginHostEvent",
    arg: { plugin: "probe", generation: 4, event: "declared-ui.expanded", data: { status: "tree", tree: "file-tree", path: ["folder"], expanded: false } },
  });
});

test("a declared-ui.expanded request is sent to its view source", async () => {
  const { expanded } = createDeclaredSource({ plugin: "probe", status: "lines" });
  await expanded({ id: "view-a", surface: "view-a" }, { status: "lines", tree: "t1", path: ["root", "child"], expanded: true });
  assert.deepEqual(calls.at(-1), {
    name: "viewEvent",
    arg: { surface: "view-a", generation: 1, event: "declared-ui.expanded", data: { status: "lines", tree: "t1", path: ["root", "child"], expanded: true } },
  });
});

test("a declared-ui.expanded request is sent through the plugin host event call", async () => {
  const { expanded } = createDeclaredSource({ plugin: "probe", status: "lines" });
  await expanded({ id: "plugin:probe", surface: null }, { status: "lines", tree: "t1", path: ["root"], expanded: false });
  assert.deepEqual(calls.at(-1), {
    name: "pluginHostEvent",
    arg: { plugin: "probe", generation: 4, event: "declared-ui.expanded", data: { status: "lines", tree: "t1", path: ["root"], expanded: false } },
  });
});

test("the ingress ACKs each valid view event once and routes only its source and status", { timeout: 3000 }, async () => {
  delayListenerRegistration = false;
  completeListenerRegistration = null;
  const { channel } = createDeclaredSource({ plugin: "probe", status: "lines" });
  const link = channel({ id: "view-a", surface: "view-a" });
  const received = [];
  const unsubscribe = await link.onMessage((message) => received.push(message));
  await new Promise((resolve) => setImmediate(resolve));
  emit("declared-ui-snapshot", { surface: "view-a", plugin: "probe", status: "lines", seq: 2, value: { n: 1 }, skipped: 1 });
  emit("declared-ui-snapshot", { surface: "view-b", plugin: "probe", status: "lines", seq: 3, value: null, skipped: 0 });
  emit("declared-ui-snapshot", { surface: "view-other", plugin: "other", status: "lines", seq: 4, value: null, skipped: 0 });
  emit("declared-ui-snapshot", { surface: "view-a", plugin: "probe", status: "other", seq: 5, value: null, skipped: 0 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(received, [{
    event: "declared-ui.snapshot", plugin: "probe", status: "lines", seq: 2, value: { n: 1 }, skipped: 1,
  }], "the channel delivered a snapshot of another source");
  assert.deepEqual(calls.slice(-4), [
    { name: "viewEvent", arg: { surface: "view-a", generation: 1, event: "declared-ui.snapshot.ack", data: { plugin: "probe", status: "lines", seq: 2 } } },
    { name: "viewEvent", arg: { surface: "view-b", generation: 2, event: "declared-ui.snapshot.ack", data: { plugin: "probe", status: "lines", seq: 3 } } },
    { name: "viewEvent", arg: { surface: "view-other", generation: 6, event: "declared-ui.snapshot.ack", data: { plugin: "other", status: "lines", seq: 4 } } },
    { name: "viewEvent", arg: { surface: "view-a", generation: 1, event: "declared-ui.snapshot.ack", data: { plugin: "probe", status: "other", seq: 5 } } },
  ], "the ingress did not ACK each valid event once before routing");
  unsubscribe();
  await new Promise((resolve) => setImmediate(resolve));
  emit("declared-ui-snapshot", { surface: "view-a", plugin: "probe", status: "lines", seq: 5, value: null, skipped: 0 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(received.length, 1, "the unsubscribe did not end the delivery");
});

test("the ingress reports a recipient failure and continues to the next recipient", { timeout: 3000 }, async () => {
  delayListenerRegistration = false;
  completeListenerRegistration = null;
  callOverride = null;
  refusal = null;
  await startDeclaredSnapshotIngress();
  const { channel } = createDeclaredSource({ plugin: "probe", status: "lines" });
  const link = channel({ id: "view-a", surface: "view-a" });
  const delivered = [];
  const stopThrowing = await link.onMessage(() => { throw new Error("recipient callback failed"); });
  const stopNext = await link.onMessage((message) => delivered.push(message.seq));
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  const reportOffset = reported.length;
  process.on("unhandledRejection", onUnhandled);
  try {
    emit("declared-ui-snapshot", { surface: "view-a", plugin: "probe", status: "lines", seq: 8, value: { n: 2 }, skipped: 0 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(delivered, [8], "a throwing recipient prevented later recipients from receiving the accepted snapshot");
    assert.deepEqual(reported.slice(reportOffset), ["declared UI snapshot ingress: recipient callback failed"],
      "the accepted snapshot recipient failure was not reported exactly once");
    assert.deepEqual(unhandled, [], "the asynchronous recipient dispatch left an unhandled rejection");
  } finally {
    process.off("unhandledRejection", onUnhandled);
    stopThrowing();
    stopNext();
    reported.splice(reportOffset);
  }
});

test("a deferred accepted ACK cannot route a snapshot to a replacement source recipient", async () => {
  delayListenerRegistration = false;
  completeListenerRegistration = null;
  await startDeclaredSnapshotIngress();
  seedSourceOrigins({ floor: 1, pluginHosts: { "race-probe": 1 }, views: {} });
  const delivered = [];
  const { channel } = createDeclaredSource({ plugin: "race-probe", status: "lines" });
  const oldLink = channel({ id: "plugin:race-probe", surface: null, generation: 1 });
  const newLink = channel({ id: "plugin:race-probe", surface: null, generation: 3 });
  const stopOld = await oldLink.onMessage((message) => delivered.push(`old:${message.seq}`));
  let finishAck;
  callOverride = () => new Promise((resolve) => { finishAck = resolve; });
  emit("declared-ui-snapshot", { plugin: "race-probe", generation: 1, status: "lines", seq: 7, value: { n: "old" }, skipped: 0 });
  const stopNew = await newLink.onMessage((message) => delivered.push(`new:${message.seq}`));
  assert.equal(registerSourceOrigin("race-probe", null, 3), true, "the replacement source did not advance its generation");
  stopOld();
  finishAck(true);
  await new Promise((resolve) => setImmediate(resolve));
  callOverride = null;
  assert.deepEqual(delivered, [], "an old snapshot reached a recipient after the source was replaced");
  stopNew();
});

test("a snapshot with an older native generation is not acknowledged or delivered", async () => {
  delayListenerRegistration = false;
  completeListenerRegistration = null;
  seedSourceOrigins({ floor: 3, pluginHosts: {}, views: {} });
  calls.length = 0;
  const received = [];
  const { channel } = createDeclaredSource({ plugin: "race-probe-stale", status: "lines" });
  const stop = await channel({ id: "plugin:race-probe-stale", surface: null, generation: 3 }).onMessage((message) => received.push(message));
  emit("declared-ui-snapshot", { plugin: "race-probe-stale", generation: 1, status: "lines", seq: 8, value: { n: "old" }, skipped: 0 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(received, [], "an older generation was delivered to the current recipient");
  assert.deepEqual(calls, [], "an older generation was acknowledged through the replacement provider");
  stop();
});

test("the accepted snapshot status advances only after the delayed native acknowledgement", { timeout: 5000 }, async () => {
  delayListenerRegistration = false;
  completeListenerRegistration = null;
  seedSourceOrigins({ floor: 9, pluginHosts: { "snapshot-probe": 9 }, views: {} });
  await startDeclaredSnapshotIngress();
  const read = () => processState.acceptedSnapshots();
  const accepted = (seq) => [{ plugin: "snapshot-probe", status: "tree", surface: null, generation: 9, seq }];
  let finishAck;
  emit("declared-ui-snapshot", {
    plugin: "snapshot-probe", generation: 9, status: "tree", seq: 4,
    value: { project: "old" }, skipped: 0,
  });
  await new Promise((resolve) => setImmediate(resolve));
  const beforeProjectChange = read();
  callOverride = (name, arg) => {
    assert.equal(name, "pluginHostEvent");
    assert.equal(arg.event, "declared-ui.snapshot.ack");
    return new Promise((resolve) => { finishAck = resolve; });
  };
  emit("declared-ui-snapshot", {
    plugin: "snapshot-probe", generation: 9, status: "tree", seq: 5,
    value: { project: null }, skipped: 0,
  });
  const whileAckPending = read();
  finishAck(true);
  await new Promise((resolve) => setImmediate(resolve));
  const afterAcceptedAck = read();
  callOverride = null;
  assert.deepEqual({ beforeProjectChange, whileAckPending, afterAcceptedAck }, {
    beforeProjectChange: accepted(4),
    whileAckPending: accepted(4),
    afterAcceptedAck: accepted(5),
  }, "the accepted snapshot status must expose the old value until the delayed new snapshot ACK is accepted");
});

test("the ingress acknowledges but does not publish an undeclared snapshot status", async () => {
  delayListenerRegistration = false;
  await startDeclaredSnapshotIngress();
  seedSourceOrigins({ floor: 10, pluginHosts: { "undeclared-probe": 10 }, views: {} });
  calls.length = 0;
  const before = processState.acceptedSnapshots();
  emit("declared-ui-snapshot", {
    plugin: "undeclared-probe", generation: 10, status: "unregistered", seq: 1,
    value: { private: true }, skipped: 0,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [{
    name: "pluginHostEvent",
    arg: { plugin: "undeclared-probe", generation: 10, event: "declared-ui.snapshot.ack", data: { plugin: "undeclared-probe", status: "unregistered", seq: 1 } },
  }], "an undeclared status was not acknowledged through its current source");
  assert.deepEqual(processState.acceptedSnapshots(), before, "an undeclared status became public metadata");
});

test("a delayed declared snapshot acknowledgement cannot publish a retired source generation", { timeout: 5000 }, async () => {
  delayListenerRegistration = false;
  await startDeclaredSnapshotIngress();
  seedSourceOrigins({ floor: 9, pluginHosts: { "snapshot-probe": 9 }, views: {} });
  let finishAck;
  callOverride = () => new Promise((resolve) => { finishAck = resolve; });
  emit("declared-ui-snapshot", {
    plugin: "snapshot-probe", generation: 9, status: "tree", seq: 6,
    value: { project: null }, skipped: 0,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof finishAck, "function", "the declared snapshot did not start its native acknowledgement");
  emit("declared-ui-source-registered", { plugin: "snapshot-probe", generation: 10 });
  finishAck(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(processState.acceptedSnapshots().filter((row) => row.plugin === "snapshot-probe"), [],
    "a delayed acknowledgement published the retired generation");
  callOverride = null;
  emit("declared-ui-snapshot", {
    plugin: "snapshot-probe", generation: 10, status: "tree", seq: 1,
    value: { project: null }, skipped: 0,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(processState.acceptedSnapshots().filter((row) => row.plugin === "snapshot-probe"), [
    { plugin: "snapshot-probe", status: "tree", surface: null, generation: 10, seq: 1 },
  ], "the current generation did not publish its accepted watermark");
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
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(received, [
    { event: "declared-ui.snapshot", plugin: "probe", status: "lines", seq: 5, value: null, skipped: 0 },
  ], "the channel delivered a snapshot of another source");
  assert.deepEqual(calls, [
    { name: "pluginHostEvent", arg: { plugin: "probe", generation: 4, event: "declared-ui.snapshot.ack", data: { plugin: "probe", status: "lines", seq: 5 } } },
    { name: "viewEvent", arg: { surface: "view-a", generation: 1, event: "declared-ui.snapshot.ack", data: { plugin: "probe", status: "lines", seq: 6 } } },
    { name: "pluginHostEvent", arg: { plugin: "other", generation: 5, event: "declared-ui.snapshot.ack", data: { plugin: "other", status: "lines", seq: 7 } } },
    { name: "pluginHostEvent", arg: { plugin: "probe", generation: 4, event: "declared-ui.snapshot.ack", data: { plugin: "probe", status: "other", seq: 8 } } },
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
  }, 1);
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
  }, 4);
  assert.deepEqual(await pull({ id: "plugin:probe", surface: null }), { seq: 4, value: { n: 1 } });
  forget();
  await assert.rejects(pull({ id: "plugin:probe", surface: null }), /probe.lines: the plugin host has no channel/);
});

test("a pull from a retired source is not issued through the replacement command layer", async () => {
  seedSourceOrigins({ floor: 8, pluginHosts: { probe: 8 }, views: { "view-a": 8 } });
  let viewPulls = 0;
  const forgetView = keepViewCommands("view-a", {
    run: async () => { viewPulls += 1; return { seq: 9, value: { source: "new" } }; },
  }, 8);
  const { pull } = createDeclaredSource({ plugin: "probe", status: "lines" });
  const staleView = await pull({ id: "view-a", surface: "view-a", generation: 1 });
  assert.deepEqual(staleView, { cancelled: true, sourceGeneration: 1 });
  assert.equal(viewPulls, 0, "a retired view pull reached the replacement layer");
  forgetView();

  let hostPulls = 0;
  const { keepHostCommands } = await import("../plugin-host.js");
  const forgetHost = keepHostCommands("probe", {
    run: async () => { hostPulls += 1; return { seq: 9, value: { source: "new" } }; },
  }, 8);
  const staleHost = await pull({ id: "plugin:probe", surface: null, generation: 1 });
  assert.deepEqual(staleHost, { cancelled: true, sourceGeneration: 1 });
  assert.equal(hostPulls, 0, "a retired plugin-host pull reached the replacement layer");
  forgetHost();
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
