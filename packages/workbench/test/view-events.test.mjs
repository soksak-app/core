// Checks the page side of the view event subscriptions (docs/spec/native-surfaces.md#view-surfaces). The surface runtime and
// the sidecar are fakes, so the test runs without a host.
import assert from "node:assert/strict";
import test from "node:test";
import { createViewSubscriptions } from "../view-events.js";

function fakes() {
  const listeners = new Map();
  const off = [];
  const pushed = [];
  const failures = [];
  const register = (kind) => (key, fn) => {
    listeners.set(`${kind}:${key}`, fn);
    return Promise.resolve(() => { off.push(`${kind}:${key}`); });
  };
  const native = register("native");
  const sidecar = {
    on: register("sidecar.on"),
    onFailure: register("sidecar.onFailure"),
  };
  const push = async (event, data) => {
    pushed.push({ event, data });
  };
  return { listeners, off, pushed, failures, native, sidecar, push };
}

test("a native subscription is registered once and pushes each event of its name with its data", async () => {
  const { listeners, native, pushed, push } = fakes();
  const subs = createViewSubscriptions({ native, sidecar: null, push, report: () => {} });
  const first = subs.native("probe.changed");
  await first;
  assert.equal(await subs.native("probe.changed"), null);
  listeners.get("native:probe.changed")({ surface: "probe-surface", count: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(pushed, [{ event: "probe.changed", data: { surface: "probe-surface", count: 1 } }]);
});

test("a sidecar subscription pushes its messages and failures with the session id", async () => {
  const { listeners, sidecar, pushed, push } = fakes();
  const subs = createViewSubscriptions({ native: null, sidecar, push, report: () => {} });
  await subs.sidecarMessage("probe-surface");
  await subs.sidecarFailure("probe-surface");
  listeners.get("sidecar.on:probe-surface")({ n: 1 });
  listeners.get("sidecar.onFailure:probe-surface")("exited");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(pushed, [
    { event: "sidecar.message", data: { id: "probe-surface", body: { n: 1 } } },
    { event: "sidecar.failure", data: { id: "probe-surface", reason: "exited" } },
  ]);
});

test("a push that the host refuses is reported with its text", async () => {
  const { listeners, native } = fakes();
  const reports = [];
  const subs = createViewSubscriptions({
    native, sidecar: null, push: async () => { throw new Error("probe-surface has no ready document"); }, report: (text) => reports.push(text),
  });
  await subs.native("probe.changed");
  listeners.get("native:probe.changed")({ surface: "probe-surface" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(reports, ["view event probe.changed: probe-surface has no ready document"]);
});

test("closing the surface ends every subscription, and an event after it is pushed to nothing", async () => {
  const { listeners, off, native, pushed, push } = fakes();
  const subs = createViewSubscriptions({ native, sidecar: null, push, report: () => {} });
  await subs.native("probe.changed");
  await subs.close();
  assert.deepEqual(off, ["native:probe.changed"]);
  listeners.get("native:probe.changed")({ surface: "probe-surface" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(pushed, []);
});
