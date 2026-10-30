import assert from "node:assert/strict";
import test from "node:test";
import { retainedSurfaceEntries } from "../surface-listing.js";

test("a mounted view outside the seated record is listed with its exposes and no placement", () => {
  const mounts = [
    { surface: "tab-a", plugin: "probeview", exposes: ["status core.surface.document", "status probeview.location"], composition: "view",
      status: { phase: "ready", error: null }, state: "loaded" },
    { surface: "tab-b", plugin: "probeview", exposes: ["status probeview.location"], composition: "view",
      status: { phase: "ready", error: null }, state: "loaded" },
  ];
  assert.deepEqual(retainedSurfaceEntries(mounts, new Set(["tab-b"])), [{
    surface: "tab-a", plugin: "probeview", visible: false, dim: null, declared: null, applied: null,
    exposes: ["status core.surface.document", "status probeview.location"], status: { phase: "ready", error: null },
    placeholder: null, composition: "view", state: "loaded",
  }]);
});

test("a mount of another composition outside the seated record is not listed", () => {
  const mounts = [
    { surface: "tab-dom", plugin: "notes", exposes: ["status notes.text"], composition: "dom",
      status: { phase: "ready", error: null }, state: "loaded" },
    { surface: "tab-none", plugin: "notes", exposes: [], composition: null,
      status: { phase: "ready", error: null }, state: "loaded" },
  ];
  assert.deepEqual(retainedSurfaceEntries(mounts, new Set()), []);
});

test("the retained entries reject a mount list or a seated set of another type", () => {
  assert.throws(() => retainedSurfaceEntries(null, new Set()), TypeError);
  assert.throws(() => retainedSurfaceEntries([], ["tab-a"]), TypeError);
});
