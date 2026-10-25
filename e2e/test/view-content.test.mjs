import assert from "node:assert/strict";
import test from "node:test";
import { cropViewPixels } from "../view-content.mjs";

function frame() {
  const data = Buffer.alloc(8 * 8 * 4);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) data[(y * 8 + x) * 4] = y * 8 + x;
  return { width: 8, height: 8, stride: 32, scale: 2, contentScale: 1, content: { x: 1, y: 1 }, data };
}

test("view pixel crops include the capture content origin and scale once", { timeout: 5000 }, () => {
  const crop = cropViewPixels(frame(), { x: 1, y: 1, w: 2, h: 1 });
  assert.equal(crop.width, 4);
  assert.equal(crop.height, 2);
  assert.deepEqual([...crop.data.filter((_, i) => i % 4 === 0)], [36, 37, 38, 39, 44, 45, 46, 47]);
});

test("view pixel crops reject clipping and incomplete pixel storage", { timeout: 5000 }, () => {
  assert.throws(() => cropViewPixels(frame(), { x: 3, y: 3, w: 2, h: 2 }), /outside/);
  const value = frame();
  value.data = value.data.subarray(0, 10);
  assert.throws(() => cropViewPixels(value, { x: 0, y: 0, w: 1, h: 1 }), /storage/);
});

test("terminal content readiness preserves omitted blank cell characters", { timeout: 5000 }, async (t) => {
  const { viewContentCases } = await import("../view-content.mjs");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "view-content-owner-"));
  const previous = process.env.SOKSAK_CAPTURE_TEXT;
  process.env.SOKSAK_CAPTURE_TEXT = process.execPath;
  t.after(() => {
    if (previous === undefined) delete process.env.SOKSAK_CAPTURE_TEXT;
    else process.env.SOKSAK_CAPTURE_TEXT = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const s = {
    get: async () => ({ root }),
    cleanup() {},
    run: async () => null,
    rect: async () => ({ width: 100, height: 50 }),
    async until(name, predicate) {
      const value = name === "core.surfaces" ? [{ surface: "probe", exposes: ["status terminal.session", "status terminal.screen"] }]
        : name === "terminal.session" ? { sessionId: "session", cols: 80, rows: 24 }
        : [[..."SOKSAK TERMINAL CONTENT"].map(ch => ch === " " ? { width: 1 } : { ch, width: 1 })];
      assert.ok(predicate(value), `${name} readiness discarded an omitted blank character`);
      return value;
    },
  };
  const cases = await viewContentCases(s, () => {});
  assert.equal(typeof await cases.get("terminal").ready(s, { tab: "probe" }), "function");
});
