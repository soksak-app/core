// A placement places the state of its commit: the start values of its views are read with its candidates, before the
// readiness wait, so an operation during the wait that closes a tab does not end an origin that the placement still reads
// (docs/spec/projects.md#tab-origin).
import assert from "node:assert/strict";
import test from "node:test";
import { memoryPlacement } from "../memory-placement.js";
import { forgetTabsLeft, recordOrigin, tabOrigin } from "../tab-reports.js";

test("a placement keeps the start values of its commit when a tab leaves its layout during the readiness wait", { timeout: 1000 }, async () => {
  recordOrigin("tab-left", null, "new tab");
  let resolveReady;
  const ready = new Promise((resolve) => { resolveReady = resolve; });
  const saver = { place: (surfaces) => ({ surfaces, retain: new Set(surfaces.map(({ id }) => id)), unload: [] }) };
  const placing = memoryPlacement({ drawn: true, surfaces: [] }, [{ id: "tab-left", plugin: "probe" }], {
    ready, saver, observe: () => {},
    start: (candidates) => candidates.map((entry) => ({ ...entry, start: { origin: tabOrigin(entry.id) } })),
  });
  // The tab closes during the wait, and the stored layout without it ends its origin.
  forgetTabsLeft([{ data: { tabs: [{ id: "tab-left" }] } }], [], "drawn layout of space spc-a, project prj-a");
  resolveReady();
  const { surfaces } = await placing;
  assert.deepEqual(surfaces.map(({ start }) => start), [{ origin: { directory: null } }]);
});

// A hidden section keeps its slot, so its seat stands in the record of a commit after the memory saver unloaded it, and a request of
// the host must hold every surface of its record (docs/spec/plugins.md#sections).
test("a placement takes the seat of an unloaded surface out of its record", { timeout: 1000 }, async () => {
  const seat = { id: "spc-a/left/probe.marks", plugin: "probe" };
  const shown = { id: "tab-a", plugin: "probe" };
  const record = { drawn: true, surfaces: [shown, seat] };
  const saver = { place: (surfaces) => ({ surfaces: surfaces.filter(({ id }) => id !== seat.id), retain: new Set(surfaces.map(({ id }) => id)), unload: [seat.id] }) };
  const { surfaces } = await memoryPlacement(record, [shown, seat], { ready: Promise.resolve(), saver, observe: () => {}, start: (entries) => entries });
  assert.deepEqual(surfaces, [shown]);
  assert.deepEqual(record.surfaces, [shown]);
});
