// A placement that leaves a surface out removes it from the host, and the keyboard calls go in the order of the other host
// calls, which no placement waits for. So the placement waits for the answer of every keyboard call to that surface that the page
// sent before it, and the host never refuses such a call as a call to a surface it no longer holds
// (docs/spec/native-surfaces.md#keyboard-of-a-surface).
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

const record = (ids) => ({
  surfaces: ids.map((id) => ({ id, dim: false, visible: true,
    surface: { pluginId: "probe", composition: { kind: "dom" } }, applied: { x: 0, y: 0, w: 3, h: 4 } })),
  settled: true, drawn: false, titlebar: 40,
});

const frame = (request) => ({ ticket: 1, placements: [], chrome: { controls: { x: 13, y: 13, w: 54, h: 14 }, row: request.titlebar } });

/** The host module over a host that records the calls and answers clearShape only when the check releases it. */
async function host(t, query) {
  const dom = new JSDOM('<div id="plane"></div>');
  globalThis.document = dom.window.document;
  t.after(() => dom.window.close());
  const calls = [];
  const reports = [];
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  t.mock.module("../page-log.js", { namedExports: {
    rawConsole: { error: () => {}, info: () => {} }, emitEvent: () => {}, eventEnabled: () => false,
    reportRecord: async (level, line) => { reports.push({ level, line }); }, flushEvents: async () => {},
  } });
  // The host holds a surface from the placement that names it until a placement leaves it out.
  const attached = new Set();
  t.mock.module("@soksak/runtime", { namedExports: { windows: {}, host: {
    on: () => {},
    page: (path) => path,
    call: (name, request) => {
      calls.push(name === "surfaceFocus" ? `${name} ${request.surface}` : name);
      if (name === "clearShape") return held;
      if (name === "surfaceFocus") {
        return request.surface === null || attached.has(request.surface) ? Promise.resolve(null)
          : Promise.reject(new Error(`surface "${request.surface}" is not attached`));
      }
      if (name === "syncSurfaces") {
        attached.clear();
        for (const { id } of request.surfaces) attached.add(id);
        return Promise.resolve(frame(request));
      }
      throw new Error(`unexpected host call ${name}`);
    },
  } } });
  const module = await import(`../host.js?${query}`);
  return { ...module, calls, reports, release };
}

test("a placement that removes a surface waits for the keyboard call to it that the page sent before", { timeout: 5000 }, async (t) => {
  const { surfaces, shapes, calls, reports, release } = await host(t, "placement-keyboard-removal");
  await surfaces.place(record(["tab-a", "tab-b"]));
  // An earlier ordered call holds the keyboard call, as the hide of a modal holds the call that returns the keyboard to the ring.
  shapes.clear("shape");
  const focused = surfaces.focus("tab-a");
  const removing = surfaces.place(record(["tab-b"]));
  // The removal of tab-a is the second syncSurfaces. It must come after the keyboard call to tab-a, so the order of the calls judges it.
  release(null);
  // The order is judged before the answers: a host that refuses the call to the removed surface fails the answer, and the order shows why.
  const answers = await Promise.allSettled([focused, removing]);
  assert.deepEqual(calls, ["syncSurfaces", "clearShape", "surfaceFocus tab-a", "syncSurfaces"],
    "the placement removed tab-a before the keyboard call to it reached the host");
  assert.deepEqual(answers.map(({ status }) => status), ["fulfilled", "fulfilled"], "the host refused a call of the placement");
  assert.deepEqual(reports, []);
});

test("a placement that keeps the surfaces of the keyboard calls does not wait for them", { timeout: 5000 }, async (t) => {
  const { surfaces, shapes, calls, release } = await host(t, "placement-keyboard-kept");
  await surfaces.place(record(["tab-a", "tab-b"]));
  shapes.clear("shape");
  const focused = surfaces.focus("tab-a");
  const workbench = surfaces.focus(null);
  await surfaces.place(record(["tab-a"]));
  assert.deepEqual(calls, ["syncSurfaces", "clearShape", "syncSurfaces"], "the placement waited for a keyboard call to a surface that it keeps");
  release(null);
  await Promise.all([focused, workbench]);
});
