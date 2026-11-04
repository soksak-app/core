import assert from "node:assert/strict";
import test from "node:test";
import { byteLength } from "@soksak/plugin-api/bounded-json.js";
import { surfaceSyncRequestDifference, surfaceSyncRequestWithDeclarationTable } from "../surface-sync-request.js";

test("surface sync declarations use a request-local table and preserve view start context", { timeout: 5000 }, () => {
  const startDeclarationA = { status: [{ name: "core.surface.document" }], commands: [], element: [] };
  const startDeclarationB = { status: [{ name: "core.surface.input" }], commands: [], element: [] };
  const wireInput = {
    settled: false, overlays: [], titlebar: 40,
    surfaces: [
      { id: "wire-one", composition: { kind: "view" }, start: {
        params: { path: "one.md" }, origin: { directory: "/one" }, project: { id: "p1", root: "/one" },
        declarations: startDeclarationA,
      } },
      { id: "wire-two", composition: { kind: "view" }, start: {
        params: { path: "two.md" }, origin: { directory: "/two" }, project: { id: "p2", root: "/two" },
        declarations: structuredClone(startDeclarationA),
      } },
      { id: "wire-three", composition: { kind: "view" }, start: {
        params: null, origin: { directory: null }, project: null, declarations: startDeclarationB,
      } },
      { id: "wire-image", composition: { kind: "image" } },
    ],
  };
  const normalized = surfaceSyncRequestWithDeclarationTable(wireInput, new Map());
  assert.deepEqual(normalized.request.declarations, [startDeclarationA, startDeclarationB],
    "the request table must deduplicate identical serialized declarations and retain distinct values");
  assert.deepEqual(normalized.request.surfaces.map(({ id, start }) => [id, start?.declarations]), [
    ["wire-one", 0], ["wire-two", 0], ["wire-three", 1], ["wire-image", undefined],
  ], "view starts must reference only their request-local table entries");
  assert.deepEqual(normalized.request.surfaces.map(({ start }) => start && ({
    params: start.params, origin: start.origin, project: start.project,
  })), [
    { params: { path: "one.md" }, origin: { directory: "/one" }, project: { id: "p1", root: "/one" } },
    { params: { path: "two.md" }, origin: { directory: "/two" }, project: { id: "p2", root: "/two" } },
    { params: null, origin: { directory: null }, project: null },
    undefined,
  ], "normalization must preserve each surface's full non-declaration context");
  const normalizedBytes = normalized.declarationBytes();
  assert.ok(normalizedBytes.declarationInlineBytes > normalizedBytes.declarationTableBytes,
    "the measured declaration component must show the exact bytes removed from repeated inline values");
  const declarationAJson = JSON.stringify(startDeclarationA);
  const declarationBJson = JSON.stringify(startDeclarationB);
  assert.equal(normalizedBytes.declarationInlineBytes,
    2 * byteLength(declarationAJson) + byteLength(declarationBJson),
    "inline bytes must count each full per-view declaration value");
  assert.equal(normalizedBytes.declarationTableBytes,
    byteLength(JSON.stringify([startDeclarationA, startDeclarationB])),
    "table bytes must count the exact array JSON component sent to the host");
  assert.deepEqual(wireInput.surfaces[0].start.declarations, startDeclarationA,
    "normalization must not mutate the complete internal start values");
  const nextRequest = structuredClone(wireInput);
  nextRequest.surfaces[0].start.declarations.status[0].name = "core.surface.document.changed";
  const nextNormalized = surfaceSyncRequestWithDeclarationTable(nextRequest, new Map());
  assert.equal(nextNormalized.request.declarations[0].status[0].name, "core.surface.document.changed",
    "a later request must recompute its table from current declaration values");
  assert.deepEqual(nextNormalized.request.surfaces.slice(0, 3).map(({ start }) => start.declarations), [0, 1, 2],
    "a later request must deduplicate only values present in that request");
  assert.throws(() => surfaceSyncRequestWithDeclarationTable({ surfaces: [
    { id: "non-finite", composition: { kind: "view" }, start: {
      params: null, origin: { directory: null }, project: null,
      declarations: { status: [{ value: Number.NaN }], commands: [], element: [] },
    } },
  ] }, new Map()), /finite/, "non-finite declaration values must not stringify as JSON null");
  assert.deepEqual(surfaceSyncRequestWithDeclarationTable({ surfaces: [] }, new Map()).request.declarations, [],
    "a request without views still carries its required empty declaration table");
});

test("the difference of two surface sync requests names each changed value up to its limit", { timeout: 5000 }, () => {
  const before = { settled: false, titlebar: 40, surfaces: [{ id: "a", x: 1, y: 348.4 }, { id: "b", x: 2, y: 3 }] };
  const after = { settled: false, titlebar: 40, surfaces: [{ id: "a", x: 1, y: 348.40625 }, { id: "b", x: 2, y: 3, z: 1 }] };
  assert.deepEqual(surfaceSyncRequestDifference(before, before), []);
  assert.deepEqual(surfaceSyncRequestDifference(before, after), ["surfaces.0.y: 348.4 -> 348.40625", "surfaces.1.z: undefined -> 1"]);
  assert.deepEqual(surfaceSyncRequestDifference(before, after, 1), ["surfaces.0.y: 348.4 -> 348.40625"]);
  assert.deepEqual(surfaceSyncRequestDifference({ a: [] }, { a: {} }), ["a: [] -> {}"]);
});

test("a sync request carries the start values of a view only while the host does not hold them", { timeout: 5000 }, () => {
  const request = (params, surfaces = true) => ({
    settled: false, overlays: [], titlebar: 40,
    surfaces: surfaces ? [{ id: "held-view", composition: { kind: "view" }, start: {
      params, origin: { directory: null }, project: null, declarations: { status: [], commands: [], dom: [] },
    } }] : [],
  });
  const first = surfaceSyncRequestWithDeclarationTable(request(null), new Map());
  assert.equal(first.request.surfaces[0].start?.declarations, 0, "the first request did not carry the start values");
  const second = surfaceSyncRequestWithDeclarationTable(request(null), first.starts);
  assert.equal(second.request.surfaces[0].start, undefined, "a request carried start values that the host holds");
  assert.deepEqual(second.request.declarations, [], "a request without start values carried a declaration table");
  assert.equal(second.request.surfaces[0].id, "held-view");
  assert.deepEqual(second.layout, first.layout, "the layout of two requests with the same placement differs");
  const changed = surfaceSyncRequestWithDeclarationTable(request({ path: "a.md" }), second.starts);
  assert.deepEqual(changed.request.surfaces[0].start?.params, { path: "a.md" }, "changed start values were not carried");
  assert.deepEqual(changed.layout, first.layout, "the layout contains start values");
  const absent = surfaceSyncRequestWithDeclarationTable(request(null, false), changed.starts);
  assert.equal(absent.starts.size, 0, "a surface absent from the request stayed held");
  const again = surfaceSyncRequestWithDeclarationTable(request({ path: "a.md" }), absent.starts);
  assert.equal(again.request.surfaces[0].start?.declarations, 0, "a surface named again did not carry its start values");
});
