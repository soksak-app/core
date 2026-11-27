import assert from "node:assert/strict";
import test from "node:test";
import { open, shownText, shownWhere, names } from "./support/debug-timeline.mjs";

test("a file that the query rejected is shown through the error display beside the rows of the other files", async () => {
  const { ui, wire, close } = await open("debug-timeline-ui-rejected-file");
  try {
    await ui.showDebugTimeline();
    assert.deepEqual(names(), ["log.open", "host.window.created", "workbench.call.slow"]);
    assert.equal(shownWhere(), "debug");
    assert.equal(shownText(), "rejected: logs/files-old.jsonl: schema 2 is not 3");
    assert.equal(ui.debugState().error, null, "a rejected file is no failed step");
    await assert.rejects(ui.filterDebugTimeline({ level: "loud" }));
    assert.match(shownText(), /^filter: log query level "loud"/);
    assert.match(shownText(), /\nrejected: logs\/files-old\.jsonl: schema 2 is not 3$/);
  } finally {
    await close();
  }
  wire.finish();
});
