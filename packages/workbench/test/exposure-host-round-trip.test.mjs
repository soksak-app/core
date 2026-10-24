// Checks the success path of a dom request that the registry forwards to a plugin host page: the request reaches the host page as
// the exposure-request event, the page's exposureReply answers it, and the result returns to the caller of the registry. The
// runtime is a fake host, and the plugin host calls arrive through the listener that the test installs.
import assert from "node:assert/strict";
import test, { mock } from "node:test";

const hostCalls = [];
const listeners = new Map();
const generation = 1;
mock.module("@soksak/runtime", { namedExports: {
  host: {
    call: (name, arg) => {
      hostCalls.push({ name, arg });
      if (name === "declaredSourceOrigins") return Promise.resolve({ floor: 0, pluginHosts: {}, views: {} });
      return Promise.resolve(null);
    },
    on: (name, listener) => {
      let set = listeners.get(name);
      if (!set) listeners.set(name, set = new Set());
      set.add(listener);
      return Promise.resolve(() => set.delete(listener));
    },
  },
  page: null,
  windows: {},
} });
const emit = (name, event) => {
  const sourceEvent = name.startsWith("plugin-host-") && event?.generation === undefined ? { ...event, generation } : event;
  for (const listener of [...(listeners.get(name) ?? [])]) listener(sourceEvent);
};
const tick = () => new Promise((resolve) => setImmediate(resolve));

const { createRegistry } = await import("../exposure.js");
const { listenPluginHostCalls } = await import("../plugin-host.js");

// The reports of the page are collected: the test asserts that none is an error.
const reports = [];
const probeExposes = {
  dom: [{ name: "probe.lines", description: "Output." }],
};

test("a dom request of a host-registered entry returns the result of the page's exposureReply to the registry caller", async () => {
  const registry = createRegistry({ call: async () => null, report: (error) => reports.push(error) });
  registry.declare("probe", probeExposes);
  const pluginHost = listenPluginHostCalls({
    register: (plugin, kind, name, generation) => registry.hostRegistered({ plugin, kind, name, generation }),
    unregister: (plugin, generation) => registry.hostUnregistered(plugin, generation),
    timeoutOf: () => undefined,
    report: (error) => reports.push(error),
    displayError: () => {},
    sidecarsOf: () => [],
    runCore: () => Promise.resolve(null),
    runOwned: () => Promise.resolve(null),
    pluginLog: () => Object.fromEntries(["error", "warn", "info", "debug", "trace"].map((level) => [level, () => {}])),
  });
  try {
    emit("plugin-host-call", { plugin: "probe", id: 1, command: "page.exposure.register", params: { kind: "dom", name: "probe.lines" } });
    await tick();
    emit("plugin-host-call", { plugin: "probe", id: 2, command: "runtime.native.on", params: { name: "exposure-request" } });
    await tick();
    const sent = hostCalls.length;
    const answer = registry.handle({ method: "dom.rect", params: { name: "probe.lines" } });
    await tick();
    const event = hostCalls.slice(sent).find((call) => call.name === "pluginHostEvent");
    assert.ok(event, `the dom request reached no host page as pluginHostEvent: ${JSON.stringify({ hostCalls, reports })}`);
    assert.deepEqual(event.arg, {
      plugin: "probe",
      generation,
      event: "exposure-request",
      data: { id: event.arg.data.id, method: "dom.rect", params: { name: "probe.lines" } },
    });
    emit("plugin-host-call", {
      plugin: "probe",
      id: 3,
      command: "runtime.native.call",
      params: { name: "exposureReply", payload: { id: event.arg.data.id, result: { x: 1, width: 10 } } },
    });
    await tick();
    // The registry gives a dom.rect result without a document the document origin of the application document.
    assert.deepEqual(await answer, { result: { x: 1, width: 10, document: { x: 0, y: 0 } } });
    // The answered request leaves no open exposure request: a second reply with the same id is refused.
    emit("plugin-host-call", {
      plugin: "probe",
      id: 4,
      command: "runtime.native.call",
      params: { name: "exposureReply", payload: { id: event.arg.data.id, result: null } },
    });
    await tick();
    assert.equal(hostCalls.at(-1).name, "pluginHostReply");
    assert.equal(hostCalls.at(-1).arg.generation, generation);
    assert.equal(hostCalls.at(-1).arg.error.message, `plugin host probe answered no open exposure request ${event.arg.data.id}`);
  } finally {
    emit("plugin-host-ended", { plugin: "probe" });
    pluginHost.close();
  }
  // A kind of open-calls notice reports the count of open calls at the end of the host; every other report is a failure.
  assert.deepEqual(reports.filter((report) => report?.kind !== "open-calls").map((error) => error?.message ?? error), []);
});
