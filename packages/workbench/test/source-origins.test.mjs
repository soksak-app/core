import assert from "node:assert/strict";
import test from "node:test";

import { endSourceOrigin, registerSourceOrigin, seedSourceOrigins, sourceOrigin } from "../source-origins.js";

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
