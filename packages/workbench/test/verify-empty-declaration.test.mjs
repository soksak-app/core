// V7a compares the place of each declared surface that has a presented area with its drawn slot. An invisible declaration with
// zero width or zero height has no presented area and so no place to compare (Verification in docs/spec/surface-composition.md).
// The plane, the compositor and the host module are the modules of the page; the host answers each preparation with the page-wire case
// of the test (docs/spec/cases/page-wire/README.md).
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { selectPageWire } from "@soksak/runtime";
import { openVerifyPlane, rect } from "./support/verify-plane.mjs";

// The host module reads the wire when it is imported, so the case of the first test is selected before the page opens.
const firstWire = selectPageWire("verify-empty-declaration-no-area");
const page = await openVerifyPlane();
after(() => page.close());
const { compositor, verify } = page;

/**
 * The V7a row of a plane whose card draws its slot at 1,1 with the size w×h, after the preparation of the card at 0,0 with the size
 * (w + 2)×(h + 2) whose surface is inset by 0,0,2,2. The host of the case of wire answers the preparation.
 */
async function v7a(wire, slot, { composition } = {}) {
  const card = { x: 0, y: 0, w: slot.w + 2, h: slot.h + 2 };
  const inset = { left: 0, top: 0, width: 2, height: 2 };
  globalThis.devicePixelRatio = 2;
  page.measure(page.planeEl, rect(0, 0, 400, 300));
  page.measure(page.card, rect(0, 0, slot.w + 2, slot.h + 2));
  page.measure(page.slot, rect(1, 1, slot.w, slot.h));
  page.mark({ composition });
  const cardId = page.card.dataset.cardId;
  try {
    await compositor.publishAhead(new Map([[cardId, card]]), new Map([[cardId, { id: "probe", dim: false, inset, grid: 2 }]]), 40);
    return verify().find((row) => row.name.startsWith("V7a "));
  } finally {
    page.reset();
    wire.finish();
  }
}

test("an invisible declaration without an area passes V7a wherever its empty slot stands", { timeout: 5000 }, async () => {
  // The surface has no area, so the host answers it as invisible.
  const row = await v7a(firstWire, { w: 0, h: 0 });
  assert.equal(row.ok, true, row.note);
});

test("a declaration with an area that is one point off its slot fails V7a", { timeout: 5000 }, async () => {
  const row = await v7a(selectPageWire("verify-empty-declaration-one-point-off"), { w: 10, h: 10 });
  assert.equal(row.ok, false);
  assert.match(row.note, /최대 1\.00px/);
});

test("a drawn slot of a view that its placement deferred is in the commit as deferred and V7a names it", { timeout: 5000 }, async () => {
  const wire = selectPageWire("verify-empty-declaration-deferred");
  // A view whose composition is not declared is not placed, so the placement defers it, and a placement that holds a view waits for
  // the theme of the host.
  await page.surfaces.theme({ scheme: "light", tokens: { "--bg": "#fff" } });
  const row = await v7a(wire, { w: 10, h: 10 }, { composition: { kind: "view", page: "ui/page.html" } });
  assert.equal(row.ok, true, row.note);
  assert.match(row.note, /미룬 표면 1 \[probe\]/);
});

test("a drawn slot that its commit neither places nor defers fails V7a", { timeout: 5000 }, async () => {
  const wire = selectPageWire("verify-empty-declaration-not-in-commit");
  // The commit is made before the drawing adds the slot, so it holds no surface.
  globalThis.devicePixelRatio = 2;
  page.measure(page.planeEl, rect(0, 0, 400, 300));
  page.measure(page.slot, rect(1, 1, 10, 10));
  try {
    await compositor.publishAhead(new Map(), new Map(), 40);
    page.mark();
    const row = verify().find((item) => item.name.startsWith("V7a "));
    assert.equal(row.ok, false);
    assert.match(row.note, /커밋에 없는 표면 1 \[probe\]/);
  } finally {
    page.reset();
  }
  wire.finish();
});
