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
  const listen = (kind) => (fn) => {
    listeners.set(`${kind}:change`, fn);
    return Promise.resolve(() => { off.push(`${kind}:change`); });
  };
  const textSize = listen("textSize");
  const settings = listen("settings");
  const push = async (event, data) => {
    pushed.push({ event, data });
  };
  return { listeners, off, pushed, failures, native, sidecar, textSize, settings, push };
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

test("a log levels subscription pushes each change of the stored levels once and nothing while they stay", async () => {
  const { pushed, push } = fakes();
  let stored = ["error"];
  let changed = null;
  const logLevels = { read: () => stored, on: (fn) => { changed = fn; return Promise.resolve(() => { changed = null; }); } };
  const subs = createViewSubscriptions({ native: null, sidecar: null, logLevels, push, report: () => {} });
  assert.equal(typeof subs.logLevels, "function", "the subscriptions have no logLevels");
  assert.equal(await subs.logLevels(), null);
  assert.equal(await subs.logLevels(), null);
  changed();
  stored = ["error", "warn", "info"];
  changed();
  changed();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(pushed, [{ event: "log.levels", data: ["error", "warn", "info"] }]);
  await subs.close();
  assert.equal(changed, null, "the close ends the subscription");
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

test("a text size subscription is registered once and pushes each change of the scale", async () => {
  const { listeners, textSize, pushed } = fakes();
  const subs = createViewSubscriptions({ native: null, sidecar: null, textSize, settings: null, push: async (event, data) => { pushed.push({ event, data }); }, report: () => {} });
  const first = subs.textSize();
  const second = subs.textSize();
  assert.equal(await first, null);
  assert.equal(await second, null);
  const deliver = listeners.get("textSize:change");
  assert.equal(typeof deliver, "function");
  deliver(1.5);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(pushed, [{ event: "textSize", data: 1.5 }]);
  await subs.close();
});

test("a settings subscription is registered once and pushes each change of the settings", async () => {
  const { listeners, settings, pushed } = fakes();
  const subs = createViewSubscriptions({ native: null, sidecar: null, textSize: null, settings, push: async (event, data) => { pushed.push({ event, data }); }, report: () => {} });
  assert.equal(await subs.settings(), null);
  listeners.get("settings:change")({ home: "" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(pushed, [{ event: "settings", data: { home: "" } }]);
  await subs.close();
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
