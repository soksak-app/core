import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { Soksak } from "soksak";

// AppKit 은 창 단추를 device pixel 에 맞추므로, 남는 높이가 홀수 pixel 이면 위와 아래는 한 pixel 다르다.
// W 행은 그 차이를 한 device pixel(1 / devicePixelRatio) 안에서 가운데로 판정한다.
test("the window buttons count as centred within one device pixel of the first row", async (t) => {
  const dom = new JSDOM('<div class="chrome-bar"></div><div id="plane"></div>');
  globalThis.document = dom.window.document;
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  document.querySelector(".chrome-bar").getBoundingClientRect = () => ({ top: 0, bottom: 45, height: 45, left: 0, right: 600, width: 600 });
  const plane = document.querySelector("#plane");
  const grid = new Soksak(undefined, { width: 100, height: 100 });
  t.mock.module("../compositor.js", { exports: { ahead: () => null, latest: () => null, placementPending: () => false, seated: () => null } });
  t.mock.module("../plane.js", { exports: { currentGrid: () => grid, dropBands: () => ({ headerPx: 32, footerPx: 22 }), plane, presentedCardRect: () => undefined, railOutline: () => ({ shape: { sharp: 0, corners: 0, loops: [] }, rects: [], groups: [] }), tabsOf: () => [] } });
  t.mock.module("../registry.js", { exports: { isPlace: () => false } });
  t.mock.module("../settings.js", { exports: { cardRadius: () => 4 } });
  const { verify } = await import("../verify.js");
  const row = (controls) => verify(controls).find((item) => item.name.startsWith("W "));
  try {
    globalThis.devicePixelRatio = 1;
    assert.equal(row({ x: 13, y: 15, w: 54, h: 14 }).ok, true, "15 above and 16 below is centred at scale 1");
    assert.equal(row({ x: 13, y: 14, w: 54, h: 14 }).ok, false, "14 above and 17 below is not centred at scale 1");
    globalThis.devicePixelRatio = 2;
    assert.equal(row({ x: 13, y: 15.5, w: 54, h: 14 }).ok, true, "15.5 above and below is centred at scale 2");
    assert.equal(row({ x: 13, y: 15, w: 54, h: 14 }).ok, false, "15 above and 16 below is two device pixels apart at scale 2");
  } finally {
    delete globalThis.devicePixelRatio;
    dom.window.close();
  }
});
