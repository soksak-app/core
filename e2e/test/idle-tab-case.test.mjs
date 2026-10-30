import assert from "node:assert/strict";
import test from "node:test";

import { assertIdleTabWithinBound, IDLE_TAB_BOUND_KB, settledDocumentsOf } from "../benchmark/cases/idle-tab.mjs";

test("the idle tab limit is 50 MB, and a measured cost above it fails the benchmark", { timeout: 5000 }, () => {
  assert.equal(IDLE_TAB_BOUND_KB, 50 * 1024);
  const measurement = { settled: 29040, mainBefore: 1000, mainAfter: 1000 + 24768, growth: 24768 };
  assert.doesNotThrow(() => assertIdleTabWithinBound({ ...measurement, cost: 51200 }));
  assert.throws(() => assertIdleTabWithinBound({ ...measurement, cost: 51201 }),
    /the idle tab costs 51201 KB: documents 29040 KB plus main web view growth 24768 KB is over 51200 KB/);
});

test("the documents of a tab are counted once each footprint is settled", { timeout: 5000 }, () => {
  const match = (fields) => fields.role === "document";
  const settled = settledDocumentsOf("the documents of tab", match)([
    { role: "document", document: "a", footprint_kb: 20000 },
    { role: "document", document: "a", footprint_kb: 20100 },
    { role: "document", document: "b", footprint_kb: 9000 },
    { role: "document", document: "b", footprint_kb: 9050 },
    { role: "page", document: "c", footprint_kb: 1 },
  ]);
  assert.equal(settled.value, 20100 + 9050);
  const unsettled = settledDocumentsOf("the documents of tab", match)([
    { role: "document", document: "a", footprint_kb: 20000 },
    { role: "document", document: "a", footprint_kb: 30000 },
  ]);
  assert.equal(unsettled.value, undefined);
});
