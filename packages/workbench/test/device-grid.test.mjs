// The plane starts and ends on the device pixel grid whatever lies above it (docs/spec/native-surfaces.md): the host seats native
// surfaces on that grid, so a plane between grid lines puts every declared surface off its applied place.
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { alignPlane, gridInsets } from "../device-grid.js";

/**
 * A stage and its plane laid out the way app.css lays them out: the content box of the stage starts at top and left and ends at
 * bottom and right, and the plane fills it inside the insets that the stage holds in --plane-grid-*. JSDOM has no layout, so the
 * plane computes its rectangle from those insets.
 */
function laidOut({ top, right, bottom, left }) {
  const { document } = new JSDOM("<main class=stage><div class=plane></div></main>").window;
  const stage = document.querySelector(".stage");
  const plane = document.querySelector(".plane");
  const inset = (side) => {
    const text = stage.style.getPropertyValue(`--plane-grid-${side}`);
    return text === "" ? 0 : parseFloat(text);
  };
  plane.getBoundingClientRect = () => {
    const box = { top: top + inset("top"), left: left + inset("left"), bottom: bottom - inset("bottom"), right: right - inset("right") };
    return { ...box, x: box.left, y: box.top, width: box.right - box.left, height: box.bottom - box.top };
  };
  return { stage, plane };
}

const onGrid = (value, scale) => Math.abs(value * scale - Math.round(value * scale)) < 1e-9;

test("a shown error of 34.4px above the plane leaves the plane origin and size on the device pixel grid", () => {
  // The first row of 40px, the error banner of 17.4px of text, 16px of padding and a 1px border, the space row of 36px, the stage
  // border of 1px and its padding of 6px.
  const top = 40 + 34.4 + 36 + 1 + 6;
  for (const scale of [1, 2, 3]) {
    const { plane } = laidOut({ top, left: 7, bottom: 900.7, right: 1193 });
    alignPlane(plane, scale);
    const rect = plane.getBoundingClientRect();
    for (const edge of ["top", "left", "bottom", "right"]) {
      assert.ok(onGrid(rect[edge], scale), `at scale ${scale} the plane ${edge} ${rect[edge]} is between device pixels`);
    }
    assert.ok(rect.top >= top && rect.top - top < 1 / scale, `at scale ${scale} the plane moved down by ${rect.top - top}px`);
    assert.ok(rect.bottom <= 900.7 && 900.7 - rect.bottom < 1 / scale, `at scale ${scale} the plane bottom moved by ${900.7 - rect.bottom}px`);
  }
});

test("aligning the plane again keeps the insets it already holds, and a plane on the grid takes none", () => {
  const { stage, plane } = laidOut({ top: 117.4, left: 7, bottom: 900, right: 1193 });
  alignPlane(plane, 2);
  const first = stage.getAttribute("style");
  alignPlane(plane, 2);
  assert.equal(stage.getAttribute("style"), first, "a second alignment changed the insets of an aligned plane");
  assert.deepEqual(gridInsets({ top: 117.5, left: 7, bottom: 900, right: 1193 }, 2), { top: 0, right: 0, bottom: 0, left: 0 });
});

test("the plane grid refuses a box that is not a number and a scale that is not positive", () => {
  assert.throws(() => gridInsets({ top: Number.NaN, left: 0, bottom: 1, right: 1 }, 2), /invalid plane box/);
  assert.throws(() => gridInsets({ top: 0, left: 0, bottom: 1, right: 1 }, 0), /device pixel ratio 0/);
});
