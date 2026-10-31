// Checks the start values of a section surface (docs/spec/native-surfaces.md#view-surfaces): params null, an origin that records
// no directory, because no tab opened the section, and the member section {id, sidebar, card}.
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<body></body>", { url: "https://example.test/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;

const { viewStartValues } = await import("../surface-modules.js");

const section = { composition: { kind: "view", page: "ui/tree.html" }, surfaceId: "left/probe.tree", pluginId: "probe",
  declarations: {}, sidecars: [], diagnostics: null, unload: false, params: null,
  section: { id: "probe.tree", sidebar: "left", card: null } };

test("a section surface starts with params null, an origin without a directory and its section", () => {
  const start = viewStartValues(section, { id: "p1", root: "/work/p1", title: "p1" });
  assert.equal(start.params, null);
  assert.deepEqual(start.origin, { directory: null });
  assert.deepEqual(start.project, { id: "p1", root: "/work/p1" });
  assert.deepEqual(start.section, { id: "probe.tree", sidebar: "left", card: null });
  assert.equal(start.diagnostics, null);
});
