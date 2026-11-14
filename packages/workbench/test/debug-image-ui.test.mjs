// The view of an image file in the debug view (docs/spec/debug.md#viewing): the native modal has the height of the card after the
// image loaded. An image has no height before it loads, so the card that was measured at the moment of the first draw is too low. The
// host calls of each test are the page-wire case of the test (docs/spec/cases/page-wire/README.md); the case records the frame that the
// page places the modal at, so a placement is judged by the frame in the call.
import assert from "node:assert/strict";
import test from "node:test";
import { openDebugView } from "./support/debug-document.mjs";

const IMAGE = "logs/captures/still-1/window.png";
const places = (wire) => wire.calls.filter((call) => call.name === "overlayPlace");

test("the modal is placed again with the height of the card when the image has loaded", async () => {
  const { ui, wire, calls, close } = await openDebugView("debug-image-ui-load");
  try {
    const card = document.querySelector(".dbg-card");
    let loaded = false;
    // The height of the card is the height of its content: the image adds its height only after it loaded.
    card.getBoundingClientRect = () => ({ left: 0, top: 0, width: 640, height: loaded ? 700 : 300 });
    await ui.viewDebugFile(IMAGE);
    await calls();
    assert.equal(places(wire).at(-1).payload.card.h, 300, "before the load the card holds the height without the image");
    const before = places(wire).length;
    loaded = true;
    document.querySelector(".dbg-card__image").dispatchEvent(new document.defaultView.Event("load"));
    await calls();
    assert.ok(places(wire).length > before, "the modal was not placed again after the image loaded");
    assert.equal(places(wire).at(-1).payload.card.h, 700, "the modal does not have the height of the card with its image");
  } finally {
    await close();
  }
  wire.finish();
});

test("an image that loads twice, or after the view closed, places the modal only while the view shows it", async () => {
  const { ui, wire, calls, close } = await openDebugView("debug-image-ui-replaced");
  try {
    const card = document.querySelector(".dbg-card");
    card.getBoundingClientRect = () => ({ left: 0, top: 0, width: 640, height: 500 });
    await ui.viewDebugFile(IMAGE);
    const image = document.querySelector(".dbg-card__image");
    ui.listDebugFiles();
    await calls();
    const count = places(wire).length;
    image.dispatchEvent(new document.defaultView.Event("load"));
    await calls();
    assert.equal(places(wire).length, count, "a load of an image that the list replaced placed the modal");
  } finally {
    await close();
  }
  wire.finish();
});
