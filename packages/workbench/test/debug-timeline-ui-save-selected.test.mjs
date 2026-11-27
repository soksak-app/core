import assert from "node:assert/strict";
import test from "node:test";
import { savesOf, open } from "./support/debug-timeline.mjs";

test("the selected rows are saved in timeline order as one text, also those that the filter hides", async () => {
  const { ui, wire, close } = await open("debug-timeline-ui-save-selected");
  try {
    await ui.showDebugTimeline();
    ui.selectDebugRow(2, true);
    ui.selectDebugRow(1, true);
    await ui.filterDebugTimeline({ level: "warn" });
    assert.deepEqual(await ui.saveDebugRows(), { saved: "/chosen/timeline.txt" });
    const saves = savesOf(wire);
    assert.equal(saves.length, 1);
    assert.match(saves[0].name, /^soksak-timeline-\d{8}T\d{6}Z\.txt$/);
    assert.deepEqual(saves[0].text.split("\n"), [
      "1970-01-01T00:00:00.000020Z debug host host.window.created window=w1",
      '1970-01-01T00:00:00.000030Z warn workbench workbench.call.slow name="windows.list"',
      "",
    ]);
    assert.deepEqual(ui.debugState().operation, { action: "save-rows", path: saves[0].name, state: "done" });
  } finally {
    await close();
  }
  wire.finish();
});
