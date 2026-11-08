import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PLAIN_CONTENT, cropViewPixels, readViewContent, viewContentCases, viewContentProof } from "../view-content.mjs";

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

/** A session whose host.window shows the root document and the document region "page" of the surface probe; `runs` answers each command by name. */
function session(runs, { visible = true } = {}) {
  const frame = { x: 0, y: 0, width: 100, height: 50 };
  const host = { documents: [{ surface: "probe", document: "", visible, frame }, { surface: "probe", document: "page", visible, frame }] };
  return {
    get: async (name) => { assert.equal(name, "host.window"); return host; },
    run: async (name, params, surface) => {
      assert.equal(surface, "probe");
      assert.ok(name in runs, `unexpected command ${name}`);
      return runs[name](params);
    },
  };
}

const READ = Object.freeze({ command: "probeplain.content.read" });

test("view content reads the text of the content read that the check names in the visible document region", { timeout: 5000 }, async () => {
  assert.deepEqual(await viewContentProof(session({ "probeplain.content.read": () => "PROBE CONTENT\n" }), "probe", "PROBE CONTENT", READ),
    { method: "value", expected: "PROBE CONTENT", actual: "PROBE CONTENT\n" });
  assert.equal(await readViewContent(session({ "probeplain.content.read": () => "region text" }), "probe", { ...READ, document: "page" }),
    "region text");
});

test("view content refuses a missing, wrong or not presented value", { timeout: 5000 }, async () => {
  await assert.rejects(viewContentProof(session({ "probeplain.content.read": () => "OTHER\n" }), "probe", "PROBE CONTENT", READ),
    /probeplain.content.read probe does not show "PROBE CONTENT": "OTHER\\n"/);
  await assert.rejects(viewContentProof(session({ "probeplain.content.read": () => "PROBE CONTENT" }, { visible: false }), "probe",
    "PROBE CONTENT", READ), /shows no document region ""/);
  await assert.rejects(readViewContent(session({ "probeplain.content.read": () => "x" }), "probe", { ...READ, document: "studio" }),
    /shows no document region "studio"/);
  await assert.rejects(viewContentProof(session({ "probeplain.content.read": () => null }), "probe", "PROBE CONTENT", READ),
    /probeplain.content.read of probe answered no text: null/);
  await assert.rejects(readViewContent(session({}), "probe", {}), /the content read of probe names no command/);
});

test("the content case of the plain view probe waits for its content read and proves the text of its region document", async () => {
  const diagnostics = [];
  const frame = { x: 0, y: 0, width: 100, height: 50 };
  const calls = [];
  const s = {
    async until(name, predicate, message) {
      calls.push(["until", name]);
      const value = [{ surface: "tab-1", exposes: ["command probeplain.content.read"] }];
      if (!predicate(value)) throw new Error(message);
      return value;
    },
    get: async () => ({ documents: [{ surface: "tab-1", document: "page", visible: true, frame }] }),
    run: async (name, params, surface) => {
      calls.push(["run", name, surface]);
      return PLAIN_CONTENT;
    },
  };
  const cases = await viewContentCases(s, (message) => diagnostics.push(message));
  assert.deepEqual([...cases.keys()], ["probeplain"]);
  const verify = await cases.get("probeplain").ready(s, { tab: "tab-1" });
  await verify();
  assert.deepEqual(calls, [["until", "core.surfaces"], ["run", "probeplain.content.read", "tab-1"]]);
  assert.deepEqual(diagnostics, [`probeplain tab-1 shows ${JSON.stringify(PLAIN_CONTENT)}`]);
  const shown = readFileSync(new URL("../fixtures/plain-view/probe/ui/document.html", import.meta.url), "utf8");
  assert.ok(shown.includes(`<p id="content">${PLAIN_CONTENT}</p>`), "the region document of the plain view probe does not show PLAIN_CONTENT");
});
