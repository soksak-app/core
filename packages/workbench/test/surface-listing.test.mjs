import assert from "node:assert/strict";
import test from "node:test";
import { retainedSurfaceEntries, surfaceKindOf } from "../surface-listing.js";

test("a mounted view outside the seated record is listed with its exposes and no placement", () => {
  const mounts = [
    { surface: "tab-a", plugin: "probeview", exposes: ["status core.surface.document", "status probeview.location"], composition: "view",
      status: { phase: "ready", error: null }, state: "loaded", kind: "tab", sidebar: null },
    { surface: "tab-b", plugin: "probeview", exposes: ["status probeview.location"], composition: "view",
      status: { phase: "ready", error: null }, state: "loaded", kind: "tab", sidebar: null },
  ];
  assert.deepEqual(retainedSurfaceEntries(mounts, new Set(["tab-b"])), [{
    surface: "tab-a", plugin: "probeview", visible: false, dim: null, declared: null, applied: null,
    exposes: ["status core.surface.document", "status probeview.location"], status: { phase: "ready", error: null },
    placeholder: null, composition: "view", state: "loaded", kind: "tab", sidebar: null,
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

test("a section surface is listed with kind section and its sidebar, and a tab surface with kind tab", () => {
  assert.deepEqual(surfaceKindOf({ surfaceId: "spc-aaaaaa/c3:right/probe.dom", section: { id: "probe.dom", sidebar: "c3:right", card: "c3" } }),
    { kind: "section", sidebar: "c3:right" });
  assert.deepEqual(surfaceKindOf({ surfaceId: "tab-a", section: null }), { kind: "tab", sidebar: null });
  assert.deepEqual(surfaceKindOf({ surfaceId: "tab-b" }), { kind: "tab", sidebar: null });
});

test("a retained section view keeps its kind and sidebar", () => {
  const mounts = [{ surface: "spc-aaaaaa/left/probe.tree", plugin: "probe", exposes: [], composition: "view",
    status: { phase: "ready", error: null }, state: "loaded", kind: "section", sidebar: "left" }];
  const [entry] = retainedSurfaceEntries(mounts, new Set());
  assert.equal(entry.kind, "section");
  assert.equal(entry.sidebar, "left");
});
