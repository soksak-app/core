import assert from "node:assert/strict";
import test from "node:test";
import { PAGE_ROWS } from "../debug-timeline.js";
import { queriesOf, open, changed, names } from "./support/debug-timeline.mjs";

test("the filter asks the host for the newest page again with the members of the filter", async () => {
  const { ui, wire, close } = await open("debug-timeline-ui-filter");
  try {
    await ui.showDebugTimeline();
    await ui.filterDebugTimeline({ level: "warn" });
    assert.deepEqual(queriesOf(wire).at(-1), { channel: "other", level: "warn", order: "desc", limit: PAGE_ROWS });
    assert.deepEqual(names(), ["workbench.call.slow"]);
    await ui.filterDebugTimeline({ level: "trace", layer: "host", text: "WINDOW", from: "1970-01-01T00:00:00.000020Z", to: "1970-01-01T00:00:00.000020Z" });
    assert.deepEqual(queriesOf(wire).at(-1), { channel: "other", level: "trace", layer: "host", text: "WINDOW", from_us: 20, to_us: 20, order: "desc", limit: PAGE_ROWS });
    assert.deepEqual(names(), ["host.window.created"]);
    assert.equal(ui.debugState().timeline.layer, "host");
    assert.equal(ui.debugState().timeline.held, 1);
    await ui.filterDebugTimeline({ channel: "all", event_prefix: "host.window", class: "input", run: "r1", cid: "c1", surface: "s", session: "x", event: "" });
    assert.deepEqual(queriesOf(wire).at(-1), { channel: "all", level: "trace", layer: "host", text: "WINDOW", class: "input", event_prefix: "host.window", surface: "s", session: "x", cid: "c1", run: "r1", from_us: 20, to_us: 20, order: "desc", limit: PAGE_ROWS });
    await assert.rejects(async () => ui.filterDebugTimeline({}), /timeline filter needs channel, level, class, layer, text, event, event_prefix, surface, session, cid, run, from, to/);
    await assert.rejects(async () => ui.filterDebugTimeline({ colour: "red" }), /timeline filter has no member colour/);
    await assert.rejects(ui.filterDebugTimeline({ from: "yesterday" }), /log query from "yesterday" is not a UTC time like 2026-10-08T22:53:20\.123456Z/);
    assert.equal(ui.debugState().timeline.from, "1970-01-01T00:00:00.000020Z", "a refused filter changed the filter");
    assert.equal(ui.debugState().timeline.held, 0);
  } finally {
    await close();
  }
  wire.finish();
});
