import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import test, { mock } from "node:test";

// The window list of the system is not read: no window of another application covers the fake window.
const frontmost = await import("../frontmost.mjs");
mock.module(pathToFileURL(new URL("../frontmost.mjs", import.meta.url).pathname).href, {
  namedExports: { ...frontmost, coveringWindows: () => [] },
});
const { drag, holdCovered } = await import("../app.mjs");

// A covered window draws its image regions only while the check asks for it (docs/spec/native-surfaces.md#image-regions),
// and the drag measures the page and the regions of that window, so the drag asks for it around the gesture and does not
// refuse a covered window. It still refuses an active window.
function session(window, calls) {
  return {
    app: { name: "wailsv3" },
    client: { endpoint: { pid: 4242 } },
    get: async () => window,
    presented: async () => ({ displayed: 12 }),
    trackRecording() {},
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === "diagnostics.drag") return { took: 100, asked: 100 };
      if (method === "diagnostics.window.draw-covered") return null;
      throw new Error(`unexpected method ${method}`);
    },
  };
}

const plan = { axis: "x", line: 0, dx: 10, dy: 0, ms: 100, times: 1 };

test("a drag of a covered window draws its regions during the gesture and ends the drawing after it", { timeout: 5000 }, async (t) => {
  const calls = [];
  const refusal = await drag(session({ active: false, occluded: true }, calls), plan).then(() => null, (error) => error.message);
  assert.equal(refusal, null, "the drag of a covered window was refused");
  assert.deepEqual(calls.map(({ method, params }) => method === "diagnostics.drag" ? method : `${method} ${params.draw}`),
    ["diagnostics.window.draw-covered true", "diagnostics.drag", "diagnostics.window.draw-covered false"]);
});

test("a drag that fails still ends the drawing of the covered window", { timeout: 5000 }, async (t) => {
  const calls = [];
  const s = session({ active: false, occluded: true }, calls);
  const request = s.request;
  s.request = async (method, params) => {
    if (method === "diagnostics.drag") {
      calls.push({ method, params });
      throw new Error("drag failed");
    }
    return request(method, params);
  };
  const failure = await drag(s, plan).then(() => null, (error) => error.message);
  assert.equal(failure, "drag failed", "the drag of a covered window failed for another reason than the drag");
  assert.deepEqual(calls.at(-1), { method: "diagnostics.window.draw-covered", params: { draw: false } });
});

test("a drag of an active window is refused before anything is requested", { timeout: 5000 }, async (t) => {
  const calls = [];
  await assert.rejects(drag(session({ active: true, occluded: false, pointer: {}, frame: {} }, calls), plan), /host\.window\.active is true/);
  assert.deepEqual(calls, []);
});

// The covered drawing is one state of the window (diagnostics.window.draw-covered), so the holds of a check and of a drag share it:
// a drag inside the drawing that a check holds for its whole run leaves that drawing on, and only the last release ends it.
test("a drag inside a held covered drawing leaves the drawing on", { timeout: 5000 }, async (t) => {
  const calls = [];
  const s = session({ active: false, occluded: true }, calls);
  const release = await holdCovered(s);
  await drag(s, plan);
  await drag(s, plan);
  assert.deepEqual(calls.map(({ method, params }) => method === "diagnostics.drag" ? method : `${method} ${params.draw}`),
    ["diagnostics.window.draw-covered true", "diagnostics.drag", "diagnostics.drag"]);
  await release();
  await release();
  assert.deepEqual(calls.at(-1), { method: "diagnostics.window.draw-covered", params: { draw: false } });
  assert.equal(calls.filter(({ method, params }) => method === "diagnostics.window.draw-covered" && params.draw === false).length, 1,
    "a second release of one hold ended the drawing again");
});
