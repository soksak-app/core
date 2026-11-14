import assert from "node:assert/strict";
import test from "node:test";

import { instant, remainingMs } from "../measure-tools.mjs";

test("the wait that is left is the wait of the rule less the time since it began, and 0 when it is over", () => {
  assert.equal(remainingMs({ since: 1000, now: 1000, ms: 3000 }), 3000);
  assert.equal(remainingMs({ since: 1000, now: 3500, ms: 3000 }), 500);
  assert.equal(remainingMs({ since: 1000, now: 4000, ms: 3000 }), 0);
  assert.equal(remainingMs({ since: 1000, now: 9000, ms: 3000 }), 0);
  assert.equal(remainingMs({ since: 0.5, now: 1.25, ms: 2 }), 1.25);
  assert.equal(remainingMs({ since: 5, now: 5, ms: 0 }), 0);
});

test("an instant that is not a number, a negative wait and an instant before the start of the wait are errors", () => {
  assert.throws(() => remainingMs({ since: "1", now: 2, ms: 3 }), /remainingMs needs a number of milliseconds for since, not "1"/);
  assert.throws(() => remainingMs({ since: 1, now: NaN, ms: 3 }), /remainingMs needs a number of milliseconds for now, not null/);
  assert.throws(() => remainingMs({ since: 1, now: 2 }), /remainingMs needs a number of milliseconds for ms, not undefined/);
  assert.throws(() => remainingMs({ since: 1, now: 2, ms: -1 }), /remainingMs needs a wait of at least 0 ms, not -1/);
  assert.throws(() => remainingMs({ since: 5, now: 4, ms: 1 }), /the instant 4 ms is before the instant 5 ms that the wait began/);
});

test("the instants of the clock of the measurements do not decrease", () => {
  const first = instant();
  assert.ok(instant() >= first);
});
