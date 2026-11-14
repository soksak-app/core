import assert from "node:assert/strict";
import { after, test } from "node:test";
import { openVerifyPlane } from "./support/verify-plane.mjs";

// The page runs without an application host, so the plane is laid out and drawn in the document of index.html. The verification reads
// the plane and the compositor of that page; the rectangle of the first row is the geometry that the document provides. A plugin that no
// environment loads opens as a placeholder tab, so the card holds one tab without a surface.
const page = await openVerifyPlane();
after(() => page.close());
const { verify } = page;
document.querySelector(".chrome-bar").getBoundingClientRect = () => ({ top: 0, bottom: 45, height: 45, left: 0, right: 600, width: 600 });

// AppKit aligns the window buttons to device pixels, so when the remaining height is an odd number of pixels, the top and the bottom differ by one pixel.
// Row W judges that difference as centered within one device pixel (1 / devicePixelRatio).
test("the window buttons count as centred within one device pixel of the first row", { timeout: 5000 }, async () => {
  const row = (controls) => verify(controls).find((item) => item.name.startsWith("W "));
  try {
    globalThis.devicePixelRatio = 1;
    assert.equal(row({ x: 13, y: 15, w: 54, h: 14 }).ok, true, "15 above and 16 below is centred at scale 1");
    assert.equal(row({ x: 13, y: 14, w: 54, h: 14 }).ok, false, "14 above and 17 below is not centred at scale 1");
    globalThis.devicePixelRatio = 2;
    assert.equal(row({ x: 13, y: 15.5, w: 54, h: 14 }).ok, true, "15.5 above and below is centred at scale 2");
    assert.equal(row({ x: 13, y: 15, w: 54, h: 14 }).ok, false, "15 above and 16 below is two device pixels apart at scale 2");
  } finally {
    page.reset();
  }
});
