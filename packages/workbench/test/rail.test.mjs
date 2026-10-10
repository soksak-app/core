// The rail outline is drawn in the CSS pixels of the plane.
//
// When an SVG element has a coordinate system (viewBox), that coordinate system is fitted to the box of the element. When the window grows, the element
// grows with the plane first, and until the next redraw the earlier path is moved or stretched to fit that box. The cards are still at the
// earlier position in the meantime, so the screen shows the outline moving before the cards. Without a coordinate system, the path numbers are
// CSS pixels, and the path stays in place until the next redraw even when the box of the element changes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";

const source = (name) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");

test("the rail outline is drawn in the plane's CSS pixels", () => {
  const { document } = new JSDOM(source("index.html")).window;
  const rail = document.getElementById("rail");
  assert.ok(rail, "the plane holds no rail outline");
  assert.equal(rail.getAttribute("viewBox"), null,
    "a viewBox scales the outline with the element, which moves it before the cards move");
  assert.ok(!/setAttribute\(\s*["']viewBox["']/.test(source("plane.js")),
    "the plane gives the outline a coordinate system that scales with its element");
});
