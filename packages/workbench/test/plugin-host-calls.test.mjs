// Checks the page side of the plugin host channel (plugin-host.js): the served call set of a host page registers its
// entries under the owner key plugin:<plugin id>, an unserved call is refused, and the requests of the main page run
// through the layer of the host, whose replies arrive as the plugin-host-reply events. The runtime is a fake host.
import assert from "node:assert/strict";
import test, { mock } from "node:test";

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
mock.module("@soksak/plugin-api", { namedExports: {
  SNAPSHOT_EVENT: "declared-ui.snapshot",
  SNAPSHOT_ACK_EVENT: "declared-ui.snapshot.ack",
  SNAPSHOT_REQUEST_COMMAND: "declared-ui.snapshot.request",
  DEFAULT_CALL_TIMEOUT: 10000,
  createCalls: ({ send, onMessage }) => {
    let nextId = 0;
    const open = new Map();
    onMessage((message) => {
      const call = open.get(message.id);
      if (!call) return;
      open.delete(message.id);
      if (message.error) call.reject(new Error(message.error.message));
      else call.resolve(message.result);
    });
    return {
      request: (command, params) => new Promise((resolve, reject) => {
        const id = ++nextId;
        open.set(id, { resolve, reject });
        send({ id, command, params });
      }),
      peerLost: (reason) => { for (const { reject } of open.values()) reject(new Error(reason)); open.clear(); },
    };
  },
  EXPOSURE_ERRORS: {},
  LOG_LEVELS: { error: "error", warn: "warn", info: "info", debug: "debug" },
} });
const emit = (name, event) => { for (const listener of [...(listeners.get(name) ?? [])]) listener(event); };
const tick = () => new Promise((resolve) => setImmediate(resolve));

const { listenPluginHostCalls, hostCommandsOf, keepHostCommands } = await import("../plugin-host.js");
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
function listen() {
  return listenPluginHostCalls({
    register: (plugin, kind, name) => registered.push({ plugin, kind, name }),
    unregister: (plugin) => unregistered.push(plugin),
    timeoutOf: () => undefined,
    report: (error) => reports.push(String(error?.message ?? error)),
    displayError: (line) => displays.push(line),
    sidecarsOf: (plugin) => (plugin === "probe" ? probeSidecars : []),
    projectData,
  });
}

// contract: plugin-host.error.display
test("runtime.error writes the listing error of the plugin through the error display and answers null", async () => {
  const pluginHost = listen();
  try {
    emit("plugin-host-call", { plugin: "probe", id: 9, command: "runtime.error", params: { where: "listing", text: "cannot read folder" } });
    await tick();
    assert.deepEqual(displays, ["plugin probe listing: cannot read folder"]);
    assert.deepEqual(calls.at(-1), { name: "pluginHostReply", arg: { plugin: "probe", id: 9, result: null } });
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
    pluginHost.close();
  }
});

test("a served registration call registers the entry under the key of its plugin", async () => {
  const pluginHost = listen();
  emit("plugin-host-call", { plugin: "probe", id: 1, command: "page.exposure.register", params: { kind: "status", name: "probe.lines" } });
  await tick();
  assert.deepEqual(registered, [{ plugin: "probe", kind: "status", name: "probe.lines" }]);
  assert.deepEqual(calls.at(-1), { name: "pluginHostReply", arg: { plugin: "probe", id: 1, result: null } });
  assert.notEqual(hostCommandsOf("probe"), null, "the served call kept no command layer");
  pluginHost.close();
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
  assert.deepEqual(calls.at(-1), { name: "pluginHostRequest", arg: { plugin: "probe", id: calls.at(-1).arg.id, command: "probe.run", params: { a: 1 } } });
  emit("plugin-host-reply", { plugin: "probe", id: calls.at(-1).arg.id, result: { n: 3 } });
  assert.deepEqual(await result, { n: 3 });
  pluginHost.close();
});

test("an unserved call is refused and registers nothing", async () => {
  const pluginHost = listen();
  for (const command of ["runtime.native.call", "tab.state.read", "state.read", "runtime.clipboard.read"]) {
    const count = registered.length;
    emit("plugin-host-call", { plugin: "probe", id: 3, command, params: {} });
    await tick();
    assert.equal(registered.length, count, `the call ${command} registered an entry`);
    assert.equal(calls.at(-1).name, "pluginHostReply");
    assert.deepEqual(calls.at(-1).arg.error, { code: -32000, message: `plugin host call ${command} is not served` });
  }
  pluginHost.close();
});

test("runtime.data.get and runtime.data.set are answered by the project data of the shown project", async () => {
  const pluginHost = listen();
  emit("plugin-host-call", { plugin: "probe", id: 6, command: "runtime.data.get", params: { key: "note" } });
  await tick();
  assert.deepEqual(projectCalls.at(-1), ["get", "probe", "note"]);
  assert.deepEqual(calls.at(-1), { name: "pluginHostReply", arg: { plugin: "probe", id: 6, result: "kept" } });
  emit("plugin-host-call", { plugin: "probe", id: 7, command: "runtime.data.set", params: { key: "note", value: "new" } });
  await tick();
  assert.deepEqual(projectCalls.at(-1), ["set", "probe", "note", "new"]);
  assert.deepEqual(calls.at(-1), { name: "pluginHostReply", arg: { plugin: "probe", id: 7, result: null } });
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
  pluginHost.close();
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
  pluginHost.close();
});

test("a registration that the registry refuses is answered as an error", async () => {
  const pluginHost = listenPluginHostCalls({
    register: () => { throw new Error("plugin probe cannot register status other.lines"); },
    unregister: () => {},
    timeoutOf: () => undefined,
    report: reports.push.bind(reports),
    displayError: displays.push.bind(displays),
  });
  emit("plugin-host-call", { plugin: "probe", id: 5, command: "page.exposure.register", params: { kind: "status", name: "other.lines" } });
  await tick();
  assert.deepEqual(calls.at(-1).arg.error, { code: -32000, message: "plugin probe cannot register status other.lines" });
  pluginHost.close();
});

test("plugin-host-ended removes the registrations of the host and ends its open requests", async () => {
  const pluginHost = listen();
  emit("plugin-host-call", { plugin: "probe", id: 6, command: "runtime.command.register", params: { name: "probe.run" } });
  await tick();
  const pending = hostCommandsOf("probe").run("probe.run", null);
  await tick();
  emit("plugin-host-ended", { plugin: "probe" });
  assert.deepEqual(unregistered, ["probe"]);
  await assert.rejects(pending, /surface-closed/);
  assert.equal(hostCommandsOf("probe"), null, "the ended host kept its command layer");
  pluginHost.close();
});

// The main page asks the host to close the sessions that its window owns, when the host ends (docs/plans/plugin-host-routes.md rule 7).
test("plugin-host-ended asks the host to close the plugin sessions of its window", () => {
  const pluginHost = listen();
  const posted = calls.length;
  emit("plugin-host-ended", { plugin: "probe" });
  assert.deepEqual(calls.slice(posted).filter((call) => call.name === "pluginHostSidecarClose"), [{ name: "pluginHostSidecarClose", arg: { plugin: "probe" } }]);
  pluginHost.close();
});

test("keepHostCommands keeps the layer that a later listener of the same plugin receives", () => {
  const layer = { run: () => Promise.resolve(null), receive: () => {}, close: () => {} };
  const forget = keepHostCommands("other", layer);
  assert.equal(hostCommandsOf("other"), layer);
  forget();
  assert.equal(hostCommandsOf("other"), null);
});

test("the served sidecar calls record a subscription and send the checked body to the host call", async () => {
  const pluginHost = listen();
  emit("plugin-host-call", { plugin: "probe", id: 7, command: "runtime.sidecar.on", params: { id: session, sidecar: "fixture-sidecar" } });
  await tick();
  assert.deepEqual(calls.at(-1), { name: "pluginHostReply", arg: { plugin: "probe", id: 7, result: null } });
  emit("plugin-host-call", { plugin: "probe", id: 8, command: "runtime.sidecar.onFailure", params: { id: session, sidecar: "fixture-sidecar" } });
  await tick();
  assert.deepEqual(calls.at(-1).arg, { plugin: "probe", id: 8, result: null });
  emit("plugin-host-call", { plugin: "probe", id: 9, command: "runtime.sidecar.send", params: { id: session, sidecar: "fixture-sidecar", body: '{ "operation": "list", "path": "a" }', cids: ["c1"] } });
  await tick();
  assert.deepEqual(calls.at(-2), { name: "pluginHostSidecarSend", arg: { plugin: "probe", sidecar: "fixture-sidecar", id: session, body: '{"operation":"list","path":"a"}', cids: ["c1"] } });
  assert.deepEqual(calls.at(-1), { name: "pluginHostReply", arg: { plugin: "probe", id: 9, result: null } });
  pluginHost.close();
});

test("a sidecar call refuses a sidecar the plugin does not declare, a session of another name and an undeclared operation", async () => {
  const pluginHost = listen();
  const refusals = [
    [{ id: session, sidecar: "other-sidecar", body: '{"operation":"list"}' }, "plugin host probe cannot use sidecar other-sidecar"],
    [{ id: "plugin:other:project-a:fixture-sidecar", sidecar: "fixture-sidecar", body: '{"operation":"list"}' }, `plugin host probe cannot use sidecar session plugin:other:project-a:fixture-sidecar`],
    [{ id: "plugin:probe:project-a:fixture-sidecar:extra", sidecar: "fixture-sidecar", body: '{"operation":"list"}' }, "plugin host probe cannot use sidecar session plugin:probe:project-a:fixture-sidecar:extra"],
    [{ id: session, sidecar: "fixture-sidecar", body: '{"operation":"write"}' }, "plugin host probe: operation write is not served"],
  ];
  for (const [params, message] of refusals) {
    const count = calls.length;
    emit("plugin-host-call", { plugin: "probe", id: 10, command: "runtime.sidecar.send", params });
    await tick();
    assert.equal(calls.some((call, index) => index >= count && call.name === "pluginHostSidecarSend"), false, `${message} reached the host call`);
    assert.deepEqual(calls.at(-1).arg.error, { code: -32000, message });
  }
  pluginHost.close();
});

test("a declared sidecar whose sidecar.json the page does not hold refuses every operation with the named error", async () => {
  // The installed document carries no sidecar declarations, so the declaration of a declared sidecar is null (docs/plans/plugin-host-routes.md rule 8).
  const pluginHost = listenPluginHostCalls({
    register: () => {}, unregister: () => {}, timeoutOf: () => undefined, report: () => {}, displayError: () => {},
    sidecarsOf: (plugin) => (plugin === "probe" ? [{ name: "fixture-sidecar", declared: ["list"], declaration: null }] : []),
  });
  const count = calls.length;
  emit("plugin-host-call", { plugin: "probe", id: 11, command: "runtime.sidecar.send", params: { id: session, sidecar: "fixture-sidecar", body: '{"operation":"list"}' } });
  await tick();
  assert.equal(calls.some((call, index) => index >= count && call.name === "pluginHostSidecarSend"), false);
  assert.deepEqual(calls.at(-1).arg.error, { code: -32000, message: "plugin host probe: sidecar fixture-sidecar declares no message form" });
  pluginHost.close();
});

test("a sidecar message of a plugin session reaches its host page only with a subscription, and the end of the host drops it", async () => {
  // An earlier test may have subscribed the same session; the host of this test starts with none.
  const pluginHost = listen();
  emit("plugin-host-ended", { plugin: "probe" });
  const posted = calls.length;
  emit("sidecar-message", { surface: session, sidecar: "fixture-sidecar", body: { n: 1 } });
  await tick();
  assert.equal(calls.slice(posted).some((call) => call.name === "pluginHostEvent"), false, "a message with no subscription was posted");
  emit("plugin-host-call", { plugin: "probe", id: 11, command: "runtime.sidecar.on", params: { id: session, sidecar: "fixture-sidecar" } });
  await tick();
  emit("sidecar-message", { surface: session, sidecar: "fixture-sidecar", body: { n: 2 } });
  await tick();
  assert.deepEqual(calls.at(-1), { name: "pluginHostEvent", arg: { plugin: "probe", event: "message", sidecar: "fixture-sidecar", id: session, body: { n: 2 } } });
  emit("sidecar-failure", { surface: session, sidecar: "fixture-sidecar", reason: "exited" });
  await tick();
  assert.equal(calls.some((call) => call.name === "pluginHostEvent" && call.arg.event === "failure"), false, "a failure with no failure subscription was posted");
  emit("plugin-host-ended", { plugin: "probe" });
  const after = calls.length;
  emit("sidecar-message", { surface: session, sidecar: "fixture-sidecar", body: { n: 3 } });
  await tick();
  assert.equal(calls.slice(after).some((call) => call.name === "pluginHostEvent"), false, "the ended host still received a message");
  pluginHost.close();
});
