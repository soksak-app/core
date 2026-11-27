import assert from "node:assert/strict";
import test from "node:test";
import { HOLD_LIMIT } from "../debug-timeline.js";
import { open, changed, rowsText } from "./support/debug-timeline.mjs";

test("the rows beyond the hold limit leave the view from the old end and are counted", async () => {
  const { ui, wire, close } = await open("debug-timeline-ui-follow-hold-limit");
  try {
    await ui.showDebugTimeline();
    await changed(wire);
    const status = ui.debugState().timeline;
    assert.equal(status.held, HOLD_LIMIT);
    assert.equal(status.omitted, 3);
    assert.equal(status.older, true);
    assert.equal(status.appended, HOLD_LIMIT);
    assert.match(rowsText().at(-1), new RegExp(`n=${HOLD_LIMIT - 1}$`));
    assert.match(rowsText()[0], /n=0$/);
    const label = document.querySelector('[data-expose="core.debug.timeline.omitted"]');
    assert.equal(label.hidden, false);
    assert.match(label.textContent, /앞쪽 3행은 보관하지 않음/);
    assert.equal(document.querySelector('[data-key="timeline-older"]').hidden, false);
  } finally {
    await close();
  }
  wire.finish();
});
