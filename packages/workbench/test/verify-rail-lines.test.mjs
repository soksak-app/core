// Verification R measures the lines only when the plane is at the size it last drew. When a new layout replaces the awaited layout, the grid already has the new size and
// the lines are still drawn at the earlier size, so the test compares the extent of the drawn cards with the plane, not the size of the grid (F34).
// The plane and the compositor are the modules of the page, which runs without an application host.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { openVerifyPlane, rect } from "./support/verify-plane.mjs";

const page = await openVerifyPlane();
after(() => page.close());

/** The R row of a plane that drew its card at the width of drawn and now measures 400×300 with one line of 700×1. */
function railRow(drawn) {
  page.size.width = drawn;
  page.size.height = 300;
  page.redraw();
  try {
    // The window shrank, so the plane is already 400×300, and the lines are drawn on the earlier plane.
    page.measure(page.planeEl, rect(6, 6, 400, 300));
    page.measure(page.planeEl.parentElement, rect(0, 0, 412, 312));
    const line = page.append('<div class="sp-rule"></div>');
    page.measure(line, rect(6, 6, 700, 1));
    return page.verify().find((row) => row.name.startsWith("R "));
  } finally {
    page.reset();
  }
}

test("rail lines are not measured while the plane shows a layout of an earlier size", { timeout: 5000 }, () => {
  const row = railRow(700);
  assert.equal(row.skipped, true, `lines of the earlier layout were measured against the new plane: ${row.note}`);
  assert.equal(row.note, "판이 아직 새 크기로 그려지지 않았다");
});

test("rail lines beyond the margin fail when the plane shows its current size", { timeout: 5000 }, () => {
  const row = railRow(400);
  assert.equal(row.ok, false);
  assert.match(row.note, /최대 300\.00px/);
});
