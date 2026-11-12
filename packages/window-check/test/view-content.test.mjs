import assert from "node:assert/strict";
import test from "node:test";
import { readViewContent, viewContentProof, visibleDocument } from "../view-content.mjs";

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

const READ = Object.freeze({ command: "probe.content.read" });

test("view content reads the text of the content read that the check names in the visible document region", { timeout: 5000 }, async () => {
  assert.deepEqual(await viewContentProof(session({ "probe.content.read": () => "PROBE CONTENT\n" }), "probe", "PROBE CONTENT", READ),
    { method: "value", expected: "PROBE CONTENT", actual: "PROBE CONTENT\n" });
  assert.equal(await readViewContent(session({ "probe.content.read": () => "region text" }), "probe", { ...READ, document: "page" }),
    "region text");
});

test("view content refuses a missing, wrong or not presented value", { timeout: 5000 }, async () => {
  await assert.rejects(viewContentProof(session({ "probe.content.read": () => "OTHER\n" }), "probe", "PROBE CONTENT", READ),
    /probe.content.read probe does not show "PROBE CONTENT": "OTHER\\n"/);
  await assert.rejects(viewContentProof(session({ "probe.content.read": () => "PROBE CONTENT" }, { visible: false }), "probe",
    "PROBE CONTENT", READ), /shows no document region ""/);
  await assert.rejects(readViewContent(session({ "probe.content.read": () => "x" }), "probe", { ...READ, document: "studio" }),
    /shows no document region "studio"/);
  await assert.rejects(viewContentProof(session({ "probe.content.read": () => null }), "probe", "PROBE CONTENT", READ),
    /probe.content.read of probe answered no text: null/);
  await assert.rejects(readViewContent(session({}), "probe", {}), /the content read of probe names no command/);
});

test("the visible document region of a view is its host.window row, and a region that is absent or not shown fails", { timeout: 5000 }, async () => {
  assert.deepEqual(await visibleDocument(session({}), "probe", "page"),
    { surface: "probe", document: "page", visible: true, frame: { x: 0, y: 0, width: 100, height: 50 } });
  assert.equal((await visibleDocument(session({}), "probe")).document, "");
  await assert.rejects(visibleDocument(session({}), "probe", "studio"), /probe shows no document region "studio": undefined/);
  await assert.rejects(visibleDocument(session({}, { visible: false }), "probe", "page"), /probe shows no document region "page"/);
});
