// The cause of a reload of the page (docs/spec/native-host.md#page-reload): a reload ends every view of the window with the caller
// documents-reloaded, so the page records the operation that reloads it as workbench.page.reload and refuses a reload without a cause.
import assert from "node:assert/strict";
import { test } from "node:test";
import { selectPageWire } from "@soksak/runtime";

test("a reload of the page records its cause as workbench.page.reload and a reload without a cause is refused", async () => {
  // The case selects the host of the page before the host module and the page log are imported, because the page reads the host when it is imported.
  const wire = selectPageWire("page-reload-cause");
  const { logGate } = await import("../log-gate.js");
  logGate.set({ lifecycle: "info", input: "error", call: "error", io: "error", frame: "error" });
  const { flushEvents } = await import("../page-log.js");
  const { recordPageReload } = await import("../host.js");
  assert.throws(() => recordPageReload(""), /a page reload needs its cause, not ""/);
  recordPageReload("core.plugins.apply");
  await flushEvents();
  const recorded = wire.calls
    .filter(({ name, payload }) => name === "log" && payload.action === "batch")
    .flatMap(({ payload }) => payload.events)
    .filter(({ event }) => event === "workbench.page.reload");
  assert.deepEqual(recorded.map(({ level, event, fields }) => ({ level, event, fields })), [{ level: "info", event: "workbench.page.reload", fields: { cause: "core.plugins.apply" } }]);
  wire.finish();
});
