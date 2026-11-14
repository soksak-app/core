// Verification V10 judges the containment of the native surfaces that are visible. The plane, the compositor and the host module are
// the modules of the page; the host answers each preparation with the page-wire case of the test (docs/spec/cases/page-wire/README.md).
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { selectPageWire } from "@soksak/runtime";
import { openVerifyPlane } from "./support/verify-plane.mjs";

// The host module reads the wire when it is imported, so the case of the test is selected before the page opens.
const wire = selectPageWire("verify-fullscreen-hidden-retained");
const page = await openVerifyPlane();
after(() => page.close());
const { compositor, verify } = page;

test("containment checks visible surfaces while hidden surfaces retain their native frame", { timeout: 5000 }, async () => {
  // A page always has a device pixel ratio; verify fits the declared surfaces with it.
  globalThis.devicePixelRatio = 1;
  page.mark();
  const cardId = page.card.dataset.cardId;
  const prepare = (size) => compositor.publishAhead(new Map([[cardId, { x: 0, y: 0, w: size, h: size }]]),
    new Map([[cardId, { id: "probe", dim: false, inset: { left: 0, top: 0, width: 0, height: 0 }, grid: 1 }]]), 40);
  try {
    // The host retains the native frame of a hidden surface at its last place, so the hidden surface lies outside the card.
    await prepare(100);
    assert.equal(verify().find(row=>row.name.startsWith('V10 ')).skipped,true,'an invisible retained frame is reported as drawn outside its hidden card');
    // The host shows the surface at the frame that it retained, outside the card.
    await prepare(120);
    assert.equal(verify().find(row=>row.name.startsWith('V10 ')).ok,false,'a visible escaping frame must fail');
  } finally {
    page.reset();
  }
  wire.finish();
});
