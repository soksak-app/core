// Checks the page side of the plugin host channel (plugin-host.js): the served call set of a host page registers its
// entries under the owner key plugin:<plugin id>, an unserved call is refused, and the requests of the main page run
// through the layer of the host, whose replies arrive as the plugin-host-reply events. The runtime is a fake host.
import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { clockAnswer } from "./support/records.mjs";

const calls = [];
const listeners = new Map();
let refusal = null;
let issuedGeneration = 0;
let currentGeneration = 0;
mock.module("@soksak/runtime", { namedExports: {
  host: {
    call: (name, arg) => {
      calls.push({ name, arg });
      if (name === "declaredSourceOrigins") return Promise.resolve({ floor: issuedGeneration - 1, pluginHosts: {}, views: {} });
      const clock = clockAnswer(name, arg);
      if (clock !== undefined) return Promise.resolve(clock);
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
mock.module("@soksak/plugin-api", { namedExports: {
  EXPOSE_KINDS: { status: "status", commands: "command", dom: "dom" },
  EXPOSURE_ERRORS: {
    failed: -32000, unknownMethod: -32601, invalidParams: -32602,
    unknownName: 1001, unregistered: 1002, gone: 1003, unavailable: 1004,
    timeout: 1005, inactive: 1006, noControl: 1009,
  },
  ExposureError: class ExposureError extends Error {
    constructor(code, message) { super(message); this.code = code; }
  },
  METHOD_KINDS: {
    "status.get": "status", "status.watch": "status", "status.unwatch": "status", "status.next": "status",
    "command.run": "command", "dom.rect": "dom", "dom.act": "dom",
  },
  surfaceDocumentEntry: () => false,
  declarationKey: (kind, name) => `${kind} ${name}`,
  declarationMap: () => new Map(),
  exposureEntries: () => ({ answer: async () => ({ result: null }) }),
  replyPayload: async (work) => ({ result: await work() }),
  validateExposes: (_owner, exposes) => exposes,
  validateExposureFile: (file) => file,
  createPluginRuntime: () => ({ log: {} }),
  SNAPSHOT_EVENT: "declared-ui.snapshot",
  SNAPSHOT_ACK_EVENT: "declared-ui.snapshot.ack",
  SNAPSHOT_REQUEST_COMMAND: "declared-ui.snapshot.request",
  createSnapshotReceiver: ({ send, onMessage, onSnapshot }) => {
    const stop = onMessage((message) => {
      if (message.event !== "declared-ui.snapshot") return;
      send({ event: "declared-ui.snapshot.ack", plugin: message.plugin, status: message.status, seq: message.seq });
      onSnapshot(message.status, message.seq, message.value, message.skipped);
    });
    return stop;
  },
  DEFAULT_CALL_TIMEOUT: 10000,
  // operations.js takes its identifier counter from the API; this test starts no operation.
  createOperationCids: () => () => { throw new Error("the plugin host calls start no operation"); },
  // The plugin host calls of this test carry no cids; a list here would be a test defect, so it is refused.
  causeCids: (cids) => { if (cids !== undefined) throw new Error("the plugin host calls of this test carry no cids"); return undefined; },
  createCalls: ({ send, onMessage, plugin, report }) => {
    let nextId = 0;
    const open = new Map();
    // The open calls of the layer are reported as the calls report of createCalls does (docs/spec/plugin-processes.md).
    const changed = () => report?.({ kind: "open-calls", plugin, count: open.size, oldestStartedAt: open.size ? 1 : null });
    onMessage((message) => {
      const call = open.get(message.id);
      if (!call) return;
      open.delete(message.id);
      changed();
      if (message.error) call.reject(new Error(message.error.message));
      else call.resolve(message.result);
    });
    return {
      request: (command, params) => new Promise((resolve, reject) => {
        const id = ++nextId;
        open.set(id, { resolve, reject });
        changed();
        send({ id, command, params });
      }),
      peerLost: (reason) => { for (const { reject } of open.values()) reject(new Error(reason)); open.clear(); },
    };
  },
  EXPOSURE_ERRORS: {},
  LOG_LEVELS: { error: "error", warn: "warn", info: "info", debug: "debug" },
} });
const emit = (name, event) => {
  const current = name.startsWith("plugin-host-") && event?.generation === undefined
    ? { ...event, generation: currentGeneration }
    : event;
  for (const listener of [...(listeners.get(name) ?? [])]) listener(current);
  if (name === "plugin-host-ended") currentGeneration = ++issuedGeneration;
};
const tick = () => new Promise((resolve) => setImmediate(resolve));

const { listenPluginHostCalls, hostCommandsOf, hostCommandGeneration, keepHostCommands, forwardHostExposure, createHostCommands } = await import("../plugin-host.js");
const { losses } = await import("../plugin-processes.js");
const { registerSourceOrigin, seedSourceOrigins } = await import("../source-origins.js");
const session = "plugin:probe:project-a:fixture-sidecar";

const registered = [];
const unregistered = [];
const reports = [];
const displays = [];
// The sidecars of the probe plugin: fixture-sidecar declares one read operation, list (docs/plans/plugin-host-routes.md rule 8).
const probeSidecars = [{
  name: "fixture-sidecar",
  declared: ["list"],
  declaration: { executable: "build/worker", protocol: 1, message: { form: "json-object", operationField: "operation" }, hostReadOperations: ["list"] },
}];
// The project data of the shown project: each call is recorded, and projectRefusal makes every call refuse with its text.
const projectCalls = [];
let projectRefusal = null;
const projectData = {
  get: async (plugin, key) => {
    projectCalls.push(["get", plugin, key]);
    if (projectRefusal !== null) throw new Error(projectRefusal);
    return "kept";
  },
  set: async (plugin, key, value) => {
    projectCalls.push(["set", plugin, key, value]);
    if (projectRefusal !== null) throw new Error(projectRefusal);
  },
};
// The core and plugin commands that a command call runs: each run is recorded, and the command answers with its name.
const coreRuns = [];
const ownedRuns = [];
// The log writes of the plugin host: each write of the plugin log is recorded with its level, event, fields and options.
const logWrites = [];
function listen({ onRegister = () => {}, onUnregister = () => {} } = {}) {
  currentGeneration = ++issuedGeneration;
  return listenPluginHostCalls({
    register: (plugin, kind, name, generation) => { registered.push({ plugin, kind, name }); onRegister(plugin, kind, name, generation); },
    unregister: (plugin, generation) => { unregistered.push(plugin); onUnregister(plugin, generation); },
    timeoutOf: () => undefined,
    report: (error) => reports.push(String(error?.message ?? error)),
    displayError: (line) => displays.push(line),
    sidecarsOf: (plugin) => (plugin === "probe" ? probeSidecars : []),
    projectData,
    runCore: (name, params) => { coreRuns.push({ name, params }); return Promise.resolve({ ran: name }); },
    runOwned: (name, params, owner) => { ownedRuns.push({ name, params, owner }); return Promise.resolve({ ran: name, owner }); },
    pluginLog: (plugin) => Object.fromEntries(["error", "warn", "info", "debug", "trace"]
      .map((level) => [level, (event, fields, options) => logWrites.push({ plugin, level, event, fields, options })])),
  });
}

async function closePluginHost(pluginHost) {
  emit("plugin-host-ended", { plugin: "probe" });
  await tick();
  pluginHost.close();
  await tick();
}

// contract: plugin-host.command.run
test("runtime.command runs a core command through runCore and a command of the plugin through runOwned, with the checks of the view call", async () => {
  const pluginHost = listen();
  try {
    emit("plugin-host-call", { plugin: "probe", id: 11, command: "runtime.command", params: { name: "core.file.open", params: { path: "notes.md" } } });
    await tick();
    assert.deepEqual(coreRuns.at(-1), { name: "core.file.open", params: { path: "notes.md" } });
    assert.deepEqual(calls.at(-1), { name: "pluginHostReply", arg: { plugin: "probe", generation: currentGeneration, id: 11, result: { ran: "core.file.open" } } });
    emit("plugin-host-call", { plugin: "probe", id: 12, command: "runtime.command", params: { name: "probe.open" } });
    await tick();
    assert.deepEqual(ownedRuns.at(-1), { name: "probe.open", params: null, owner: "probe" });
    assert.deepEqual(calls.at(-1), { name: "pluginHostReply", arg: { plugin: "probe", generation: currentGeneration, id: 12, result: { ran: "probe.open", owner: "probe" } } });
    // Each refused name runs nothing and answers the named error of the plugin host call.
    const refusals = [
      [{ name: "" }, "plugin host call runtime.command requires a non-empty name"],
      [{ name: "other.open" }, "command other.open belongs to other, not probe"],
      [{ name: "open" }, "plugin host call open names no owner"],
      [{ name: "tab.state.read" }, "plugin host call tab.state.read is not served"],
    ];
    const runs = coreRuns.length + ownedRuns.length;
    for (const [params, message] of refusals) {
      emit("plugin-host-call", { plugin: "probe", id: 13, command: "runtime.command", params });
      await tick();
      assert.deepEqual(calls.at(-1).arg.error, { code: -32000, message });
    }
    assert.equal(coreRuns.length + ownedRuns.length, runs, "a refused command call ran a command");
  } finally {
    await closePluginHost(pluginHost);
  }
});

// contract: plugin-host.log.write
test("runtime.log writes the record of the plugin through its log with the checks of the plugin context", async () => {
  const pluginHost = listen();
  try {
    emit("plugin-host-call", { plugin: "probe", id: 14, command: "runtime.log", params: { level: "info", event: "input.key", fields: { key: "a" }, cids: ["c.1"] } });
    await tick();
    assert.deepEqual(logWrites.at(-1), { plugin: "probe", level: "info", event: "input.key", fields: { key: "a" }, options: { cids: ["c.1"] } });
    assert.deepEqual(calls.at(-1), { name: "pluginHostReply", arg: { plugin: "probe", generation: currentGeneration, id: 14, result: null } });
    emit("plugin-host-call", { plugin: "probe", id: 15, command: "runtime.log", params: { level: "warn", event: "list.failed", fields: { reason: "x" } } });
    await tick();
    assert.deepEqual(logWrites.at(-1), { plugin: "probe", level: "warn", event: "list.failed", fields: { reason: "x" }, options: undefined });
    // A level outside the five levels writes nothing and answers the named error.
    const count = logWrites.length;
    for (const level of ["enabled", "bogus", undefined]) {
      emit("plugin-host-call", { plugin: "probe", id: 16, command: "runtime.log", params: { level, event: "x.y", fields: {} } });
      await tick();
      assert.deepEqual(calls.at(-1).arg.error, { code: -32000, message: "plugin host call runtime.log log level must be one of error, warn, info, debug, trace" });
    }
    assert.equal(logWrites.length, count, "a refused log call wrote a record");
  } finally {
    await closePluginHost(pluginHost);
  }
});

// contract: plugin-host.error.display
test("runtime.error writes the listing error of the plugin through the error display and answers null", async () => {
  const pluginHost = listen();
  try {
    emit("plugin-host-call", { plugin: "probe", id: 9, command: "runtime.error", params: { where: "listing", text: "cannot read folder" } });
    await tick();
    assert.deepEqual(displays, ["plugin probe listing: cannot read folder"]);
    assert.deepEqual(calls.at(-1), { name: "pluginHostReply", arg: { plugin: "probe", generation: currentGeneration, id: 9, result: null } });
    // Each refused value writes nothing and answers the named error.
    const refusals = [
      [{ where: "", text: "x" }, 'plugin host call runtime.error requires a non-empty where without a control character or ": "'],
      [{ where: "a: b", text: "x" }, 'plugin host call runtime.error requires a non-empty where without a control character or ": "'],
      [{ where: "listing", text: "" }, "plugin host call runtime.error requires a non-empty text"],
    ];
    for (const [params, message] of refusals) {
      emit("plugin-host-call", { plugin: "probe", id: 10, command: "runtime.error", params });
      await tick();
      assert.deepEqual(calls.at(-1).arg.error, { code: -32000, message });
    }
    assert.equal(displays.length, 1, "a refused error call wrote a display line");
  } finally {
    await closePluginHost(pluginHost);
  }
});

test("a served registration call registers the entry under the key of its plugin", async () => {
  const pluginHost = listen();
  emit("plugin-host-call", { plugin: "probe", id: 1, command: "page.exposure.register", params: { kind: "status", name: "probe.lines" } });
  await tick();
  assert.deepEqual(registered, [{ plugin: "probe", kind: "status", name: "probe.lines" }]);
  assert.deepEqual(calls.at(-1), { name: "pluginHostReply", arg: { plugin: "probe", generation: currentGeneration, id: 1, result: null } });
  assert.notEqual(hostCommandsOf("probe"), null, "the served call kept no command layer");
  await closePluginHost(pluginHost);
});

test("a served command call registers the command and a request of the main page runs through the layer of the host", async () => {
  const pluginHost = listen();
  emit("plugin-host-call", { plugin: "probe", id: 2, command: "runtime.command.register", params: { name: "probe.run" } });
  await tick();
  assert.deepEqual(registered.at(-1), { plugin: "probe", kind: "command", name: "probe.run" });
  // A request of the main page goes to the host through pluginHostRequest and resolves with the reply of the page.
  const layer = hostCommandsOf("probe");
  const result = layer.run("probe.run", { a: 1 });
  await tick();
  assert.deepEqual(calls.at(-1), { name: "pluginHostRequest", arg: { plugin: "probe", generation: currentGeneration, id: calls.at(-1).arg.id, command: "probe.run", params: { a: 1 } } });
  emit("plugin-host-reply", { plugin: "probe", id: calls.at(-1).arg.id, result: { n: 3 } });
  assert.deepEqual(await result, { n: 3 });
  await closePluginHost(pluginHost);
});

test("an unserved call is refused and registers nothing", async () => {
  const pluginHost = listen();
  for (const command of ["tab.state.read", "state.read", "runtime.clipboard.read", "runtime.native.off"]) {
    const count = registered.length;
    emit("plugin-host-call", { plugin: "probe", id: 3, command, params: {} });
    await tick();
    assert.equal(registered.length, count, `the call ${command} registered an entry`);
    assert.equal(calls.at(-1).name, "pluginHostReply");
    assert.deepEqual(calls.at(-1).arg.error, { code: -32000, message: `plugin host call ${command} is not served` });
  }
  await closePluginHost(pluginHost);
});

test("runtime.data.get and runtime.data.set are answered by the project data of the shown project", async () => {
  const pluginHost = listen();
  emit("plugin-host-call", { plugin: "probe", id: 6, command: "runtime.data.get", params: { key: "note" } });
  await tick();
  assert.deepEqual(projectCalls.at(-1), ["get", "probe", "note"]);
  assert.deepEqual(calls.at(-1), { name: "pluginHostReply", arg: { plugin: "probe", generation: currentGeneration, id: 6, result: "kept" } });
  emit("plugin-host-call", { plugin: "probe", id: 7, command: "runtime.data.set", params: { key: "note", value: "new" } });
  await tick();
  assert.deepEqual(projectCalls.at(-1), ["set", "probe", "note", "new"]);
  assert.deepEqual(calls.at(-1), { name: "pluginHostReply", arg: { plugin: "probe", generation: currentGeneration, id: 7, result: null } });
  // A refusal of the project data reaches the page as the error of its call, with the text of the refusal.
  projectRefusal = "plugin probe data other is not declared";
  emit("plugin-host-call", { plugin: "probe", id: 8, command: "runtime.data.get", params: { key: "other" } });
  await tick();
  assert.deepEqual(calls.at(-1).arg.error, { code: -32000, message: "plugin probe data other is not declared" });
  projectRefusal = "plugin host probe: no project is shown";
  emit("plugin-host-call", { plugin: "probe", id: 9, command: "runtime.data.set", params: { key: "note", value: "x" } });
  await tick();
  assert.deepEqual(calls.at(-1).arg.error, { code: -32000, message: "plugin host probe: no project is shown" });
  projectRefusal = null;
  // A call without a key, or a set without a value, is refused before the project data is reached.
  const reached = projectCalls.length;
  emit("plugin-host-call", { plugin: "probe", id: 10, command: "runtime.data.get", params: {} });
  emit("plugin-host-call", { plugin: "probe", id: 11, command: "runtime.data.set", params: { key: "note" } });
  await tick();
  assert.equal(projectCalls.length, reached, "a refused call reached the project data");
  assert.deepEqual(calls.at(-2).arg.error, { code: -32000, message: "plugin host call runtime.data.get requires a key" });
  assert.deepEqual(calls.at(-1).arg.error, { code: -32000, message: "plugin host call runtime.data.set requires a value" });
  await closePluginHost(pluginHost);
});

test("a cancel opens no call and a call with an invalid envelope is reported", async () => {
  const pluginHost = listen();
  const count = registered.length;
  emit("plugin-host-call", { plugin: "probe", id: 4, cancel: true });
  await tick();
  assert.equal(registered.length, count, "a cancel registered an entry");
  emit("plugin-host-call", "not an object");
  await tick();
  assert.deepEqual(reports.at(-1), "plugin host call has no integer id");
  await closePluginHost(pluginHost);
});

test("a registration that the registry refuses is answered as an error", async () => {
  const pluginHost = listenPluginHostCalls({
    register: () => { throw new Error("plugin probe cannot register status other.lines"); },
    unregister: () => {},
    timeoutOf: () => undefined,
    report: reports.push.bind(reports),
    displayError: displays.push.bind(displays),
    runCore: () => {},
    runOwned: () => {},
    pluginLog: () => ({}),
  });
  emit("plugin-host-call", { plugin: "probe", id: 5, command: "page.exposure.register", params: { kind: "status", name: "other.lines" } });
  await tick();
  assert.deepEqual(calls.at(-1).arg.error, { code: -32000, message: "plugin probe cannot register status other.lines" });
  await closePluginHost(pluginHost);
});

test("plugin-host-ended removes the registrations of the host and ends its open requests", async () => {
  const pluginHost = listen();
  const unregisteredAtStart = unregistered.length;
  emit("plugin-host-call", { plugin: "probe", id: 6, command: "runtime.command.register", params: { name: "probe.run" } });
  await tick();
  const pending = hostCommandsOf("probe").run("probe.run", null);
  await tick();
  const ended = assert.rejects(pending, /surface-closed/);
  emit("plugin-host-ended", { plugin: "probe" });
  await tick();
  assert.deepEqual(unregistered.slice(unregisteredAtStart), ["probe"]);
  await ended;
  assert.equal(hostCommandsOf("probe"), null, "the ended host kept its command layer");
  pluginHost.close();
  await tick();
});

test("an old plugin-host-ended removes only its generation registrations and preserves the replacement", async () => {
  const registrations = new Map();
  const removals = [];
  seedSourceOrigins({ floor: issuedGeneration, pluginHosts: {}, views: {} });
  const pluginHost = listen({
    onRegister: (plugin, kind, name, generation) => registrations.set(name, { plugin, kind, generation }),
    onUnregister: (plugin, generation) => {
      removals.push({ plugin, generation });
      for (const [name, registration] of registrations) {
        if (registration.plugin === plugin && registration.generation === generation) registrations.delete(name);
      }
    },
  });
  const oldGeneration = ++issuedGeneration;
  currentGeneration = oldGeneration;
  registerSourceOrigin("probe", null, oldGeneration);
  emit("plugin-host-call", { plugin: "probe", generation: oldGeneration, id: 102, command: "page.exposure.register", params: { kind: "status", name: "probe.old" } });
  await tick();

  const current = ++issuedGeneration;
  currentGeneration = current;
  registerSourceOrigin("probe", null, current);
  emit("plugin-host-call", { plugin: "probe", generation: current, id: 103, command: "page.exposure.register", params: { kind: "status", name: "probe.current" } });
  await tick();
  emit("plugin-host-call", { plugin: "probe", generation: current, id: 104, command: "runtime.native.on", params: { name: "exposure-request" } });
  await tick();
  emit("plugin-host-call", { plugin: "probe", generation: current, id: 105, command: "runtime.sidecar.on", params: { id: session, sidecar: "fixture-sidecar" } });
  await tick();
  const currentLayer = hostCommandsOf("probe");

  const callsBeforeOldEnd = calls.length;
  emit("plugin-host-ended", { plugin: "probe", generation: oldGeneration });
  await tick();

  assert.deepEqual(removals, [{ plugin: "probe", generation: oldGeneration }], "the retired host registrations were not removed");
  assert.equal(registrations.has("probe.old"), false, "the retired host left an exposure registration behind");
  assert.deepEqual(registrations.get("probe.current"), { plugin: "probe", kind: "status", generation: current },
    "the retired host removal deleted the replacement registration");
  assert.equal(hostCommandsOf("probe"), currentLayer, "the retired host end closed the replacement command layer");
  assert.equal(hostCommandGeneration("probe"), current, "the retired host end changed the replacement generation");
  assert.equal(calls.slice(callsBeforeOldEnd).some((call) => call.name === "pluginHostSidecarClose"), false,
    "the retired host end closed replacement sessions");
  emit("sidecar-message", { surface: session, sidecar: "fixture-sidecar", body: { n: 9 } });
  await tick();
  assert.deepEqual(calls.at(-1), {
    name: "pluginHostEvent",
    arg: { plugin: "probe", generation: current, event: "sidecar.message", data: { sidecar: "fixture-sidecar", id: session, body: { n: 9 } } },
  }, "the retired host end removed the replacement session subscription");

  await closePluginHost(pluginHost);
});

// The main page asks the host to close the sessions that its window owns, when the host ends (docs/plans/plugin-host-routes.md rule 7).
test("plugin-host-ended asks the host to close the plugin sessions of its window", async () => {
  const pluginHost = listen();
  emit("plugin-host-call", { plugin: "probe", id: 100, command: "runtime.native.on", params: { name: "exposure-request" } });
  await tick();
  const posted = calls.length;
  emit("plugin-host-ended", { plugin: "probe" });
  await tick();
  assert.deepEqual(calls.slice(posted).filter((call) => call.name === "pluginHostSidecarClose"), [{ name: "pluginHostSidecarClose", arg: { plugin: "probe" } }]);
  pluginHost.close();
  await tick();
});

test("keepHostCommands keeps the layer that a later listener of the same plugin receives", () => {
  const layer = { run: () => Promise.resolve(null), receive: () => {}, close: () => {} };
  const forget = keepHostCommands("other", layer, 1);
  assert.equal(hostCommandsOf("other"), layer);
  forget();
  assert.equal(hostCommandsOf("other"), null);
});

test("the served sidecar calls record a subscription and send the checked body to the host call", async () => {
  const pluginHost = listen();
  emit("plugin-host-call", { plugin: "probe", id: 7, command: "runtime.sidecar.on", params: { id: session, sidecar: "fixture-sidecar" } });
  await tick();
  assert.deepEqual(calls.at(-1), { name: "pluginHostReply", arg: { plugin: "probe", generation: currentGeneration, id: 7, result: null } });
  emit("plugin-host-call", { plugin: "probe", id: 8, command: "runtime.sidecar.onFailure", params: { id: session, sidecar: "fixture-sidecar" } });
  await tick();
    assert.deepEqual(calls.at(-1).arg, { plugin: "probe", generation: currentGeneration, id: 8, result: null });
  emit("plugin-host-call", { plugin: "probe", id: 9, command: "runtime.sidecar.send", params: { id: session, sidecar: "fixture-sidecar", body: { "operation": "list", "path": "a" }, cids: ["c1"] } });
  await tick();
  assert.deepEqual(calls.at(-2), { name: "pluginHostSidecarSend", arg: { plugin: "probe", sidecar: "fixture-sidecar", id: session, body: { operation: "list", path: "a" }, cids: ["c1"] } });
  assert.deepEqual(calls.at(-1), { name: "pluginHostReply", arg: { plugin: "probe", generation: currentGeneration, id: 9, result: null } });
  await closePluginHost(pluginHost);
});

test("a sidecar call refuses a sidecar the plugin does not declare, a session of another name and an undeclared operation", async () => {
  const pluginHost = listen();
  const refusals = [
    [{ id: session, sidecar: "other-sidecar", body: {"operation":"list"} }, "plugin host probe cannot use sidecar other-sidecar"],
    [{ id: "plugin:other:project-a:fixture-sidecar", sidecar: "fixture-sidecar", body: {"operation":"list"} }, `plugin host probe cannot use sidecar session plugin:other:project-a:fixture-sidecar`],
    [{ id: "plugin:probe:project-a:fixture-sidecar:extra", sidecar: "fixture-sidecar", body: {"operation":"list"} }, "plugin host probe cannot use sidecar session plugin:probe:project-a:fixture-sidecar:extra"],
    [{ id: session, sidecar: "fixture-sidecar", body: {"operation":"write"} }, "plugin host probe: operation write is not served"],
  ];
  for (const [params, message] of refusals) {
    const count = calls.length;
    emit("plugin-host-call", { plugin: "probe", id: 10, command: "runtime.sidecar.send", params });
    await tick();
    assert.equal(calls.some((call, index) => index >= count && call.name === "pluginHostSidecarSend"), false, `${message} reached the host call`);
    assert.deepEqual(calls.at(-1).arg.error, { code: -32000, message });
  }
  await closePluginHost(pluginHost);
});

test("a declared sidecar whose sidecar.json the page does not hold refuses every operation with the named error", async () => {
  // The installed document carries no sidecar declarations, so the declaration of a declared sidecar is null (docs/plans/plugin-host-routes.md rule 8).
  currentGeneration = ++issuedGeneration;
  const pluginHost = listenPluginHostCalls({
    register: () => {}, unregister: () => {}, timeoutOf: () => undefined, report: () => {}, displayError: () => {},
    sidecarsOf: (plugin) => (plugin === "probe" ? [{ name: "fixture-sidecar", declared: ["list"], declaration: null }] : []),
    runCore: () => {}, runOwned: () => {}, pluginLog: () => ({}),
  });
  const count = calls.length;
  emit("plugin-host-call", { plugin: "probe", id: 11, command: "runtime.sidecar.send", params: { id: session, sidecar: "fixture-sidecar", body: {"operation":"list"} } });
  await tick();
  assert.equal(calls.some((call, index) => index >= count && call.name === "pluginHostSidecarSend"), false);
  assert.deepEqual(calls.at(-1).arg.error, { code: -32000, message: "plugin host probe: sidecar fixture-sidecar declares no message form" });
  await closePluginHost(pluginHost);
});

// contract: plugin-host.channel.call-served-set
test("the registration notice of a view call, runtime.native.call registered, registers the entry of the host like page.exposure.register", async () => {
  const pluginHost = listen();
  const count = registered.length;
  try {
    emit("plugin-host-call", { plugin: "probe", id: 40, command: "runtime.native.call", params: { name: "registered", payload: { kind: "dom", name: "probe.lines" } } });
    await tick();
    assert.deepEqual(registered.slice(count), [{ plugin: "probe", kind: "dom", name: "probe.lines" }]);
    assert.deepEqual(calls.at(-1).arg, { plugin: "probe", generation: currentGeneration, id: 40, result: null });
    emit("plugin-host-call", { plugin: "probe", id: 41, command: "runtime.native.call", params: { name: "registered", payload: { kind: "file", name: "probe.lines" } } });
    await tick();
    assert.equal(registered.length, count + 1, "a registration of an unknown kind registered an entry");
    assert.equal(calls.at(-1).arg.error.message, "plugin host call runtime.native.call registered requires a status or dom kind");
  } finally {
    await closePluginHost(pluginHost);
  }
});

// contract: plugin-host.channel.call-served-set
test("runtime.native.on subscribes to declared UI expansion and exposure requests, and refuses other events", { timeout: 10000 }, async () => {
  const pluginHost = listen();
  const count = calls.length;
  try {
    emit("plugin-host-call", { plugin: "probe", id: 30, command: "runtime.native.on", params: { name: "exposure-request" } });
    await tick();
    assert.deepEqual(calls.slice(count).filter((call) => call.name === "pluginHostReply"), [
      { name: "pluginHostReply", arg: { plugin: "probe", generation: currentGeneration, id: 30, result: null } },
    ]);
    emit("plugin-host-call", { plugin: "probe", id: 31, command: "runtime.native.on", params: { name: "declared-ui.expanded" } });
    await tick();
    assert.deepEqual(calls.slice(count).filter((call) => call.name === "pluginHostReply"), [
      { name: "pluginHostReply", arg: { plugin: "probe", generation: currentGeneration, id: 30, result: null } },
      { name: "pluginHostReply", arg: { plugin: "probe", generation: currentGeneration, id: 31, result: null } },
    ]);
    emit("plugin-host-call", { plugin: "probe", id: 32, command: "runtime.native.on", params: { name: "document-state" } });
    await tick();
    assert.equal(calls.at(-1).arg.error.code, -32000);
    assert.equal(calls.at(-1).arg.error.message, "native event document-state is not served to a plugin host");
  } finally {
    calls.splice(count);
    await closePluginHost(pluginHost);
  }
});

test("declared UI expansion subscription does not enable exposure requests", { timeout: 10000 }, async () => {
  const pluginHost = listen();
  const start = calls.length;
  try {
    emit("plugin-host-call", { plugin: "probe", id: 34, command: "runtime.native.on", params: { name: "declared-ui.expanded" } });
    await tick();
    const reply = forwardHostExposure("probe", "dom.rect", { name: "probe.canvas" }).then(() => "resolved", (error) => error.message);
    await tick();
    const forwarded = calls.slice(start).some((call) => call.name === "pluginHostEvent" && call.arg.event === "exposure-request");
    assert.equal(await reply, "plugin host probe has no exposure-request subscription");
    assert.equal(forwarded, false);
  } finally {
    calls.splice(start);
    await closePluginHost(pluginHost);
  }
});

// contract: plugin-host.channel.call-served-set
test("a dom request of a host-registered entry reaches the host page as exposure-request and is answered by its exposureReply", async () => {
  const pluginHost = listen();
  const start = calls.length;
  try {
    emit("plugin-host-call", { plugin: "probe", id: 34, command: "runtime.error", params: { where: "fixture", text: "source ready" } });
    await tick();
    const refused = await forwardHostExposure("probe", "dom.rect", { name: "probe.canvas" }).then(() => null, (error) => error.message);
    assert.equal(refused, "plugin host probe has no exposure-request subscription");
    emit("plugin-host-call", { plugin: "probe", id: 32, command: "runtime.native.on", params: { name: "exposure-request" } });
    await tick();
    const posted = calls.length;
    const answer = forwardHostExposure("probe", "dom.rect", { name: "probe.canvas" });
    await tick();
    const event = calls.slice(posted).find((call) => call.name === "pluginHostEvent");
    assert.deepEqual(event, { name: "pluginHostEvent", arg: { plugin: "probe", generation: currentGeneration, event: "exposure-request", data: { id: event.arg.data.id, method: "dom.rect", params: { name: "probe.canvas" } } } });
    emit("plugin-host-call", { plugin: "probe", id: 33, command: "runtime.native.call", params: { name: "exposureReply", payload: { id: event.arg.data.id, result: { x: 1 } } } });
    await tick();
    assert.deepEqual(await answer, { result: { x: 1 } });
    assert.equal(calls.at(-1).arg.result, null);
  } finally {
    calls.splice(start);
    await closePluginHost(pluginHost);
  }
});

test("closing the plugin host call listener ends its pending exposure requests", async () => {
  const pluginHost = listen();
  emit("plugin-host-call", { plugin: "probe", id: 35, command: "runtime.native.on", params: { name: "exposure-request" } });
  await tick();
  const pending = forwardHostExposure("probe", "dom.rect", { name: "probe.canvas" });
  pending.catch(() => {});
  await tick();
  pluginHost.close();
  let settled = false;
  pending.then(() => { settled = true; }, () => { settled = true; });
  await tick();
  const refused = await forwardHostExposure("probe", "dom.rect", { name: "probe.canvas" }).then(() => null, (error) => error.message);
  assert.match(refused, /^plugin host probe (?:has no exposure-request subscription|has no current source generation)$/);
  assert.equal(settled, true, "closing the host listener left a DOM request open");
});

// contract: plugin-host.channel.call-served-set
test("the open calls of a plugin host are its plugin status, not an error record", async () => {
  const { openCalls } = await import("../plugin-processes.js");
  currentGeneration = ++issuedGeneration;
  registerSourceOrigin("probe", null, currentGeneration);
  const commands = createHostCommands({ plugin: "probe", generation: currentGeneration, timeoutOf: () => undefined });
  const errors = [];
  // Calls of the earlier cases of this file may still be open, so the status is read as the difference that this call makes.
  const open = () => openCalls().find((entry) => entry.plugin === "probe")?.count ?? 0;
  const before = open();
  const pending = commands.run("probe.send", {});
  // The call is open: the status of the plugin counts it, and no record reaches the error display.
  assert.equal(open(), before + 1);
  assert.deepEqual(errors, []);
  commands.receive({ id: 1, generation: currentGeneration, error: { code: -32000, message: "refused" } });
  await assert.rejects(pending, /refused/);
  assert.equal(open(), before, "the answered call still counts as open");
  commands.close();
});

test("a failure of a subscribed plugin session is posted to its host page as the failure event", async () => {
  const pluginHost = listen();
  const start = calls.length;
  try {
    emit("plugin-host-call", { plugin: "probe", id: 12, command: "runtime.sidecar.onFailure", params: { id: session, sidecar: "fixture-sidecar" } });
    await tick();
    const posted = calls.length;
    emit("sidecar-failure", { surface: session, sidecar: "fixture-sidecar", reason: "exited" });
    await tick();
    // The event carries the data of the session event that the page listens to, as the host event {sok, event, data} requires.
    assert.deepEqual(calls.slice(posted), [{ name: "pluginHostEvent", arg: { plugin: "probe", generation: currentGeneration, event: "sidecar.failure", data: { sidecar: "fixture-sidecar", id: session, reason: "exited" } } }]);
  } finally {
    // The end of the host removes its session subscriptions, and the calls of this case leave the record, which the later cases of this file assume.
    calls.splice(start);
    await closePluginHost(pluginHost);
  }
});

test("a sidecar message of a plugin session reaches its host page only with a subscription, and the end of the host drops it", async () => {
  // An earlier test may have subscribed the same session; the host of this test starts with none.
  const pluginHost = listen();
  emit("plugin-host-ended", { plugin: "probe" });
  await tick();
  const posted = calls.length;
  emit("sidecar-message", { surface: session, sidecar: "fixture-sidecar", body: { n: 1 } });
  await tick();
  assert.equal(calls.slice(posted).some((call) => call.name === "pluginHostEvent"), false, "a message with no subscription was posted");
  emit("plugin-host-call", { plugin: "probe", id: 11, command: "runtime.sidecar.on", params: { id: session, sidecar: "fixture-sidecar" } });
  await tick();
  emit("sidecar-message", { surface: session, sidecar: "fixture-sidecar", body: { n: 2 } });
  await tick();
  assert.deepEqual(calls.at(-1), { name: "pluginHostEvent", arg: { plugin: "probe", generation: currentGeneration, event: "sidecar.message", data: { sidecar: "fixture-sidecar", id: session, body: { n: 2 } } } });
  emit("sidecar-failure", { surface: session, sidecar: "fixture-sidecar", reason: "exited" });
  await tick();
  assert.equal(calls.slice(posted).some((call) => call.name === "pluginHostEvent" && call.arg.event === "sidecar.failure"), false, "a failure with no failure subscription was posted");
  emit("plugin-host-ended", { plugin: "probe" });
  await tick();
  const after = calls.length;
  emit("sidecar-message", { surface: session, sidecar: "fixture-sidecar", body: { n: 3 } });
  await tick();
  assert.equal(calls.slice(after).some((call) => call.name === "pluginHostEvent"), false, "the ended host still received a message");
  await closePluginHost(pluginHost);
});

test("a host reply that arrives after its layer left is reported, not dropped", async () => {
  const pluginHost = listen();
  try {
    emit("plugin-host-call", { plugin: "probe", id: 98, command: "runtime.error", params: { where: "fixture", text: "source ready" } });
    await tick();
    const forget = keepHostCommands("probe", { run: () => Promise.resolve(null), receive: () => {}, close: () => {} }, currentGeneration);
    forget();
    reports.length = 0;
    emit("plugin-host-reply", { plugin: "probe", id: 99, result: null });
    await tick();
    assert.deepEqual(reports, ["plugin host reply 99 arrived after its host layer left"]);
  } finally {
    await closePluginHost(pluginHost);
  }
});
