// The view of an image file in the debug view (docs/spec/debug.md#viewing): the native modal has the height of the card after the
// image loaded. An image has no height before it loads, so the card that was measured at the moment of the first draw is too low.
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

const PIXEL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

async function openImage(t) {
  const dom = new JSDOM("<body><div id=plane></div></body>");
  globalThis.document = dom.window.document;
  globalThis.CSS = { escape: (value) => value };
  const places = [];
  t.mock.module("../host.js", { namedExports: {
    native: true,
    debug: {
      record: async () => ({ path: "logs/state-1.json" }),
      files: async () => [{ path: "logs/captures/still-1/window.png", size: 267300, modified: 1 }],
      read: async ({ path }) => ({ path, size: 267300, truncated: false, kind: "image", text: "", image: PIXEL }),
      save: async () => {},
      saveAll: async () => {},
      onChanged: () => Promise.resolve(() => {}),
    },
    overlay: { show: () => {}, update: () => {}, place: (_element, rect) => places.push(rect), hide: () => {} },
  } });
  t.mock.module("../compositor.js", { namedExports: { standIn: () => {} } });
  t.mock.module("../icons.js", { namedExports: { icon: () => "" } });
  t.mock.module("../commands.js", { namedExports: { commandOf: () => null, delegate: () => {}, mark: () => {}, run: async () => {} } });
  t.mock.module("../exposure.js", { namedExports: { registry: { list: () => ({ status: [] }), registrants: () => [], handle: async () => ({}) } } });
  t.mock.module("../shown-errors.js", { namedExports: { hideError: () => {}, showError: () => {} } });
  const ui = await import(`../debug-ui.js?image-${Math.random()}`);
  document.getElementById("plane").getBoundingClientRect = () => ({ left: 0, top: 0 });
  await ui.openDebug();
  t.after(() => { ui.closeDebug(); dom.window.close(); });
  return { ui, places, dom };
}

test("the modal is placed again with the height of the card when the image has loaded", async (t) => {
  const { ui, places } = await openImage(t);
  const card = document.querySelector(".dbg-card");
  let loaded = false;
  // The height of the card is the height of its content: the image adds its height only after it loaded.
  card.getBoundingClientRect = () => ({ left: 0, top: 0, width: 640, height: loaded ? 700 : 300 });
  await ui.viewDebugFile("logs/captures/still-1/window.png");
  assert.equal(places.at(-1).h, 300, "before the load the card holds the height without the image");
  const before = places.length;
  loaded = true;
  document.querySelector(".dbg-card__image").dispatchEvent(new document.defaultView.Event("load"));
  assert.ok(places.length > before, "the modal was not placed again after the image loaded");
  assert.equal(places.at(-1).h, 700, "the modal does not have the height of the card with its image");
});

test("an image that loads twice, or after the view closed, places the modal only while the view shows it", async (t) => {
  const { ui, places } = await openImage(t);
  const card = document.querySelector(".dbg-card");
  card.getBoundingClientRect = () => ({ left: 0, top: 0, width: 640, height: 500 });
  await ui.viewDebugFile("logs/captures/still-1/window.png");
  const image = document.querySelector(".dbg-card__image");
  ui.listDebugFiles();
  const count = places.length;
  image.dispatchEvent(new document.defaultView.Event("load"));
  assert.equal(places.length, count, "a load of an image that the list replaced placed the modal");
});
