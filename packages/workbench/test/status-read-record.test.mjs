// The record of a status read that names a surface (docs/spec/logging.md#classes-and-policy, the event workbench.status.read): the
// page stores the surface that the request named, the surface that answers it and the owned session that the answering surface shows.
import assert from "node:assert/strict";
import test from "node:test";
import { host, selectPageWire } from "@soksak/runtime";

// The case selects the host of the page before the registry and the page log are imported, because the page reads the host when it is imported.
const wire = selectPageWire("exposure-status-read-record");
const pageHost = host;
const { createRegistry } = await import("../exposure.js");
const { flushEvents } = await import("../page-log.js");
const { logGate } = await import("../log-gate.js");

test("a status read that names a surface records the requested surface, the resolved surface and the session", { timeout: 10000 }, async () => {
  const made = createRegistry({ call: pageHost.call, report: (error) => { throw error; } });
  made.declare("probe", { status: [{ name: "probe.lines", description: "Lines.", schema: { type: "array" } }], commands: [], element: [] });
  made.configure({ surfacePlugin: (surface) => (surface === "tab-b" ? "probe" : null), sessionOf: (surface) => (surface === "tab-b" ? "s7" : null) });
  made.registered({ surface: "tab-b", kind: "status", name: "probe.lines" });
  logGate.set({ lifecycle: "error", input: "error", call: "debug", io: "error", frame: "error" });
  try {
    assert.deepEqual(await made.handle({ method: "status.get", params: { name: "probe.lines", surface: "tab-b" } }), { result: { screen: "tab-b" } });
    await flushEvents();
  } finally {
    logGate.set({ lifecycle: "error", input: "error", call: "error", io: "error", frame: "error" });
  }
  const recorded = wire.calls
    .filter(({ name, payload }) => name === "log" && payload.action === "batch")
    .flatMap(({ payload }) => payload.events)
    .filter(({ event }) => event === "workbench.status.read");
  assert.equal(recorded.length, 1, `the status read was not recorded once: ${JSON.stringify(recorded)}`);
  const { micros, ...fields } = recorded[0].fields;
  assert.equal(recorded[0].level, "debug");
  assert.equal(typeof micros, "number");
  assert.deepEqual(fields, { name: "probe.lines", requested: "tab-b", resolved: "tab-b", session: "s7", ok: true, code: null });
  wire.finish();
});
