// A placement that leaves a surface out removes it from the host, and the keyboard calls go in the order of the other host
// calls, which no placement waits for. So the placement waits for the answer of every keyboard call to that surface that the page
// sent before it, and the host never refuses such a call as a call to a surface it no longer holds
// (docs/spec/native-surfaces.md#keyboard-of-a-surface).
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { selectPageWire } from "@soksak/runtime";

const record = (ids) => ({
  surfaces: ids.map((id) => ({ id, dim: false, visible: true,
    surface: { pluginId: "probe", composition: { kind: "dom" } }, applied: { x: 0, y: 0, w: 3, h: 4 } })),
  settled: true, drawn: false, titlebar: 40,
});

// The host calls of the page as the assertions name them: a keyboard call names its surface.
const calls = (wire) => wire.calls.map(({ name, payload }) => (name === "surfaceFocus" ? `${name} ${payload.surface}` : name));

/** The host module over the page-wire case of the name, with the real page modules. Each call of the page is answered by the case. */
async function host(t, query, name) {
  const dom = new JSDOM('<div id="plane"></div>');
  globalThis.document = dom.window.document;
  t.after(() => dom.window.close());
  // The case is selected before host.js is imported, because the page reads the host when it imports the module.
  const wire = selectPageWire(name);
  const module = await import(`../host.js?${query}`);
  const { flushEvents } = await import("../page-log.js");
  return { ...module, wire, flushEvents };
}

test("a placement that removes a surface waits for the keyboard call to it that the page sent before", { timeout: 5000 }, async (t) => {
  const { surfaces, shapes, wire, flushEvents } = await host(t, "placement-keyboard-removal", "placement-keyboard-order-removal");
  await surfaces.place(record(["tab-a", "tab-b"]));
  // An earlier ordered call holds the keyboard call, as the hide of a modal holds the call that returns the keyboard to the ring.
  shapes.clear("shape");
  const focused = surfaces.focus("tab-a");
  const removing = surfaces.place(record(["tab-b"]));
  // The removal of tab-a is the second syncSurfaces. It must come after the keyboard call to tab-a, so the order of the calls judges it.
  // The page sends the held clear in a later turn, so the release waits for that turn.
  await new Promise(setImmediate);
  wire.release();
  // The order is judged before the answers: a host that refuses the call to the removed surface fails the answer, and the order shows why.
  const answers = await Promise.allSettled([focused, removing]);
  assert.deepEqual(calls(wire), ["syncSurfaces", "clearShape", "surfaceFocus tab-a", "syncSurfaces"],
    "the placement removed tab-a before the keyboard call to it reached the host");
  assert.deepEqual(answers.map(({ status }) => status), ["fulfilled", "fulfilled"], "the host refused a call of the placement");
  // The page log writes its records in a batch of the call log; no record was written, so no call of the log was sent.
  await flushEvents();
  assert.deepEqual(wire.calls.filter(({ name }) => name === "log"), []);
  wire.finish();
});

test("a placement that keeps the surfaces of the keyboard calls does not wait for them", { timeout: 5000 }, async (t) => {
  const { surfaces, shapes, wire } = await host(t, "placement-keyboard-kept", "placement-keyboard-order-kept");
  await surfaces.place(record(["tab-a", "tab-b"]));
  shapes.clear("shape");
  const focused = surfaces.focus("tab-a");
  const workbench = surfaces.focus(null);
  await surfaces.place(record(["tab-a"]));
  assert.deepEqual(calls(wire), ["syncSurfaces", "clearShape", "syncSurfaces"], "the placement waited for a keyboard call to a surface that it keeps");
  wire.release();
  await Promise.all([focused, workbench]);
  wire.finish();
});
