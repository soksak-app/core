import assert from "node:assert/strict";
import test from "node:test";
import { byteLength } from "@soksak/plugin-api/bounded-json.js";
import { surfaceSyncRequestWithDeclarationTable } from "../surface-sync-request.js";

test("surface sync declarations use a request-local table and preserve view start context", { timeout: 5000 }, () => {
  const startDeclarationA = { status: [{ name: "core.surface.document" }], commands: [], dom: [] };
  const startDeclarationB = { status: [{ name: "core.surface.input" }], commands: [], dom: [] };
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
  const normalized = surfaceSyncRequestWithDeclarationTable(wireInput);
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
  const nextNormalized = surfaceSyncRequestWithDeclarationTable(nextRequest);
  assert.equal(nextNormalized.request.declarations[0].status[0].name, "core.surface.document.changed",
    "a later request must recompute its table from current declaration values");
  assert.deepEqual(nextNormalized.request.surfaces.slice(0, 3).map(({ start }) => start.declarations), [0, 1, 2],
    "a later request must deduplicate only values present in that request");
  assert.throws(() => surfaceSyncRequestWithDeclarationTable({ surfaces: [
    { id: "non-finite", composition: { kind: "view" }, start: {
      params: null, origin: { directory: null }, project: null,
      declarations: { status: [{ value: Number.NaN }], commands: [], dom: [] },
    } },
  ] }), /finite/, "non-finite declaration values must not stringify as JSON null");
  assert.deepEqual(surfaceSyncRequestWithDeclarationTable({ surfaces: [] }).request.declarations, [],
    "a request without views still carries its required empty declaration table");
});
