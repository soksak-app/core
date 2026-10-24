import assert from "node:assert/strict";
import test from "node:test";

import { endSourceOrigin, onSourceOriginEnded, onSourceOriginRegistered, registerSourceOrigin, seedSourceOrigins, sourceOrigin } from "../source-origins.js";

test("a retired registration at the startup floor cannot create a ghost source", () => {
  seedSourceOrigins({ floor: 11, pluginHosts: {}, views: {} });
  assert.equal(registerSourceOrigin("probe", null, 11), false);
  assert.equal(sourceOrigin("probe", null), undefined);
  assert.equal(endSourceOrigin("probe", null, 11), false);
});

test("a source named by the startup snapshot accepts its matching registration and end only", () => {
  seedSourceOrigins({ floor: 11, pluginHosts: { probe: 11 }, views: {} });
  assert.equal(registerSourceOrigin("probe", null, 11), true);
  assert.equal(registerSourceOrigin("probe", null, 10), false);
  assert.equal(endSourceOrigin("probe", null, 10), false);
  assert.equal(sourceOrigin("probe", null), 11);
  assert.equal(endSourceOrigin("probe", null, 11), true);
  assert.equal(sourceOrigin("probe", null), undefined);
});

test("a newer source survives delayed registration and end events of its predecessor", () => {
  seedSourceOrigins({ floor: 0, pluginHosts: {}, views: {} });
  assert.equal(registerSourceOrigin("probe", null, 7), true);
  assert.equal(registerSourceOrigin("probe", null, 9), true);
  assert.equal(registerSourceOrigin("probe", null, 7), false);
  assert.equal(endSourceOrigin("probe", null, 7), false);
  assert.equal(sourceOrigin("probe", null), 9);
});

test("a source registration observer receives only the current and accepted generations", () => {
  seedSourceOrigins({ floor: 7, pluginHosts: {}, views: { "probe-view": 7 } });
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
  seedSourceOrigins({ floor: 7, pluginHosts: {}, views: { "probe-view": 7 } });
  const ended = [];
  const off = onSourceOriginEnded((event) => ended.push({ ...event, current: sourceOrigin(event.plugin, event.surface) }));
  assert.equal(endSourceOrigin("probe", "probe-view", 6), false);
  assert.deepEqual(ended, [], "a stale end notified observers");
  assert.equal(endSourceOrigin("probe", "probe-view", 7), true);
  assert.deepEqual(ended, [{ plugin: "probe", surface: "probe-view", generation: 7, current: undefined }],
    "the exact source end observer ran before the source was removed");
  off();
  assert.equal(registerSourceOrigin("probe", "probe-view", 8), true);
  assert.equal(endSourceOrigin("probe", "probe-view", 8), true);
  assert.equal(ended.length, 1, "a disposed source end observer received a later retirement");
});
