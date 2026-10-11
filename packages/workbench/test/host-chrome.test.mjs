// A preparation holds the title bar height, and the page reads the window button region of the preparation whose presentation it confirmed as the committed state. No call
// requests the title bar separately after drawing (docs/spec/native-surfaces.md#title-bar-height).
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { JSDOM } from "jsdom";
import { clockAnswer } from "./support/records.mjs";

test("the preparation carries the title bar height and the presented chrome is the committed one", async () => {
  const dom = new JSDOM('<div id="plane"></div>');
  globalThis.document = dom.window.document;
  const calls = [];
  let prepared = 0;
  mock.module("@soksak/runtime", { namedExports: { host: {
    on: () => {},
    page: (path) => path,
    call: async (name, request) => {
      calls.push({ name, request });
      if (name === "log") return clockAnswer(name, request);
      if (name === "syncSurfaces") {
        prepared++;
        return {
          ticket: prepared,
          placements: [{ id: "surface", x: 1, y: 2, w: 3, h: 4, visible: true }],
          // The window button region that the host read after it set the title bar inside the transaction: the 14 pt buttons are centered in the row.
          chrome: { controls: { x: 13, y: (request.titlebar - 14) / 2, w: 54, h: 14 }, row: request.titlebar },
        };
      }
      if (name === "presentSurfaces") return request.placements;
      throw new Error(`unexpected host call ${name}`);
    },
  } } });
  const { chrome, surfaces } = await import("../host.js");
  const record = (titlebar, drawn) => ({
    surfaces: [{
      id: "surface", dim: false, visible: true,
      surface: { module: "surface-module", composition: { kind: "dom" } },
      applied: { x: 1, y: 2, w: 3, h: 4 },
    }],
    settled: true, drawn, titlebar,
  });
  try {
    assert.equal("titlebar" in chrome, false, "the page has no title bar request apart from the preparation");
    assert.equal(chrome.presented(), null, "no preparation has been presented");

    await surfaces.place(record(54, false));
    assert.deepEqual(calls.map((c) => c.name), ["syncSurfaces"]);
    assert.equal(calls[0].request.titlebar, 54, "the preparation carries the row of the next draw");
    assert.equal(chrome.presented(), null, "a preparation is not the committed state before its presentation");

    await surfaces.place(record(54, true));
    assert.deepEqual(calls.map((c) => c.name), ["syncSurfaces", "presentSurfaces"],
      "the draw makes no request other than the presentation");
    assert.deepEqual(Object.keys(calls[1].request).sort(), ["placements", "settled", "ticket", "waitForPresentation"],
      "the presentation sends the prepared ticket and placements");
    assert.deepEqual(chrome.presented(), { controls: { x: 13, y: 20, w: 54, h: 14 }, row: 54 });

    // The preparation of the next layout does not change the committed state until its presentation is confirmed.
    await surfaces.place(record(40, false));
    assert.equal(calls.at(-1).request.titlebar, 40);
    assert.equal(chrome.presented().row, 54, "an unpresented preparation replaced the committed chrome");
    await surfaces.place(record(40, true));
    assert.equal(chrome.presented().row, 40);

    // The same request is not sent again. When the state of the window changed without a request (a window that left full screen), the same
    // request is sent after forget.
    calls.length = 0;
    await surfaces.place(record(40, false));
    assert.deepEqual(calls, [], "an unchanged request was sent");
    surfaces.forget();
    await surfaces.place(record(40, false));
    await surfaces.place(record(40, true));
    assert.deepEqual(calls.map((c) => c.name), ["syncSurfaces", "presentSurfaces"],
      "a forgotten request was not sent again");
    assert.equal(calls[0].request.titlebar, 40);
  } finally {
    dom.window.close();
  }
});
