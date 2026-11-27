import assert from "node:assert/strict";
import test from "node:test";
import { open } from "./support/debug-timeline.mjs";

test("a page without the list of the rejected files is refused", async () => {
  const { ui, wire, close } = await open("debug-timeline-ui-no-rejected-list");
  try {
    await assert.rejects(ui.showDebugTimeline(), /without rows, a tail and the rejected files/);
  } finally {
    await close();
  }
  wire.finish();
});
