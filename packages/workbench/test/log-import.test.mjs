// Checks the start of the page log (docs/spec/logging.md#writers): the page imports its modules, and its first flush sends the clock
// statement of the document and the start event of the workbench in one log batch. The host answers the calls of the page from the
// case log-import (docs/spec/cases/page-wire/README.md). The view-calls tests select the same case before they import the page.
import assert from "node:assert/strict";
import { test } from "node:test";
import { selectPageWire } from "@soksak/runtime";

// The page reads the host when it is imported, so the case is selected before the import.
const wire = selectPageWire("log-import");
const { flushEvents, recordWorkbenchStart } = await import("../page-log.js");
recordWorkbenchStart({ href: "http://soksak.test/index.html" }, 0);
await flushEvents();

test("the first flush reads the clock of the host and sends the clock statement and the start event in one log batch", () => {
  const batches = wire.calls.filter(({ name, payload }) => name === "log" && payload.action === "batch");
  assert.deepEqual(batches.flatMap(({ payload }) => payload.events.map((event) => event.event)), ["workbench.log.clock", "workbench.start"]);
  wire.finish();
});
