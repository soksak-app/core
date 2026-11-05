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
  const routes = [];
  const sidecar = {
    route: (id, name) => {
      routes.push(`on ${name} ${id}`);
      return Promise.resolve(() => { routes.push(`off ${name} ${id}`); });
    },
    onFailure: register("sidecar.onFailure"),
  };
  const listen = (kind) => (fn) => {
    listeners.set(`${kind}:change`, fn);
    return Promise.resolve(() => { off.push(`${kind}:change`); });
  };
  const textSize = listen("textSize");
  const settings = listen("settings");
  const data = listen("data");
  const push = async (event, data) => {
    pushed.push({ event, data });
  };
  return { listeners, off, pushed, failures, native, sidecar, routes, textSize, settings, data, push };
}

test("a later view event waits for the earlier event delivery", async () => {
  const listeners = new Map();
  const started = [];
  const delivered = [];
  let releaseFirst;
  const firstDelivery = new Promise((resolve) => { releaseFirst = resolve; });
  const native = (name, listener) => {
    listeners.set(name, listener);
    return Promise.resolve(() => {});
  };
  const subs = createViewSubscriptions({
    native,
    sidecar: null,
    push: async (event, data) => {
      started.push(data.id);
      if (data.id === 1) await firstDelivery;
      delivered.push(data.id);
    },
    report: () => {},
  });
  await subs.native("input");
  listeners.get("input")({ id: 1 });
  listeners.get("input")({ id: 2 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [1], "the second delivery must remain queued while the first is pending");
  releaseFirst();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [1, 2]);
  assert.deepEqual(delivered, [1, 2]);
  await subs.close();
});

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
  let stored = { lifecycle: "error", input: "error", call: "error", io: "error", frame: "error" };
  let changed = null;
  const logLevels = { read: () => stored, on: (fn) => { changed = fn; return Promise.resolve(() => { changed = null; }); } };
  const subs = createViewSubscriptions({ native: null, sidecar: null, logLevels, push, report: () => {} });
  assert.equal(typeof subs.logLevels, "function", "the subscriptions have no logLevels");
  assert.equal(await subs.logLevels(), null);
  assert.equal(await subs.logLevels(), null);
  changed();
  stored = { ...stored, frame: "debug" };
  changed();
  changed();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(pushed, [{ event: "log.levels", data: { lifecycle: "error", input: "error", call: "error", io: "error", frame: "debug" } }]);
  await subs.close();
  assert.equal(changed, null, "the close ends the subscription");
});

test("a sidecar message subscription adds the host route of the view once, a restart removes it, and a failure is pushed", async () => {
  const { listeners, sidecar, routes, pushed, push } = fakes();
  const subs = createViewSubscriptions({ native: null, sidecar, push, report: () => {} });
  await subs.sidecarMessage("probe-surface", "fixture-sidecar");
  assert.equal(await subs.sidecarMessage("probe-surface", "fixture-sidecar"), null);
  await subs.sidecarFailure("probe-surface");
  assert.deepEqual(routes, ["on fixture-sidecar probe-surface"], "the host posts the messages, so the page adds one route and pushes none");
  listeners.get("sidecar.onFailure:probe-surface")("exited");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(pushed, [{ event: "sidecar.failure", data: { id: "probe-surface", reason: "exited" } }]);
  await subs.restart();
  assert.deepEqual(routes, ["on fixture-sidecar probe-surface", "off fixture-sidecar probe-surface"], "a restart removes the route");
});

test("an event for a view whose surface is left out is canceled without a push, and pushes resume when it is drawn again", async () => {
  // A section surface whose section left the drawing exists until the commit releases it (docs/spec/plugins.md#sections).
  const f = fakes();
  let left = true;
  const canceled = [];
  const subs = createViewSubscriptions({ ...f, report: (text) => f.failures.push(text), leftOut: () => left,
    cancel: (event) => canceled.push(event) });
  await subs.native("probe.event");
  f.listeners.get("native:probe.event")({ n: 1 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(f.pushed, [], "a left-out view received an event");
  assert.deepEqual(canceled, ["probe.event"]);
  left = false;
  f.listeners.get("native:probe.event")({ n: 2 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(f.pushed, [{ event: "probe.event", data: { n: 2 } }]);
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

test("a data subscription is registered once and pushes the key of each change of the project data", async () => {
  const { listeners, off, data, pushed } = fakes();
  const subs = createViewSubscriptions({ native: null, sidecar: null, textSize: null, settings: null, data,
    push: async (event, value) => { pushed.push({ event, data: value }); }, report: () => {} });
  assert.equal(await subs.data(), null);
  assert.equal(await subs.data(), null);
  listeners.get("data:change")("marks");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(pushed, [{ event: "data", data: { key: "marks" } }]);
  await subs.close();
  assert.deepEqual(off, ["data:change"]);
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

test("a status watch pushes each value of its name as the status event and ends at unwatch", async () => {
  const pushed = [];
  const observed = new Map();
  const off = [];
  const observe = (name, surface, fn) => {
    assert.equal(surface, undefined, "a watch without a surface observes the status without one");
    observed.set(name, fn);
    return () => { off.push(name); observed.delete(name); };
  };
  const subs = createViewSubscriptions({ native: null, sidecar: null, status: observe, push: async (event, data) => { pushed.push({ event, data }); }, report: () => {} });
  assert.equal(await subs.statusWatch("core.grid"), null);
  assert.equal(await subs.statusWatch("core.grid"), null, "a second watch of the same name registers nothing");
  observed.get("core.grid")({ tabs: 2 }, "core");
  observed.get("core.grid")({ tabs: 3 }, "core");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(pushed, [
    { event: "status", data: { name: "core.grid", value: { tabs: 2 } } },
    { event: "status", data: { name: "core.grid", value: { tabs: 3 } } },
  ]);
  assert.equal(await subs.statusUnwatch("core.grid"), null);
  assert.deepEqual(off, ["core.grid"]);
  assert.equal(await subs.statusUnwatch("core.grid"), null, "an unwatch of a name that is not watched ends nothing");
  assert.deepEqual(off, ["core.grid"]);
  await subs.statusWatch("probe.count");
  await subs.close();
  assert.deepEqual(off, ["core.grid", "probe.count"], "the close ends the status watches that remain");
});

test("a status watch with a surface follows the status on that surface, keyed by name and surface", async () => {
  const pushed = [];
  const observed = new Map();
  const observations = [];
  const off = [];
  const observe = (name, surface, fn) => {
    const key = `${name} ${surface ?? "none"}`;
    observations.push(key);
    observed.set(key, fn);
    return () => { off.push(key); observed.delete(key); };
  };
  const subs = createViewSubscriptions({ native: null, sidecar: null, status: observe, push: async (event, data) => { pushed.push({ event, data }); }, report: () => {} });
  assert.equal(await subs.statusWatch("probe.lines", "spc-aaaaaa/left/files.tree"), null);
  assert.equal(await subs.statusWatch("probe.lines", "tab-a"), null);
  assert.equal(await subs.statusWatch("probe.lines", "tab-a"), null, "a second watch of the same name and surface registers nothing");
  assert.deepEqual(observations, ["probe.lines spc-aaaaaa/left/files.tree", "probe.lines tab-a"]);
  observed.get("probe.lines spc-aaaaaa/left/files.tree")(["section"], "spc-aaaaaa/left/files.tree");
  observed.get("probe.lines tab-a")(["tab"], "tab-a");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(pushed, [
    { event: "status", data: { name: "probe.lines", surface: "spc-aaaaaa/left/files.tree", value: ["section"] } },
    { event: "status", data: { name: "probe.lines", surface: "tab-a", value: ["tab"] } },
  ]);
  assert.equal(await subs.statusUnwatch("probe.lines", "spc-aaaaaa/left/files.tree"), null);
  assert.deepEqual(off, ["probe.lines spc-aaaaaa/left/files.tree"], "an unwatch ends only the watch of its surface");
  assert.equal(observed.has("probe.lines tab-a"), true);
  await subs.close();
  assert.deepEqual(off, ["probe.lines spc-aaaaaa/left/files.tree", "probe.lines tab-a"]);
});

test("a status watch that the page refuses registers nothing and rejects with the refusal", async () => {
  const subs = createViewSubscriptions({
    native: null,
    sidecar: null,
    status: () => { throw new Error("status probe.count is not declared"); },
    push: async () => {},
    report: () => {},
  });
  await assert.rejects(subs.statusWatch("probe.count"), /status probe\.count is not declared/);
});

test("a subscription whose registrar returns the off function itself is refused and registers nothing", async () => {
  const listeners = new Map();
  const off = [];
  // A registrar returns a promise of its off function, the one form that the view subscriptions accept (docs/spec/native-surfaces.md).
  const textSize = (fn) => {
    listeners.set("textSize", fn);
    return () => { off.push("textSize"); };
  };
  const subs = createViewSubscriptions({
    native: null,
    sidecar: null,
    textSize,
    push: async () => {},
    report: () => {},
  });
  await assert.rejects(subs.textSize(), /view subscription textSize: the registrar returned function, want a promise of the off function/);
  assert.equal(listeners.has("textSize"), true, "the registrar was called once");
  assert.deepEqual(off, []);
  await subs.close();
});

test("a subscription whose registrar throws is refused with its error and registers nothing", async () => {
  const subs = createViewSubscriptions({
    native: null,
    sidecar: null,
    textSize: () => { throw new Error("no surface"); },
    push: async () => {},
    report: () => {},
  });
  await assert.rejects(subs.textSize(), /no surface/);
  await subs.close();
});

test("a status watch holds the values of a run and delivers the newest at its end", async () => {
  const f = fakes();
  let active = false;
  let ended = null;
  let observer = null;
  const canceled = [];
  const subs = createViewSubscriptions({
    ...f, report: (text) => f.failures.push(text), cancel: (event) => canceled.push(event),
    status: (name, surface, listener) => { observer = listener; return () => {}; },
    run: { active: () => active, onEnd: (fn) => { ended = fn; return () => {}; } },
  });
  await subs.statusWatch("core.grid");
  active = true;
  observer({ w: 1 });
  await new Promise(setImmediate);
  assert.deepEqual(f.pushed.map(({ data }) => data.value), [{ w: 1 }], "the first value of a watch waited for the end of a run");
  observer({ w: 2 });
  observer({ w: 3 });
  await new Promise(setImmediate);
  assert.equal(f.pushed.length, 1, "a value of a run was delivered during the run");
  assert.deepEqual(canceled, ["status"], "a value that a newer value replaced has no record");
  active = false;
  ended();
  await new Promise(setImmediate);
  assert.deepEqual(f.pushed.map(({ data }) => data.value), [{ w: 1 }, { w: 3 }], "the newest value was not delivered at the end of the run");
  observer({ w: 4 });
  await new Promise(setImmediate);
  assert.deepEqual(f.pushed.at(-1).data.value, { w: 4 }, "a value after the run was not delivered at once");

  active = true;
  observer({ w: 5 });
  await subs.statusUnwatch("core.grid");
  active = false;
  ended();
  await new Promise(setImmediate);
  assert.deepEqual(f.pushed.at(-1).data.value, { w: 4 }, "a held value was delivered after its unwatch");
  assert.deepEqual(f.failures, []);
});

test("each start of a run is pushed to the view as the event run-start, and a closed view receives no more", async () => {
  const f = fakes();
  let started = null;
  const subs = createViewSubscriptions({
    ...f, report: (text) => f.failures.push(text), cancel: () => {},
    status: () => () => {},
    run: {
      active: () => false,
      onStart: (fn) => { started = fn; return () => { started = null; }; },
      onEnd: () => () => {},
    },
  });
  started();
  await new Promise(setImmediate);
  assert.deepEqual(f.pushed.map(({ event, data }) => [event, data]), [["run-start", null]]);
  await subs.close();
  assert.equal(started, null, "the listener of the start of a run ends with the subscriptions");
});
