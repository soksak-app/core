import assert from "node:assert/strict";
import test from "node:test";

import { collectEditorProcessFootprint, editorFootprintEvidence, editorGeometryPalette, editorViewDescriptor }
  from "../benchmark/cases/editor.mjs";
import { editorSlotInsets } from "../benchmark/cases/editor.mjs";
import { measureViewFrameGeometry } from "../view-frame-geometry.mjs";

test("editor view descriptor calls the declared hyphenated content-trace command", async () => {
  const calls = [];
  const descriptor = editorViewDescriptor({ params: { path: "view-content/content.txt" } });
  assert.equal(descriptor.readinessStatus, "editor.document");
  const session = {
    async until(name, predicate) {
      assert.equal(name, "editor.document");
      assert.equal(predicate({ path: "view-content/content.txt", length: 22 }), true);
      return { path: "view-content/content.txt", length: 22 };
    },
    async rect(name) { assert.equal(name, "editor.content"); return { width: 100, height: 60 }; },
    async run(name, params, surface) {
      calls.push({ name, params, surface });
      return params.action === "read" ? { historyEntries: 1, regionHistoryEntries: 0 }
        : { enabled: params.action === "start" };
    },
  };
  await descriptor.readiness(session, "surface-a");
  await descriptor.readDocument(session, "surface-a");
  await descriptor.startContentTrace(session, "surface-a");
  await descriptor.stopContentTrace(session, "surface-a");
  assert.deepEqual(calls.map(({ name }) => name), Array(4).fill("editor.diagnostics.content-trace"));
});

test("editor footprint collector binds OS samples to the exact public view process PID", async () => {
  const sampled = [];
  const host = { documents: [
    { surface: "editor-a", document: "", process: 401 },
    { surface: "editor-a", document: "page", process: 999 },
  ] };
  const result = await collectEditorProcessFootprint({
    async get(name) {
      assert.equal(name, "host.window");
      return host;
    },
  }, ["editor-a"], async (pid) => {
    sampled.push(pid);
    return 5_000_000;
  });
  assert.deepEqual(sampled, [401, 999]);
  assert.deepEqual(result, { pids: [401, 999], processes: [
    { pid: 401, footprintBytes: 5_000_000 }, { pid: 999, footprintBytes: 5_000_000 },
  ] });
});

test("editor hidden fixture footprint uses the same live view PID and exact diagnostic document", () => {
  const before = [{ pid: 401, footprintBytes: 5_000_000 }];
  const after = [{ pid: 401, footprintBytes: 5_250_000 }];
  assert.deepEqual(editorFootprintEvidence(before, after,
    { mounted: true, documentLength: 22, historyEntries: 1, lines: 2, regionHistoryEntries: 0 },
    { documentLength: 22, lines: 2 }),
  { viewBytes: 5_000_000, hiddenDomBytes: 250_000 });
  assert.throws(() => editorFootprintEvidence(before, [{ pid: 402, footprintBytes: 5_250_000 }],
    { mounted: true, documentLength: 22, historyEntries: 1, lines: 2 }, { documentLength: 22, lines: 2 }), /same view process identities/);
  assert.throws(() => editorFootprintEvidence(before, after,
    { mounted: true, documentLength: 21, historyEntries: 1, lines: 2, regionHistoryEntries: 0 },
    { documentLength: 22, lines: 2 }), /unexpected document length/);
});


test("editor geometry palette samples a dominant opaque interior fill distinct from core geometry colors", () => {
  const width = 40, height = 30, stride = width * 4;
  const data = Buffer.alloc(stride * height);
  for (let index = 0; index < width * height; index++) {
    data[index * 4] = 255;
    data[index * 4 + 1] = 255;
    data[index * 4 + 2] = 255;
    data[index * 4 + 3] = 255;
  }
  const measured = editorGeometryPalette({ width, height, stride, data, scale: 1, contentScale: 1,
    content: { x: 0, y: 0 } }, { x: 2, y: 2, width: 36, height: 26 },
  { card: "#191b24", bg: "#101117", edge: "#2b2e3d", rule: "#22242f", focus: "#ffb36b" }, 0);
  assert.deepEqual(measured, { contentColor: [255, 255, 255], cardColor: [25, 27, 36], planeColor: [16, 17, 23],
    borderColors: [[43, 46, 61], [34, 36, 47], [255, 179, 107]], cornerRadiusPt: 0,
    sampleCount: 88, dominantCount: 88 });
  assert.throws(() => editorGeometryPalette({ width, height, stride, data, scale: 1, contentScale: 1,
    content: { x: 0, y: 0 } }, { x: 2, y: 2, width: 36, height: 26 },
  { card: "#ffffff", bg: "#101117", edge: "#2b2e3d" }, 0), /conflicts with core card geometry/);
});

test("editor geometry finds the card boundary beyond a plane-colored slot gutter", { timeout: 1000 }, () => {
  const width = 100, height = 80, stride = width * 4;
  const data = Buffer.alloc(stride * height);
  const paint = (x, y, color) => {
    const offset = y * stride + x * 4;
    data[offset] = color[2];
    data[offset + 1] = color[1];
    data[offset + 2] = color[0];
    data[offset + 3] = 255;
  };
  const theme = { card: "#191b24", bg: "#101117", edge: "#2b2e3d", rule: "#22242f", focus: "#ffb36b" };
  const color = (hex) => [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) paint(x, y, color(theme.bg));
  for (let y = 8; y < 72; y++) for (let x = 10; x < 90; x++) paint(x, y, color(theme.card));
  for (let y = 9; y < 71; y++) for (let x = 11; x < 89; x++) {
    if (x < 14 || x >= 86 || y < 22 || y >= 64) paint(x, y, color(theme.bg));
  }
  for (let y = 8; y < 72; y++) {
    paint(10, y, color(theme.rule));
    paint(89, y, color(theme.edge));
  }
  for (let x = 10; x < 90; x++) {
    paint(x, 8, color(theme.edge));
    paint(x, 71, color(theme.edge));
  }
  for (let y = 22; y < 64; y++) for (let x = 14; x < 86; x++) paint(x, y, [17, 193, 231]);

  const frame = { width, height, stride, data, scale: 1, contentScale: 1, content: { x: 0, y: 0 }, time: 12.5 };
  const palette = editorGeometryPalette(frame, { x: 14, y: 22, width: 72, height: 42 }, theme, 0);
  const measured = measureViewFrameGeometry(frame, { ...palette,
    targetRect: { x: 14, y: 22, width: 72, height: 42 } });
  assert.deepEqual(measured.cardRectPx, { left: 10, top: 8, right: 90, bottom: 72 });
  assert.deepEqual(measured.nativeRectPx, { left: 14, top: 22, right: 86, bottom: 64 });
});

test("editor slot insets come from declared composition and card geometry", () => {
  assert.deepEqual(editorSlotInsets({
    plane: { x: 10, y: 20 },
    cards: [{ id: "card-1", x: 5, y: 7, w: 200, h: 100 }],
  }, [{ surface: "editor-1", declared: { x: 20, y: 36, w: 184, h: 72 } }], "card-1", "editor-1"),
  { left: 5, top: 9, right: 11, bottom: 19 });
  assert.throws(() => editorSlotInsets({ plane: { x: 10, y: 20 }, cards: [] }, [], "card-1", "editor-1"),
    /missing declared composition geometry/);
});
