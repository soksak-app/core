import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { B3_MEASUREMENTS, B3_SETTINGS } from "../benchmark/measurements.mjs";
import { fixtureSettings } from "../benchmark/cases/b3-run.mjs";
import { assertSplitLoadWithinBound, hostRssKbOf, SPLIT_LOAD_GROWTH_BOUND_KB, splitLoadB3Values, STRESS_FIXTURE }
  from "../benchmark/cases/split-load.mjs";

const GOALS = JSON.parse(readFileSync(new URL("../../docs/spec/performance-goals.json", import.meta.url), "utf8"));

test("the split load limit is the bound of SPLIT_LOAD_GROWTH_BOUND_KB in the performance goals, and a growth at or above it fails the benchmark",
  { timeout: 5000 }, () => {
    const bound = GOALS.values.find((value) => value.constant === "SPLIT_LOAD_GROWTH_BOUND_KB").bound.below;
    assert.equal(SPLIT_LOAD_GROWTH_BOUND_KB, bound);
    assert.doesNotThrow(() => assertSplitLoadWithinBound(bound - 1));
    assert.throws(() => assertSplitLoadWithinBound(bound),
      new Error(`host RSS grew ${bound} KB during split/WebView stress; the bound is ${bound} KB`));
  });

// The rows of `ps -ax -o pid=,rss=,command=`: the host of a release bundle of the mygo application, its sidecar, a WebKit process and
// the host of another configuration folder.
const TABLE = [
  "  4242 51200 /Applications/soksak-mygo.app/Contents/MacOS/soksak-mygo --config-dir /tmp/b3/mygo",
  `  4243  9000 ${join("/tmp/b3/mygo", "sidecars", "alacritty", "bin", "alacritty")} --config-dir /tmp/b3/mygo`,
  "  4244 70000 /System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent",
  "  4245 61000 /Applications/soksak-wailsv3.app/Contents/MacOS/soksak-wailsv3 --config-dir /tmp/b3/wailsv3",
].join("\n");

test("the split load finds the host process by the --config-dir of the application", { timeout: 5000 }, () => {
  assert.equal(hostRssKbOf(TABLE, "/tmp/b3/mygo", "/tmp/b3/mygo"), 51200);
  assert.equal(hostRssKbOf(TABLE, "/tmp/b3/wailsv3", "/tmp/b3/wailsv3"), 61000);
  assert.throws(() => hostRssKbOf(TABLE, "/tmp/b3/tauriv2", "/tmp/b3/tauriv2"), new Error("no host process has --config-dir /tmp/b3/tauriv2"));
  assert.throws(() => hostRssKbOf("  4242 x /a --config-dir /tmp/b3/mygo", "/tmp/b3/mygo", "/tmp/b3/mygo"),
    new Error(`process row "  4242 x /a --config-dir /tmp/b3/mygo" has no pid and resident size`));
});

test("the B3 value of the split load is the growth of the host RSS in KB, the key that B3_MEASUREMENTS declares", { timeout: 5000 }, () => {
  assert.deepEqual(splitLoadB3Values([100, 300, 250]), { hostGrowthKb: 200 });
  assert.deepEqual(Object.keys(splitLoadB3Values([100, 300, 250])), B3_MEASUREMENTS["split-load"]);
});

test("the split load sets the performance trace off and the log policy of B3_SETTINGS itself, so SOKSAK_PERFORMANCE_TRACE does not reach it", { timeout: 5000 }, () => {
  assert.ok(Object.hasOwn(STRESS_FIXTURE, "performanceTrace"), "the fixture of the stress leaves the performance trace to fresh");
  assert.deepEqual(STRESS_FIXTURE, { performanceTrace: false, log: { call: "debug" }, reads: ["host.endpoint.call"] });
  assert.deepEqual(fixtureSettings(B3_SETTINGS["split-load"]), { performanceTrace: STRESS_FIXTURE.performanceTrace, log: STRESS_FIXTURE.log });
});

test("the host process is found by its configuration folder in every build profile", () => {
  const table = [
    "  10 100 /work/target/release/tauriv2/soksak.app/Contents/MacOS/soksak-tauriv2 --config-dir /work/other",
    "  11 200 /work/target/release/tauriv2/soksak.app/Contents/MacOS/soksak-tauriv2 --config-dir /work/check",
    "  12 300 /work/target/debug/soksak-wailsv3.app/Contents/MacOS/soksak-wailsv3 --config-dir /work/debug",
  ].join("\n");
  assert.equal(hostRssKbOf(table, "/work/check", "/work/check"), 200);
  assert.equal(hostRssKbOf(table, "/work/debug", "/work/debug"), 300);
  assert.throws(() => hostRssKbOf(table, "/work/absent", "/work/absent"), /no host process has --config-dir \/work\/absent/);
});
