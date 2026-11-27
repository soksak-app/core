import assert from "node:assert/strict";
import test from "node:test";
import { open } from "./support/debug-timeline.mjs";

test("every interactive element of the timeline points to a declared command and has an element name", async () => {
  const { ui, wire, close } = await open("debug-timeline-ui-controls");
  try {
    await ui.showDebugTimeline();
    const controls = [...document.querySelectorAll(".dbg-card button, .dbg-card input, .dbg-card select")];
    for (const el of controls) {
      assert.ok(el.dataset.command, `${el.outerHTML} has no command`);
      assert.ok(el.dataset.expose, `${el.outerHTML} has no element name`);
    }
    assert.equal(document.querySelector('[data-expose="core.debug.timeline.older"]').dataset.command, "core.debug.timeline.older");
    const filters = [...document.querySelectorAll(".dbg-card__timeline [data-set]")];
    assert.deepEqual(filters.map((el) => el.dataset.set).toSorted(), ["channel", "cid", "class", "event", "event_prefix", "from", "layer", "level", "run", "session", "surface", "text", "to"]);
    for (const el of filters) {
      assert.equal(el.dataset.command, "core.debug.timeline.filter");
      assert.equal(el.dataset.value, el.dataset.set);
      assert.equal(el.dataset.expose, `core.debug.timeline.${el.dataset.set.replace("_", "-")}`);
    }
  } finally {
    await close();
  }
  wire.finish();
});
