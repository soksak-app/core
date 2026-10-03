import assert from "node:assert/strict";
import test from "node:test";

import { measure, parseFootprint, parseOptions } from "../measure-page-memory.mjs";

test("the measurement records start, idle and reloads and whether the starting page process remains", async () => {
  const entries = [];
  const calls = [];
  let clock = 0;
  await measure({
    status: async () => ({ pageProcess: 42 + calls.filter((call) => call === "reload").length }),
    reload: async () => { calls.push("reload"); },
    alive: (pid) => { calls.push(`alive ${pid}`); return false; },
    footprint: (pid) => { calls.push(`footprint ${pid}`); return 1000 + calls.length; },
    wait: async (ms) => { calls.push(`wait ${ms}`); clock += ms; },
    idleMs: 60_000,
    reloads: 2,
    log: (entry) => entries.push(entry),
    now: () => clock,
  });
  assert.deepEqual(entries.map(({ phase, elapsedMs, pageProcess, startProcessAlive }) => [phase, elapsedMs, pageProcess, startProcessAlive]),
    [["start", 0, 42, undefined], ["idle", 60_000, 42, undefined], ["reloads", 60_000, 44, false]]);
  assert.deepEqual(calls, ["footprint 42", "wait 60000", "footprint 42", "reload", "reload", "footprint 44", "alive 42"]);
});

test("a window without a page process fails the measurement", async () => {
  await assert.rejects(measure({
    status: async () => ({ pageProcess: 0 }),
    reload: async () => {}, footprint: () => 1, alive: () => true, wait: async () => {}, idleMs: 0, reloads: 0, log: () => {},
  }), /start: the window has no page process \(0\)/);
});

test("footprint output and options are read strictly", () => {
  assert.equal(parseFootprint("soksak [1]: 64-bit\tFootprint: 123456 B (16384 bytes per page)"), 123456);
  assert.throws(() => parseFootprint("no data"), /footprint reported no byte count/);
  assert.deepEqual(parseOptions(["--sok", "/s", "--config-dir", "/c"]), { idleMinutes: 60, reloads: 20, sok: "/s", configDir: "/c" });
  assert.deepEqual(parseOptions(["--sok", "/s", "--config-dir", "/c", "--idle-minutes", "0", "--reloads", "3"]),
    { idleMinutes: 0, reloads: 3, sok: "/s", configDir: "/c" });
  assert.throws(() => parseOptions(["--sok", "/s"]), /required options/);
  assert.throws(() => parseOptions(["--sok", "/s", "--config-dir", "/c", "--reloads", "-1"]), /non-negative integer/);
  assert.throws(() => parseOptions(["--other", "x"]), /unknown option/);
});
