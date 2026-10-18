import assert from "node:assert/strict";
import test from "node:test";

import { measure, parseFootprint, parseOptions } from "../measure-host-calls.mjs";

test("the measurement reads the footprint before the calls, after them and after a collection, and reports the growth per call", async () => {
  const entries = [];
  const steps = [];
  const sizes = [1000, 3000, 1200, 1100, 2100, 1400];
  // WebKit malloc is half of each footprint, so the growth per call is half of the footprint growth.
  await measure({
    status: async () => ({ pageProcess: 7 }),
    collect: async () => { steps.push("collect"); },
    calls: async (count) => { steps.push(`calls ${count}`); return { count, ms: 5 }; },
    footprint: (pid) => { steps.push(`footprint ${pid}`); const footprint = sizes.shift(); return { footprint, webkitMalloc: footprint / 2 }; },
    count: 60,
    rounds: 2,
    log: (entry) => entries.push(entry),
  });
  // A round sends 60 calls as one request of 50 and one of 10, so no request runs long enough to reach the page request timeout.
  assert.deepEqual(steps, ["collect", "footprint 7", "calls 50", "calls 10", "footprint 7", "collect", "footprint 7",
    "collect", "footprint 7", "calls 50", "calls 10", "footprint 7", "collect", "footprint 7"]);
  assert.deepEqual(entries.at(1), { round: 1, phase: "calls", pageProcess: 7, footprint: 3000, webkitMalloc: 1500, ms: 10 });
  assert.deepEqual(entries.at(-1), { calls: 60, rounds: 2, perCall: { beforeCollect: 13, afterCollect: 2 } });
});

test("a page that answers another count or changes its process fails the round", async () => {
  const base = { collect: async () => {}, footprint: () => ({ footprint: 1, webkitMalloc: 1 }), count: 3, rounds: 1, log: () => {} };
  await assert.rejects(measure({ ...base, status: async () => ({ pageProcess: 7 }), calls: async () => ({ count: 2, ms: 1 }) }),
    /round 1: the page answered \{"count":2,"ms":1\} for 3 calls/);
  let pid = 7;
  await assert.rejects(measure({ ...base, status: async () => ({ pageProcess: pid++ }), calls: async (count) => ({ count, ms: 1 }) }),
    /round 1: the page process changed from 7 during the round/);
  await assert.rejects(measure({ ...base, status: async () => ({ pageProcess: 0 }), calls: async (count) => ({ count, ms: 1 }) }),
    /round 1 base: the window has no page process \(0\)/);
});

test("footprint output and options are read strictly", () => {
  const output = "soksak [1]: 64-bit\tFootprint: 123456 B (16384 bytes per page)\n\n" +
    "\tDirty      Clean  Reclaimable    Regions    Category\n" +
    "\t   ---        ---          ---        ---    ---\n" +
    "\t 4096 B       0 B       8192 B         12    WebKit malloc\n";
  assert.deepEqual(parseFootprint(output), { footprint: 123456, webkitMalloc: 4096 });
  assert.throws(() => parseFootprint("no data"), /footprint reported no byte count/);
  assert.throws(() => parseFootprint("Footprint: 1 B"), /no WebKit malloc category/);
  assert.deepEqual(parseOptions(["--sok", "/s", "--config-dir", "/c"]), { calls: 1000, rounds: 5, sok: "/s", configDir: "/c" });
  assert.throws(() => parseOptions(["--sok", "/s"]), /required options/);
  assert.throws(() => parseOptions(["--sok", "/s", "--config-dir", "/c", "--calls", "0"]), /positive integer/);
});
