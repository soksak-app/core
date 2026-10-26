import assert from "node:assert/strict";
import test from "node:test";

import { cleanupPluginHostFixture, reducePluginHostRafMeasurement } from "../benchmark/cases/plugin-host-throttle.mjs";

const sample = (frames, performanceNow, timeOrigin = 1000) => ({ frames, performanceNow, timeOrigin });
const sampler = (seq, monoNs, pid = 701) => ({
  event: {
    event: "host.sampler.memory",
    seq,
    mono_ns: monoNs,
    fields: { role: "plugin-host", plugin: "probehostraf", window: "main", pid, rss_kb: 10, footprint_kb: 12 },
  },
});

test("plugin-host RAF measurement records a valid zero-callback result without a rate threshold", { timeout: 1000 }, () => {
  const result = reducePluginHostRafMeasurement({
    plugin: "probehostraf", window: "main", start: sample(4, 100), end: sample(4, 5100),
    samplerRows: [sampler(10, 10_000_000), sampler(11, 15_000_000)],
  });

  assert.deepEqual(result, {
    plugin: "probehostraf", window: "main", pid: 701, timeOrigin: 1000, callbacks: 0,
    elapsedMs: 5000, framesPerSecond: 0,
    sampler: [
      { seq: 10, monoNs: 10_000_000, pid: 701, rssKB: 10, footprintKB: 12 },
      { seq: 11, monoNs: 15_000_000, pid: 701, rssKB: 10, footprintKB: 12 },
    ],
  });
});

test("plugin-host RAF measurement rejects invalid frame counts and page-clock values", { timeout: 1000 }, () => {
  const samplerRows = [sampler(10, 10_000_000), sampler(11, 15_000_000)];
  const measure = (start, end) => reducePluginHostRafMeasurement({
    plugin: "probehostraf", window: "main", start, end, samplerRows,
  });

  assert.throws(() => measure(sample(-1, 100), sample(0, 200)), /start\.frames must be a nonnegative safe integer/);
  assert.throws(() => measure(sample(0, 100), sample(1, Number.POSITIVE_INFINITY)), /end\.performanceNow must be finite and nonnegative/);
  assert.throws(() => measure(sample(0, -1), sample(1, 200)), /start\.performanceNow must be finite and nonnegative/);
  assert.throws(() => measure(sample(0, 100, 0), sample(1, 200, 1000)), /start\.timeOrigin must be finite and positive/);
  assert.throws(() => measure(sample(0, 100, Number.POSITIVE_INFINITY), sample(1, 200)), /start\.timeOrigin must be finite and positive/);
});

test("plugin-host RAF measurement reports the observed rate from one page clock", { timeout: 1000 }, () => {
  const result = reducePluginHostRafMeasurement({
    plugin: "probehostraf", window: "main", start: sample(25, 200), end: sample(75, 5200),
    samplerRows: [sampler(20, 20_000_000), sampler(21, 25_000_000)],
  });

  assert.equal(result.callbacks, 50);
  assert.equal(result.elapsedMs, 5000);
  assert.equal(result.framesPerSecond, 10);
  assert.equal(result.timeOrigin, 1000);
});

test("plugin-host RAF measurement rejects samples from different page origins", { timeout: 1000 }, () => {
  assert.throws(() => reducePluginHostRafMeasurement({
    plugin: "probehostraf", window: "main",
    start: sample(25, 200, 1000), end: sample(75, 5200, 2000),
    samplerRows: [sampler(20, 20_000_000), sampler(21, 25_000_000)],
  }), /page clock origin changed: 1000 to 2000/);
});

test("plugin-host RAF measurement rejects a changed WebContent process", { timeout: 1000 }, () => {
  assert.throws(() => reducePluginHostRafMeasurement({
    plugin: "probehostraf", window: "main", start: sample(1, 100), end: sample(2, 200),
    samplerRows: [sampler(10, 10_000_000, 701), sampler(11, 15_000_000, 702)],
  }), /plugin-host process changed/);
});

test("plugin-host RAF measurement reports sampler errors for the requested host", { timeout: 1000 }, () => {
  const failed = sampler(10, 10_000_000);
  failed.event.fields = { role: "plugin-host", plugin: "probehostraf", window: "main", error: "process unavailable" };
  assert.throws(() => reducePluginHostRafMeasurement({
    plugin: "probehostraf", window: "main", start: sample(1, 100), end: sample(2, 200),
    samplerRows: [failed, sampler(11, 15_000_000)],
  }), /plugin-host sampler failed.*process unavailable/);
});

test("plugin-host RAF measurement rejects a malformed error beside valid PID and memory fields", { timeout: 1000 }, () => {
  const malformed = sampler(10, 10_000_000);
  malformed.event.fields.error = 5;
  assert.throws(() => reducePluginHostRafMeasurement({
    plugin: "probehostraf", window: "main", start: sample(1, 100), end: sample(2, 200),
    samplerRows: [malformed, sampler(11, 15_000_000)],
  }), /plugin-host sampler error for probehostraf in main must be nonempty text/);
});

test("plugin-host RAF measurement reports window-facts errors before missing plugin rows", { timeout: 1000 }, () => {
  const windowFailure = {
    event: {
      event: "host.sampler.memory", seq: 10, mono_ns: 10_000_000,
      fields: { role: "page", window: "main", error: "window facts unavailable" },
    },
  };
  assert.throws(() => reducePluginHostRafMeasurement({
    plugin: "probehostraf", window: "main", start: sample(1, 100), end: sample(2, 200),
    samplerRows: [windowFailure],
  }), /window facts failed for plugin host probehostraf in main: window facts unavailable/);
});

test("plugin-host cleanup restores the registry after earlier cleanup failures and retains its directory", { timeout: 1000 }, async () => {
  const attempts = [];
  let state = { registry: "fixture-index", plugins: [{ id: "probehostraf", installed: true }] };
  let directoryRemoved = false;
  await assert.rejects(cleanupPluginHostFixture({
    ensureWindow: async () => { attempts.push("window"); throw new Error("window readiness failed"); },
    readState: async () => { attempts.push("read"); return state; },
    plugin: "probehostraf",
    previousRegistry: "previous-index",
    removePlugin: async () => { attempts.push("remove"); state = { ...state, plugins: [{ id: "probehostraf", installed: false }] }; throw new Error("plugin removal reply failed"); },
    restoreRegistry: async (index) => { attempts.push(`restore:${index}`); state = { ...state, registry: index }; },
    removeDirectory: async () => { attempts.push("delete"); directoryRemoved = true; },
    directory: "/tmp/probe-registry",
  }), (error) => {
    assert.ok(error instanceof AggregateError, "cleanup failures were not aggregated");
    assert.match(error.message, /cleanup failed/);
    assert.deepEqual(error.errors.map((entry) => entry.message), [
      "window readiness failed",
      "plugin removal reply failed",
      "retained temporary registry directory /tmp/probe-registry; cleanup state is unconfirmed",
    ]);
    return true;
  });
  assert.ok(attempts.includes("restore:previous-index"), "registry restoration was skipped after an earlier cleanup failure");
  assert.equal(directoryRemoved, false, "the temporary registry directory was removed before cleanup was confirmed");
});

test("plugin-host cleanup retains its directory when registry restoration cannot be confirmed", { timeout: 1000 }, async () => {
  let directoryRemoved = false;
  await assert.rejects(cleanupPluginHostFixture({
    ensureWindow: async () => {},
    readState: async () => ({ registry: "fixture-index", plugins: [{ id: "probehostraf", installed: false }] }),
    plugin: "probehostraf",
    previousRegistry: "previous-index",
    removePlugin: async () => {},
    restoreRegistry: async () => { throw new Error("registry restore failed"); },
    removeDirectory: async () => { directoryRemoved = true; },
    directory: "/tmp/probe-registry",
  }), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.ok(error.errors.some((entry) => entry.message === "registry restore failed"));
    assert.ok(error.errors.some((entry) => entry.message.includes("retained temporary registry directory")));
    return true;
  });
  assert.equal(directoryRemoved, false, "the temporary registry directory was removed after an unconfirmed restore");
});

test("plugin-host cleanup retains its directory when failed removal leaves the fixture installed", { timeout: 1000 }, async () => {
  const attempts = [];
  let directoryRemoved = false;
  await assert.rejects(cleanupPluginHostFixture({
    ensureWindow: async () => {},
    readState: async () => ({ registry: attempts.includes("restored") ? "previous-index" : "fixture-index",
      plugins: attempts.includes("restored") ? [] : [{ id: "probehostraf", installed: true }] }),
    plugin: "probehostraf",
    previousRegistry: "previous-index",
    removePlugin: async () => { attempts.push("remove"); throw new Error("plugin removal failed"); },
    restoreRegistry: async () => { attempts.push("restored"); },
    removeDirectory: async () => { directoryRemoved = true; },
    directory: "/tmp/probe-registry",
  }), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.ok(error.errors.some((entry) => entry.message === "plugin removal failed"));
    assert.ok(error.errors.some((entry) => entry.message.includes("retained temporary registry directory")));
    return true;
  });
  assert.deepEqual(attempts, ["remove", "restored"]);
  assert.equal(directoryRemoved, false, "the fixture registry was deleted while its plugin remained installed");
});
