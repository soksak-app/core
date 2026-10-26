import assert from "node:assert/strict";
import test from "node:test";

import { collectEditorProcessFootprint, collectHiddenEditorFootprint, editorFootprintEvidence, editorGeometryPalette,
  editorSourceContentFrame, editorViewDescriptor }
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
  assert.deepEqual(result, { pids: [401, 999], surfaces: ["editor-a"], processes: [
    { pid: 401, footprintBytes: 5_000_000 }, { pid: 999, footprintBytes: 5_000_000 },
  ] });
});

test("editor footprint uses independent normal-view and hidden-only process-group totals", () => {
  const viewProcesses = [{ pid: 401, footprintBytes: 5_000_000 }];
  const hiddenProcesses = [{ pid: 402, footprintBytes: 4_800_000 }];
  assert.deepEqual(editorFootprintEvidence(viewProcesses, hiddenProcesses,
    { mounted: true, documentLength: 22, historyEntries: 1, lines: 2, regionHistoryEntries: 0 },
    { documentLength: 22, lines: 2 }),
  { viewBytes: 5_000_000, hiddenDomBytes: 4_800_000 });
  assert.deepEqual(editorFootprintEvidence(viewProcesses, [{ pid: 401, footprintBytes: 4_800_000 }],
    { mounted: true, documentLength: 22, historyEntries: 1, lines: 2, regionHistoryEntries: 0 },
    { documentLength: 22, lines: 2 }),
  { viewBytes: 5_000_000, hiddenDomBytes: 4_800_000 }, "the hidden-only sample is an absolute snapshot even when the PID is reused");
  assert.throws(() => editorFootprintEvidence(viewProcesses, hiddenProcesses,
    { mounted: true, documentLength: 21, historyEntries: 1, lines: 2, regionHistoryEntries: 0 },
    { documentLength: 22, lines: 2 }), /unexpected document length/);
});

test("hidden-only editor measurement starts, reads and removes one isolated Editor process group", async () => {
  const events = [];
  let surfaces = [];
  const fixture = { mounted: true, documentLength: 22, historyEntries: 1, lines: 2, regionHistoryEntries: 0 };
  const session = {
    async get(name) {
      events.push(`get:${name}`);
      if (name === "core.surfaces") return surfaces;
      if (name === "core.grid") return { cards: [{ id: "card-a", active: "browser-a",
        tabs: [{ id: "browser-a", plugin: "browser" }] }] };
      if (name === "host.window") return { documents: [{ surface: "hidden-a", document: "", process: 402 }] };
      throw new Error(`unexpected status ${name}`);
    },
    async until(name, predicate) {
      events.push(`until:${name}`);
      assert.equal(name, "core.surfaces");
      assert.equal(predicate(surfaces), true);
      return surfaces;
    },
    async run(name, params) {
      events.push(`run:${name}:${params.action ?? ""}`);
      if (name === "core.card.add-tab") {
        assert.deepEqual(params, { card: "card-a", plugin: "editor",
          params: { diagnosticMode: "hidden-memory", document: "SOKSAK EDITOR CONTENT\n" } });
        surfaces = [{ surface: "hidden-a", plugin: "editor", exposes: ["command editor.memory.hidden"],
          status: { phase: "ready", error: null } }];
        return { tab: "hidden-a" };
      }
      if (name === "editor.memory.hidden" && params.action === "read") return fixture;
      if (name === "editor.memory.hidden" && params.action === "remove") return { mounted: false };
      if (name === "core.tab.close") {
        assert.equal(params.tab, "hidden-a");
        surfaces = [];
        return { closed: true };
      }
      throw new Error(`unexpected command ${name}`);
    },
  };
  const viewProcesses = [{ pid: 401, footprintBytes: 5_000_000 }];
  const measuredPids = [];
  const result = await collectHiddenEditorFootprint(session, viewProcesses, async (pid) => {
    measuredPids.push(pid);
    return 4_800_000;
  });
  assert.deepEqual(result.editorFootprint, { viewBytes: 5_000_000, hiddenDomBytes: 4_800_000 });
  assert.deepEqual(result.evidence, { surface: "hidden-a", processGroupPids: [402], processGroupSurfaces: ["hidden-a"],
    viewProcesses, hiddenProcesses: [{ pid: 402, footprintBytes: 4_800_000 }], fixture });
  assert.deepEqual(measuredPids, [402]);
  assert.ok(events.indexOf("run:editor.memory.hidden:read") < events.indexOf("get:host.window"),
    "the hidden-only process was sampled before the fixture read");
  assert.ok(events.includes("run:editor.memory.hidden:remove"), "the hidden EditorView was not removed");
  assert.ok(events.includes("run:core.tab.close:"), "the hidden-only Editor surface was not closed");
  assert.deepEqual(surfaces, []);
});

test("hidden-only editor measurement preserves the primary read error while removing and closing its view", async () => {
  const events = [];
  let surfaces = [];
  const session = {
    async get(name) {
      if (name === "core.surfaces") return surfaces;
      if (name === "core.grid") return { cards: [{ id: "card-a", active: "browser-a",
        tabs: [{ id: "browser-a", plugin: "browser" }] }] };
      throw new Error(`unexpected status ${name}`);
    },
    async until(name, predicate) { assert.equal(name, "core.surfaces"); assert.equal(predicate(surfaces), true); return surfaces; },
    async run(name, params) {
      if (name === "core.card.add-tab") {
        surfaces = [{ surface: "hidden-a", plugin: "editor", exposes: ["command editor.memory.hidden"], status: { phase: "ready" } }];
        return { tab: "hidden-a" };
      }
      if (name === "editor.memory.hidden" && params.action === "read") throw new Error("fixture read failed");
      if (name === "editor.memory.hidden" && params.action === "remove") { events.push("removed"); return { mounted: false }; }
      if (name === "core.tab.close") { events.push("closed"); surfaces = []; return { closed: true }; }
      throw new Error(`unexpected command ${name}`);
    },
  };
  await assert.rejects(collectHiddenEditorFootprint(session, [{ pid: 401, footprintBytes: 5_000_000 }],
    async () => 4_800_000), /fixture read failed/);
  assert.deepEqual(events, ["removed", "closed"]);
  assert.deepEqual(surfaces, []);
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

test("editor motion evidence retains applied fractional native frame and WebKit viewport projection", { timeout: 1000 }, () => {
  const source = { sourceSequence: 4, frameIndex: 7, timeMs: 148, width: 785, height: 286 };
  const nativePlacement = { surface: "editor-1", phase: "placed", visible: true, timeMs: 147,
    framePt: { x: 10.5, y: 20, width: 785.5, height: 286.5 },
    webKitViewport: { width: 785, height: 286 } };
  assert.deepEqual(editorSourceContentFrame(source, nativePlacement), {
    sourceSequence: 4, frameIndex: 7, timeMs: 148, width: 785, height: 286, nativePlacement, source,
  });
  assert.throws(() => editorSourceContentFrame({ ...source, width: 0 }, nativePlacement), /invalid dimensions/);
});
