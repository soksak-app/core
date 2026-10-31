import assert from "node:assert/strict";
import test, { mock } from "node:test";

import { endSourceOrigin, onSourceOriginEnded, onSourceOriginRegistered, registerSourceOrigin, seedSourceOrigins, sourceOrigin } from "../source-origins.js";

test("a retired registration at the startup floor cannot create a ghost source", () => {
  seedSourceOrigins({ floor: 11, views: {} });
  assert.equal(registerSourceOrigin("probe", "probe-view", 11), false);
  assert.equal(sourceOrigin("probe", "probe-view"), undefined);
  assert.equal(endSourceOrigin("probe", "probe-view", 11), false);
});

test("a source named by the startup snapshot accepts its matching registration and end only", () => {
  seedSourceOrigins({ floor: 11, views: { "probe-view": 11 } });
  assert.equal(registerSourceOrigin("probe", "probe-view", 11), true);
  assert.equal(registerSourceOrigin("probe", "probe-view", 10), false);
  assert.equal(endSourceOrigin("probe", "probe-view", 10), false);
  assert.equal(sourceOrigin("probe", "probe-view"), 11);
  assert.equal(endSourceOrigin("probe", "probe-view", 11), true);
  assert.equal(sourceOrigin("probe", "probe-view"), undefined);
});

test("a newer source survives delayed registration and end events of its predecessor", () => {
  seedSourceOrigins({ floor: 0, views: {} });
  assert.equal(registerSourceOrigin("probe", "probe-view", 7), true);
  assert.equal(registerSourceOrigin("probe", "probe-view", 9), true);
  assert.equal(registerSourceOrigin("probe", "probe-view", 7), false);
  assert.equal(endSourceOrigin("probe", "probe-view", 7), false);
  assert.equal(sourceOrigin("probe", "probe-view"), 9);
});

test("a source registration observer receives only the current and accepted generations", () => {
  seedSourceOrigins({ floor: 7, views: { "probe-view": 7 } });
  const generations = [];
  const off = onSourceOriginRegistered("probe", "probe-view", (generation) => generations.push(generation));
  assert.deepEqual(generations, [7]);
  assert.equal(registerSourceOrigin("probe", "probe-view", 6), false);
  assert.equal(registerSourceOrigin("probe", "probe-view", 8), true);
  assert.deepEqual(generations, [7, 8]);
  off();
  assert.equal(registerSourceOrigin("probe", "probe-view", 9), true);
  assert.deepEqual(generations, [7, 8], "a disposed observer received a later registration");
});

test("a source end observer receives only an exact current retirement after the source is absent", () => {
  seedSourceOrigins({ floor: 7, views: { "probe-view": 7 } });
  const ended = [];
  const off = onSourceOriginEnded((event) => ended.push({ ...event, current: sourceOrigin(event.plugin, event.surface) }));
  assert.equal(endSourceOrigin("probe", "probe-view", 6), false);
  assert.deepEqual(ended, [], "a stale end notified observers");
  assert.equal(endSourceOrigin("probe", "probe-view", 7), true);
  assert.deepEqual(ended, [{ plugin: "probe", surface: "probe-view", generation: 7, current: undefined }],
    "the exact source end observer did not run after the source was removed");
  off();
  assert.equal(registerSourceOrigin("probe", "probe-view", 8), true);
  assert.equal(endSourceOrigin("probe", "probe-view", 8), true);
  assert.equal(ended.length, 1, "a disposed source end observer received a later retirement");
});

test("a seed with a generation above its floor or a non-view entry is refused", () => {
  assert.throws(() => seedSourceOrigins({ floor: 3, views: { "probe-view": 4 } }), /invalid generation/);
  assert.throws(() => seedSourceOrigins({ floor: 3 }), /snapshot is invalid/);
  assert.throws(() => registerSourceOrigin("probe", null, 4), /requires a plugin, surface and positive generation/);
});

test("the ingress applies the lifecycle events that arrive before the host seed, and then the later ones", async (t) => {
  const listeners = new Map();
  let answer = null;
  const dispatched = [];
  globalThis.dispatchEvent = (event) => { dispatched.push(event.message); return true; };
  globalThis.ErrorEvent = class { constructor(type, init) { this.message = init.message; } };
  mock.module("@soksak/runtime", { namedExports: { host: {
    call: (name) => {
      assert.equal(name, "viewSourceOrigins");
      return answer;
    },
    on: (name, listener) => {
      listeners.set(name, listener);
      return Promise.resolve(() => listeners.delete(name));
    },
  } } });
  const origins = await import("../source-origins.js?ingress");
  t.after(() => { delete globalThis.dispatchEvent; delete globalThis.ErrorEvent; });
  const started = origins.startSourceOriginIngress();
  listeners.get("view-source-registered")({ plugin: "probe", surface: "probe-view", generation: 5 });
  answer = Promise.resolve({ floor: 4, views: {} });
  await started;
  assert.equal(origins.sourceOrigin("probe", "probe-view"), 5, "the event received before the seed was not applied");
  listeners.get("view-source-ended")({ plugin: "probe", surface: "probe-view", generation: 5 });
  assert.equal(origins.sourceOrigin("probe", "probe-view"), undefined, "a later end event was not applied");
  listeners.get("view-source-registered")({ plugin: "probe", generation: 6 });
  assert.deepEqual(dispatched, ["source origin ingress: view source lifecycle event of probe requires a surface"]);
});
