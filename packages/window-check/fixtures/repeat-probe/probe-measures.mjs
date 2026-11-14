// The check that the repeat check runs: one passing test that reports a measurement.
import test from "node:test";

test("probe measures", (t) => { t.diagnostic("measured 5ms"); });
