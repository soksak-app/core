// Red test of the watch of core.parties (docs/spec/parties.md#host-calls, docs/spec/parties.md#queries). The page-wire case
// party-watch-composition (docs/spec/cases/page-wire) records the order of the exposureChanged calls for core.parties: the current value
// at the watch, then one value for each composition change. The party module and the party commands do not exist yet, so the test fails
// on the unchanged implementation at its first import.
import assert from "node:assert/strict";
import test from "node:test";
import { selectPageWire } from "@soksak/runtime";
import { drained } from "./support/drained.mjs";
import { openPartyWindow } from "./support/party-window.mjs";

test("a watch of core.parties sends the current value and one value per composition change, and touching parties get different colors", { timeout: 10000 }, async () => {
  const wire = selectPageWire("party-watch-composition");
  const window = await openPartyWindow();
  try {
    await window.reset();
    // The host sends the watch and each command as exposure-request notices, which the page answers with exposureReply.
    wire.deliverNotice();
    await drained();
    wire.deliverNotice();
    await drained();
    wire.deliverNotice();
    await drained();
    wire.finish();
    const changes = wire.calls.filter((call) => call.name === "exposureChanged");
    assert.equal(changes.length, 3, "the watch sends the current value, then one value per composition change");
    const [first, second] = changes[2].payload.value;
    assert.notEqual(first.color, second.color, "the default colors of touching parties differ");
  } finally {
    window.close();
  }
});
