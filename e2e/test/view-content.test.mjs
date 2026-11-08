import assert from "node:assert/strict";
import test from "node:test";
import { cropViewPixels, viewContentProof } from "../view-content.mjs";

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

/**
 * A session whose host.window shows the root document of every surface and the studio of hwp, and whose image region named
 * view presents `presented`; `runs` answers each command by name.
 */
function session(runs, { visible = true, presented = { generation: 1, raster: 2, sequence: 3 } } = {}) {
  const frame = { x: 0, y: 0, width: 100, height: 50 };
  const host = { documents: [{ surface: "probe", document: "", visible, frame }, { surface: "probe", document: "studio", visible, frame }],
    regions: [{ surface: "probe", name: "view", presented }] };
  return {
    get: async (name) => { assert.equal(name, "host.window"); return host; },
    run: async (name, params, surface) => {
      assert.equal(surface, "probe");
      assert.ok(name in runs, `unexpected command ${name}`);
      return runs[name](params);
    },
    async until(name, predicate, message) {
      assert.equal(name, "host.window");
      if (!predicate(host)) throw new Error(message);
      return host;
    },
  };
}

const cells = (text) => [...text].map((ch) => ch === " " ? { width: 1 } : { ch, width: 1 });

test("view content reads the value that holds the shown text of each plugin", { timeout: 5000 }, async () => {
  assert.deepEqual(await viewContentProof(session({ "editor.read": () => "SOKSAK EDITOR CONTENT\n" }), "editor", "probe",
    "SOKSAK EDITOR CONTENT"), { method: "value", expected: "SOKSAK EDITOR CONTENT", actual: "SOKSAK EDITOR CONTENT\n" });
  assert.equal((await viewContentProof(session({ "browser.content.read": () => ({ kind: "empty", instruction: "주소를 입력하세요" }) }),
    "browser", "probe", "주소를 입력하세요")).actual, "주소를 입력하세요");
  const svg = '<text x="1" y="10">속삭</text><text x="2" y="10">한글</text><text x="1" y="20">문서확인</text>';
  assert.equal((await viewContentProof(session({ "hwp.request": ({ method }) => { assert.equal(method, "getPageSvg"); return svg; } }),
    "hwp", "probe", "속삭한글문서확인")).actual, "속삭한글\n문서확인");
  for (const plugin of ["term", "terminal"]) {
    const read = () => ({ rows: [cells("SOKSAK TERM CONTENT")], frame: { generation: 1, raster: 2, sequence: 3 } });
    assert.equal((await viewContentProof(session({ [`${plugin}.screen.read`]: read }), plugin, "probe", "SOKSAK TERM CONTENT")).actual,
      "SOKSAK TERM CONTENT");
  }
});

test("view content refuses a missing, wrong or not presented value", { timeout: 5000 }, async () => {
  await assert.rejects(viewContentProof(session({ "editor.read": () => "OTHER\n" }), "editor", "probe", "SOKSAK EDITOR CONTENT"),
    /does not show "SOKSAK EDITOR CONTENT": "OTHER\\n"/);
  await assert.rejects(viewContentProof(session({ "editor.read": () => "SOKSAK EDITOR CONTENT\n" }, { visible: false }), "editor",
    "probe", "SOKSAK EDITOR CONTENT"), /shows no document region ""/);
  await assert.rejects(viewContentProof(session({ "browser.content.read": () => ({ kind: "document", instruction: null }) }), "browser",
    "probe", "주소를 입력하세요"), /does not show its empty instruction/);
  const read = () => ({ rows: [cells("SOKSAK TERM CONTENT")], frame: { generation: 1, raster: 2, sequence: 4 } });
  await assert.rejects(viewContentProof(session({ "term.screen.read": read }), "term", "probe", "SOKSAK TERM CONTENT"),
    /did not present frame/);
  await assert.rejects(viewContentProof(session({ "editor.read": () => null }), "editor", "probe", "SOKSAK EDITOR CONTENT"),
    /content is not text/);
  await assert.rejects(viewContentProof(session({}), "files", "probe", "x"), /plugin files has no content value/);
});

test("terminal content readiness preserves omitted blank cell characters", { timeout: 5000 }, async (t) => {
  const { viewContentCases } = await import("../view-content.mjs");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "view-content-owner-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
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
