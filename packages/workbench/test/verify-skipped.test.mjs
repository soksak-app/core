// A check that has nothing to measure in a state is no pass: it is stated as skipped.
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { Soksak } from "soksak";

test("a single empty plane before any commit states the checks that measured nothing as skipped", async (t) => {
  const dom = new JSDOM('<div class="chrome-bar"></div><div id="stage"><div id="plane"></div></div>');
  globalThis.document = dom.window.document;
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.devicePixelRatio = 1;
  t.after(() => { delete globalThis.devicePixelRatio; dom.window.close(); });
  const plane = document.querySelector("#plane");
  const grid = new Soksak(undefined, { width: 100, height: 100 });
  t.mock.module("../compositor.js", { exports: { ahead: () => null, latest: () => null, placementPending: () => false, seated: () => null } });
  t.mock.module("../plane.js", { exports: {
    currentGrid: () => grid, dropBands: () => ({ headerPx: 32, footerPx: 22 }), plane, presentedCardRect: () => undefined,
    railOutline: () => ({ shape: { sharp: 0, corners: 0, loops: [] }, rects: [], groups: [] }), tabsOf: () => [],
  } });
  t.mock.module("../registry.js", { exports: { isPlace: () => false } });
  t.mock.module("../settings.js", { exports: { cardRadius: () => 4, value: (key) => (key === "sidebarOrder" ? ["left", "right", "top", "bottom"] : undefined) } });
  const { verify } = await import(`../verify.js?skipped-${Math.random()}`);
  const rows = verify();
  const skipped = rows.filter((row) => row.skipped).map((row) => row.name.split(" ")[0]);
  assert.deepEqual(skipped, ["V0", "V1", "V3", "V6", "V7a", "V7c", "V7b", "V9", "V10", "R", "D", "P", "W"]);
  for (const row of rows) {
    if (row.skipped) {
      assert.equal(row.ok, undefined, `${row.name} states a pass`);
      assert.ok(row.note, `${row.name} does not say why`);
    }
  }
});
