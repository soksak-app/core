// When verification V7c fails, it names the surface that is off the most and its two places so that the cause can be found (F33).
// The plane, the compositor and the host module are the modules of the page; the host answers each preparation with the page-wire case
// of the test (docs/spec/cases/page-wire/README.md).
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { selectPageWire } from "@soksak/runtime";
import { openVerifyPlane, rect } from "./support/verify-plane.mjs";

// The host module reads the wire when it is imported, so the case of the first test is selected before the page opens.
const firstWire = selectPageWire("verify-ahead-v7c-named");
const page = await openVerifyPlane();
after(() => page.close());
const { compositor, verify } = page;

/** Prepares the layout of the card with the seat of the surface "probe" and waits for the answer of the host. */
const prepare = ({ card, inset, bands, grid }) => {
  const cardId = page.card.dataset.cardId;
  return compositor.publishAhead(new Map([[cardId, card]]), new Map([[cardId, { id: "probe", dim: false, inset, bands, grid }]]), 40);
};

/** The V7c row of a plane whose card slot "probe" is drawn at 0,34 400×240 after the preparation, with the element that the drawing added. */
async function verifyAhead(wire, extra) {
  globalThis.devicePixelRatio = 1;
  page.measure(page.planeEl, rect(0, 0, 400, 300));
  page.measure(page.slot, rect(0, 34, 400, 240));
  page.mark();
  try {
    await prepare({ card: { x: 0, y: 0, w: 400, h: 300 }, inset: { left: 0, top: 34, width: 0, height: 60 }, grid: 1 });
    page.append(extra);
    return verify().find((item) => item.name.startsWith("V7c "));
  } finally {
    page.reset();
    wire.finish();
  }
}

test("a failed V7c names the surface and both of its rectangles", { timeout: 5000 }, async () => {
  globalThis.devicePixelRatio = 1;
  // The place and style of a drawn card and the device pixel ratio of the page are the measured values that the failure sentence states (F90).
  page.measure(page.planeEl, rect(6, 6, 400, 300));
  page.measure(page.slot, rect(36, 40, 370, 240));
  page.measure(page.card, rect(6, 6, 400, 300));
  page.card.style.width = "400px";
  page.card.style.height = "300px";
  page.card.style.setProperty("--pt", "36px");
  page.mark();
  try {
    await prepare({
      card: { x: 0, y: 0, w: 400, h: 300 }, inset: { left: 0, top: 34, width: 0, height: 60 },
      bands: { top: 6, bottom: 0, left: 0, right: 0 }, grid: 1,
    });
    const row = verify().find((item) => item.name.startsWith("V7c "));
    assert.equal(row.ok, false);
    assert.match(row.note, /최대 30\.00px/);
    assert.match(row.note, /probe drawn 30,34 370×240 declared 0,34 400×240 · bands 6\/0\/0\/0 drawn 36px\/0\/0\/0/);
    assert.match(row.note, / · card 0,0 400×300 inset 30,34,0,26 · plane 6,6 400×300 · card style 400px×300px · devicePixelRatio 1$/);
  } finally {
    page.reset();
  }
  firstWire.finish();
});

test("V7c compares the predicted card surfaces and does not count a section surface that the drawing added", { timeout: 5000 }, async () => {
  const wire = selectPageWire("verify-ahead-v7c-section");
  // A section surface is measured after the drawing (docs/spec/native-surfaces.md#section-seats), so the prediction never holds it.
  const row = await verifyAhead(wire, '<div class="set__body slot" data-native-surface="view" data-native-surface-id="spc-aaaaaa/left/probe.tree"></div>');
  assert.equal(row.ok, true, row.note);
});

test("a failed V7c names the drawn card surface that the prediction missed", { timeout: 5000 }, async () => {
  const wire = selectPageWire("verify-ahead-v7c-missed");
  const row = await verifyAhead(wire, '<article class="card" data-card-id="two"><div class="chrome"></div><div class="status"></div><div class="slot" data-native-surface data-native-surface-id="tab-late"></div></article>');
  assert.equal(row.ok, false);
  assert.match(row.note, /누락 1 \[tab-late\]/);
});

test("a failed V7b names the surface and its declared and applied rectangles", { timeout: 5000 }, async () => {
  const wire = selectPageWire("verify-ahead-v7b-named");
  // At 2 device pixels per point the host fits the declared rectangle inward to 10,45.5 380×199.5, so the applied height of 200
  // is off by half a point.
  globalThis.devicePixelRatio = 2;
  page.measure(page.planeEl, rect(6, 6, 400, 300));
  page.mark();
  try {
    await prepare({ card: { x: 0, y: 0, w: 400, h: 300 }, inset: { left: 10, top: 45.25, width: 20, height: 100 }, grid: 2 });
    const row = verify().find((item) => item.name.startsWith("V7b "));
    assert.equal(row.ok, false);
    assert.match(row.note, /probe declared 10,45\.25 380×200 applied 10,45\.5 380×200/);
  } finally {
    page.reset();
  }
  wire.finish();
});

test("V7b compares the applied rectangle with the declared rectangle fitted inward to the device pixels", { timeout: 5000 }, async () => {
  const wire = selectPageWire("verify-ahead-v7b-fitted");
  // A display of one device pixel per point cannot show half a point: the host fits a declared height of 580.5 to 580.
  globalThis.devicePixelRatio = 1;
  page.measure(page.planeEl, rect(6, 6, 2400, 700));
  page.mark();
  try {
    await prepare({ card: { x: 0, y: 0, w: 2400, h: 700 }, inset: { left: 203, top: 33, width: 77, height: 119.5 }, grid: 1 });
    const row = verify().find((item) => item.name.startsWith("V7b "));
    assert.equal(row.ok, true, row.note);
  } finally {
    page.reset();
  }
  wire.finish();
});
