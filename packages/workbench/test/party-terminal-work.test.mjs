// Red test of the watch of core.parties against the work of a terminal (docs/spec/parties.md#queries, docs/spec/parties.md#host-calls).
// The page-wire case party-terminal-work (docs/spec/cases/page-wire) holds the order: the watch of core.parties, a watch of the status
// probe-plain.busy of the surface tab-a, a composition change, the change of probe-plain.busy by the surface, and the next composition change. The
// change of probe-plain.busy reaches the page through registry.changed, the entry that a surface value uses (exposure.js), which sends
// exposureChanged synchronously. The wait before each check is drained(), which runs after the microtask queue is empty; the work of
// this path is microtask-only, so no timer or I/O is pending. The party module does not exist yet, so the test fails on the unchanged
// implementation at its first import.
import assert from "node:assert/strict";
import test from "node:test";
import { selectPageWire } from "@soksak/runtime";
import { drained } from "./support/drained.mjs";
import { openPartyWindow } from "./support/party-window.mjs";

test("a terminal work change sends no exposureChanged for core.parties until the next composition change", { timeout: 10000 }, async () => {
  const wire = selectPageWire("party-terminal-work");
  const window = await openPartyWindow();
  try {
    await window.reset();
    window.registry.registered({ surface: "tab-a", kind: "status", name: "probe-plain.busy" });
    wire.deliverNotice();
    await drained();
    wire.deliverNotice();
    await drained();
    wire.deliverNotice();
    await drained();
    window.registry.changed({ surface: "tab-a", name: "probe-plain.busy", value: true, version: 1 });
    await drained();
    wire.deliverNotice();
    await drained();
    wire.finish();
    const calls = wire.calls;
    const busy = calls.findIndex((call) => call.name === "exposureChanged" && call.payload.name === "probe-plain.busy" && call.payload.value === true);
    assert.notEqual(busy, -1, "the work change is sent as exposureChanged of probe-plain.busy");
    const next = calls.slice(busy + 1).find((call) => call.name === "exposureChanged" && call.payload.name === "core.parties");
    assert.equal(next.payload.value.length, 2, "the first core.parties value after the work change is the next composition change");
  } finally {
    window.close();
  }
});
