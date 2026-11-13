import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { selectPageWire } from "@soksak/runtime";

const viewRecord = () => ({
  surfaces: [{ id: "view", plugin: "probe", dim: false, visible: true,
    surface: { pluginId: "probe", composition: { kind: "view", page: "ui/page.html" } },
    applied: { x: 0, y: 0, w: 3, h: 4 } }],
  settled: true, drawn: false, titlebar: 40,
});

// The page-wire cases answer the host calls of each test (docs/spec/cases/page-wire/README.md). Each test selects its case before it imports
// the host module, which reads the host when it is imported. The host module of a test is a copy of its own, so the placement state is new.
// The page log is one module of the page, so its first batch sends the clock calls and later batches do not.
const settled = () => new Promise((resolve) => setImmediate(resolve));
// The names of the host calls of the page in the order it sent them, without the calls of the application log.
const names = (wire) => wire.calls.map(({ name }) => name).filter((name) => name !== "log");
// The error records that the page wrote to the application log, as the lines `<where>: <text>`.
const errorLines = (wire) => wire.calls
  .filter(({ name, payload }) => name === "log" && payload.action === "batch")
  .flatMap(({ payload }) => payload.events.filter((event) => event.level === "error").map((event) => `${event.fields.where}: ${event.fields.text}`));

test("view placement waits for the latest host theme reply", { timeout: 5000 }, async () => {
  const wire = selectPageWire("host-theme-placement-order");
  const dom = new JSDOM('<div id="plane"></div>');
  globalThis.document = dom.window.document;
  try {
    const { surfaces } = await import("../host.js?theme-placement-order");
    const first = surfaces.theme({ scheme: "first", tokens: { "--bg": "#111" } });
    const placing = surfaces.place(viewRecord());
    await settled();
    assert.deepEqual(names(wire), ["setTheme"], "the view placement started before the first theme reply");

    const second = surfaces.theme({ scheme: "second", tokens: { "--bg": "#222" } });
    wire.release();
    await settled();
    assert.deepEqual(names(wire), ["setTheme", "setTheme"], "placement did not wait for the latest theme reply");

    wire.release();
    await Promise.all([first, second, placing]);
    assert.deepEqual(names(wire), ["setTheme", "setTheme", "syncSurfaces"]);
    wire.finish();
  } finally {
    dom.window.close();
  }
});

test("view placement rechecks the theme after its reply continuation", { timeout: 5000 }, async () => {
  const wire = selectPageWire("host-theme-placement-microtask");
  const dom = new JSDOM('<div id="plane"></div>');
  globalThis.document = dom.window.document;
  try {
    const { surfaces } = await import("../host.js?theme-placement-microtask");
    // The position of the request of the second theme among the host calls: the number of calls that the page had sent when it made the request.
    let requestedAt = -1;
    const first = surfaces.theme({ scheme: "first", tokens: {} });
    const placing = surfaces.place(viewRecord());
    await settled();
    assert.deepEqual(names(wire), ["setTheme"]);

    const second = first.then(() => {
      requestedAt = wire.calls.length;
      return surfaces.theme({ scheme: "second", tokens: {} });
    });
    wire.release();
    await settled();
    wire.release();
    await Promise.all([first, second, placing]);
    const placementIndex = names(wire).indexOf("syncSurfaces");
    const secondReplyIndex = names(wire).lastIndexOf("setTheme");
    assert.ok(placementIndex >= 0 && requestedAt >= 0 && secondReplyIndex >= 0);
    if (requestedAt <= placementIndex) {
      assert.ok(secondReplyIndex < placementIndex,
        "view placement was sent before the theme request that was queued after the prior reply");
    } else {
      assert.ok(placementIndex < secondReplyIndex,
        "the theme reply was sent before the later theme request");
    }
    assert.equal(names(wire).filter((name) => name === "syncSurfaces").length, 1);
    wire.finish();
  } finally {
    dom.window.close();
  }
});

test("a failed theme reply refuses view placement and reports the host error", { timeout: 5000 }, async () => {
  const wire = selectPageWire("host-theme-placement-failure");
  const dom = new JSDOM('<div id="plane"></div>');
  globalThis.document = dom.window.document;
  try {
    const { surfaces } = await import("../host.js?theme-placement-failure");
    const theme = surfaces.theme({ scheme: "broken", tokens: { "--bg": "#333" } });
    const placing = surfaces.place(viewRecord());
    const [themeResult, placeResult] = await Promise.allSettled([theme, placing]);
    await settled();
    assert.equal(themeResult.status, "rejected");
    assert.equal(placeResult.status, "rejected");
    assert.equal(placeResult.reason.message, "theme setter refused");
    assert.equal(names(wire).filter((name) => name === "syncSurfaces").length, 0, "a view was attached after theme setup failed");
    assert.deepEqual(errorLines(wire), ["host setTheme failed: Error: theme setter refused"]);
    await surfaces.place({ surfaces: [], settled: true, drawn: false, titlebar: 40 });
    assert.equal(names(wire).filter((name) => name === "syncSurfaces").length, 1,
      "a failed placement prevented the next independent layout from entering the host queue");
    wire.finish();
  } finally {
    dom.window.close();
  }
});

test("a failed theme reply with no view still uses the host error path", { timeout: 5000 }, async () => {
  const wire = selectPageWire("host-theme-placement-error-only");
  const dom = new JSDOM('<div id="plane"></div>');
  globalThis.document = dom.window.document;
  try {
    const { surfaces } = await import("../host.js?theme-error-without-view");
    await assert.rejects(surfaces.theme({ scheme: "broken", tokens: {} }), /theme setter refused/);
    await settled();
    await surfaces.place({ surfaces: [], settled: true, drawn: false, titlebar: 40 });
    assert.deepEqual(errorLines(wire), ["host setTheme failed: Error: theme setter refused"]);
    assert.equal(names(wire).filter((name) => name === "syncSurfaces").length, 1,
      "a failed theme without a view prevented the ordinary surface layout");
    wire.finish();
  } finally {
    dom.window.close();
  }
});
