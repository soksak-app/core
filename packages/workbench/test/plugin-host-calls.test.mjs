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
} });
const emit = (name, event) => { for (const listener of [...(listeners.get(name) ?? [])]) listener(event); };
const tick = () => new Promise((resolve) => setImmediate(resolve));

const { listenPluginHostCalls, hostCommandsOf, keepHostCommands } = await import("../plugin-host.js");

const registered = [];
const unregistered = [];
const reports = [];
function listen() {
  return listenPluginHostCalls({
    register: (plugin, kind, name) => registered.push({ plugin, kind, name }),
    unregister: (plugin) => unregistered.push(plugin),
    timeoutOf: () => undefined,
    report: (error) => reports.push(String(error?.message ?? error)),
  });
}

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

test("keepHostCommands keeps the layer that a later listener of the same plugin receives", () => {
  const layer = { run: () => Promise.resolve(null), receive: () => {}, close: () => {} };
  const forget = keepHostCommands("other", layer);
  assert.equal(hostCommandsOf("other"), layer);
  forget();
  assert.equal(hostCommandsOf("other"), null);
});
