import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { validateExposureFile } from "@soksak/plugin-api";

const PLUGIN_STATUSES = ["core.plugin.open-calls", "core.plugin.losses", "core.plugin.views"];

const declaredExposure = () => validateExposureFile(JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")));

test("the plugin process statuses are declared by the core exposure file", () => {
  const { status } = declaredExposure().exposes;
  const names = status.map((entry) => entry.name);
  for (const name of PLUGIN_STATUSES) assert.ok(names.includes(name), `${name} is not declared in exposure.json`);
});

test("each plugin process status is registered and publishes its empty initial value", async () => {
  const { createRegistry } = await import("../exposure.js");
  const { losses, openCalls, views } = await import("../plugin-processes.js");
  const readers = { "core.plugin.open-calls": openCalls, "core.plugin.losses": losses, "core.plugin.views": views };
  const made = createRegistry();
  made.declare("core", declaredExposure().exposes);
  for (const name of PLUGIN_STATUSES) made.status(name, readers[name], () => () => {});
  for (const name of PLUGIN_STATUSES) {
    const empty = await made.handle({ method: "status.get", params: { name } });
    assert.deepEqual(empty, { result: [] }, `${name} initial value`);
  }
});

test("the reports of call layers fill the open-call and loss statuses, and each change is announced", async () => {
  const { createCalls } = await import("@soksak/plugin-api");
  const { callReporter, losses, openCalls, onPluginProcessChange } = await import("../plugin-processes.js");
  let announced = 0;
  const stop = onPluginProcessChange(() => { announced += 1; });
  // The clock of the layers is a declared parameter of createCalls: the start of each call is the instant that the test gives.
  const clock = 1000;
  const layer = () => createCalls({
    plugin: "probe",
    send: () => {},
    onMessage: () => () => {},
    report: callReporter("probe"),
    now: () => clock,
  });
  const started = clock;
  const first = layer();
  const controller = new AbortController();
  const cancelled = first.request("probe.run", {}, { signal: controller.signal });
  const cancelRejected = assert.rejects(cancelled, { reason: "cancelled" });
  const second = layer();
  const read = second.request("probe.read");
  const readRejected = assert.rejects(read, { reason: "process-ended" });
  assert.deepEqual(openCalls(), [{ plugin: "probe", count: 2, oldestStartedAt: started }]);
  controller.abort();
  await cancelRejected;
  assert.deepEqual(openCalls(), [{ plugin: "probe", count: 1, oldestStartedAt: started }]);
  second.peerLost("process-ended");
  await readRejected;
  assert.deepEqual(openCalls(), []);
  assert.deepEqual(losses(), [], "a cancel or the end of a process counted a loss");
  const closed = layer();
  const surfaceClosed = closed.request("probe.run");
  const surfaceRejected = assert.rejects(surfaceClosed, { reason: "surface-closed" });
  closed.peerLost("surface-closed");
  await surfaceRejected;
  assert.deepEqual(losses(), [{ plugin: "probe", abandoned: 0, lateReplies: 0, peerLost: 1 }]);
  assert.ok(announced > 0);
  stop();
});

test("the losses of a plugin count no timeout, and a report of the kind timeout is refused", async () => {
  const { callReporter, losses } = await import("../plugin-processes.js");
  const report = callReporter("timeout-probe");
  assert.throws(() => report({ kind: "timeout", plugin: "timeout-probe", command: "timeout-probe.run", timeout: 1000 }),
    { name: "TypeError", message: "unknown call report kind timeout" });
  report({ kind: "late-reply", plugin: "timeout-probe", command: "timeout-probe.run", delay: 3 });
  assert.deepEqual(losses().find((entry) => entry.plugin === "timeout-probe"),
    { plugin: "timeout-probe", abandoned: 0, lateReplies: 1, peerLost: 0 });
});

test("the event catalog has no call timeout or late reply event, and keeps the other call events of plugin processes", async () => {
  const { classOf } = await import("../event-classes.js");
  const catalog = JSON.parse(readFileSync(new URL("../../../docs/spec/events.json", import.meta.url), "utf8"));
  assert.equal(classOf("host.call.timeout"), undefined, "event-classes.js gives host.call.timeout a class");
  assert.equal(Object.hasOwn(catalog.events, "host.call.timeout"), false, "docs/spec/events.json declares host.call.timeout");
  assert.equal(classOf("host.call.peer-lost"), "call");
  assert.equal(classOf("host.trace.call.late-reply"), undefined, "event-classes.js gives host.trace.call.late-reply a class");
  assert.equal(Object.hasOwn(catalog.events, "host.trace.call.late-reply"), false, "docs/spec/events.json declares host.trace.call.late-reply");
});

// contract: view.responsiveness.relay
test("a view whose presentation wait ends without presentation counts losses.abandoned of its plugin", async () => {
  const { losses, presentationAbandoned } = await import("../plugin-processes.js");
  presentationAbandoned("abandon-probe");
  presentationAbandoned("abandon-probe");
  assert.deepEqual(losses().find((entry) => entry.plugin === "abandon-probe"), { plugin: "abandon-probe", abandoned: 2, lateReplies: 0, peerLost: 0 }, "each notice counts one abandoned presentation of the plugin");
});

test("a view responsiveness notice is the state of its surface until the surface is disposed", async () => {
  const { forgetView, views, viewResponsiveness } = await import("../plugin-processes.js");
  viewResponsiveness("probe", "responsive-probe-surface", false);
  assert.deepEqual(views(), [{ plugin: "probe", surface: "responsive-probe-surface", responsive: false }]);
  viewResponsiveness("probe", "responsive-probe-surface", true);
  assert.deepEqual(views(), [{ plugin: "probe", surface: "responsive-probe-surface", responsive: true }], "the state follows the last notice");
  forgetView("responsive-probe-surface");
  assert.deepEqual(views().filter((entry) => entry.surface === "responsive-probe-surface"), [], "a disposed surface keeps no state");
});

// contract: view.responsiveness.relay
test("a view responsiveness notice that is not a boolean is refused and changes no state", async () => {
  const { views, viewResponsiveness } = await import("../plugin-processes.js");
  assert.throws(() => viewResponsiveness("probe", "refused-probe-surface", "no"), /responsive is not a boolean/);
  assert.deepEqual(views().filter((entry) => entry.surface === "refused-probe-surface"), []);
});
