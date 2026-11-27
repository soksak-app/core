import assert from "node:assert/strict";
import test from "node:test";
import { PAGE_ROWS } from "../debug-timeline.js";
import { queriesOf, open, rowsText } from "./support/debug-timeline.mjs";

test("a log of more rows than a page opens as one page and the older pages come in front of it", async () => {
  const { ui, wire, close } = await open("debug-timeline-ui-older");
  try {
    await ui.showDebugTimeline();
    assert.equal(rowsText().length, PAGE_ROWS, "the page drew more than a page");
    assert.match(rowsText().at(-1), /n=1299$/);
    assert.match(rowsText()[0], /n=800$/);
    assert.equal(ui.debugState().timeline.older, true);
    assert.equal(document.querySelector('[data-key="timeline-older"]').hidden, false);
    await ui.olderDebugTimeline();
    assert.equal(rowsText().length, 2 * PAGE_ROWS);
    assert.match(rowsText()[0], /n=300$/);
    assert.deepEqual(queriesOf(wire).at(-1).after, { ts_us: 900, role: "host", boot: "a", seq: 801 });
    assert.equal(queriesOf(wire).at(-1).order, "desc");
    await ui.olderDebugTimeline();
    assert.equal(rowsText().length, 1300);
    assert.equal(ui.debugState().timeline.older, false);
    const requests = queriesOf(wire).length;
    await ui.olderDebugTimeline();
    assert.equal(queriesOf(wire).length, requests, "a timeline without an older row asked again");
    assert.equal(document.querySelector('[data-key="timeline-older"]').hidden, true);
  } finally {
    await close();
  }
  wire.finish();
});
