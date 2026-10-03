import assert from "node:assert/strict";
import test from "node:test";

import { measure, parseFootprint, parseOptions } from "../measure-page-memory.mjs";

test("the measurement records start, idle and reloads of one page process", async () => {
  const entries = [];
  const calls = [];
  let clock = 0;
  await measure({
    status: async () => ({ pageProcess: 42 }),
    reload: async () => { calls.push("reload"); },
    footprint: (pid) => { calls.push(`footprint ${pid}`); return 1000 + calls.length; },
    wait: async (ms) => { calls.push(`wait ${ms}`); clock += ms; },
    idleMs: 60_000,
    reloads: 2,
    log: (entry) => entries.push(entry),
    now: () => clock,
  });
  assert.deepEqual(entries.map(({ phase, elapsedMs, pageProcess }) => [phase, elapsedMs, pageProcess]),
    [["start", 0, 42], ["idle", 60_000, 42], ["reloads", 60_000, 42]]);
  assert.deepEqual(calls, ["footprint 42", "wait 60000", "footprint 42", "reload", "reload", "footprint 42"]);
});

test("a reload that changes the page process fails the measurement", async () => {
  let pid = 1;
  await assert.rejects(measure({
    status: async () => ({ pageProcess: pid }),
    reload: async () => { pid = 2; },
    footprint: () => 1,
    wait: async () => {},
    idleMs: 0,
    reloads: 1,
    log: () => {},
  }), /changed the page process from 1 to 2/);
});

test("a window without a page process fails the measurement", async () => {
  await assert.rejects(measure({
    status: async () => ({ pageProcess: 0 }),
    reload: async () => {}, footprint: () => 1, wait: async () => {}, idleMs: 0, reloads: 0, log: () => {},
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
