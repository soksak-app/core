// The replies of modal documents that the host relays (docs/spec/native-host.md): a reply of a modal that the page does not
// show, or that has no receiver, is dropped and recorded as `workbench.overlay.dropped`, never dropped without a record.
import assert from "node:assert/strict";
import { test } from "node:test";
import { selectPageWire } from "@soksak/runtime";

test("a reply of a modal that the page does not show is recorded as workbench.overlay.dropped", async () => {
  // The case selects the host of the page before the host module and the page log are imported, because the page reads the host when it is imported.
  const wire = selectPageWire("overlay-pick-dropped");
  const { logGate } = await import("../log-gate.js");
  // The event is stored at the level info, so it reaches the host in the batch of the page.
  logGate.set({ lifecycle: "error", input: "info", call: "error", io: "error", frame: "error" });
  const { flushEvents } = await import("../page-log.js");
  await import("../host.js");
  wire.deliverNotice();
  await flushEvents();
  const recorded = wire.calls
    .filter(({ name, payload }) => name === "log" && payload.action === "batch")
    .flatMap(({ payload }) => payload.events)
    .filter(({ event }) => event.startsWith("workbench.overlay."));
  assert.deepEqual(recorded.map(({ level, event, fields }) => ({ level, event, fields })), [{ level: "info", event: "workbench.overlay.dropped", fields: { id: "debug", shown: "", key: "save-all" } }]);
  wire.finish();
});
