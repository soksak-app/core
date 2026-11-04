import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { heapTotals, measure, parseOptions, prepare } from "../measure-host-allocations.mjs";

test("the totals are the nodes and bytes of the line of all zones, and output without it is an error", () => {
  assert.deepEqual(heapTotals("Process 7: 9 zones\nAll zones: 77466 nodes malloced - Sizes: 32[1]\nAll zones: 77466 nodes (18570120 bytes)\n"),
    { nodes: 77466, bytes: 18570120 });
  assert.throws(() => heapTotals("heap: no such process"), /heap printed no line "All zones: N nodes \(B bytes\)": heap: no such process/);
});

test("the measurement records the start and each minute with the totals of the process", async () => {
  const entries = [];
  let clock = 0;
  let calls = 0;
  await measure({
    pid: 7, minutes: 2,
    totals: () => ({ nodes: ++calls, bytes: calls * 10 }),
    wait: async (ms) => { clock += ms; },
    log: (entry) => entries.push(entry),
    now: () => clock,
  });
  assert.deepEqual(entries, [
    { phase: "start", elapsedMs: 0, pid: 7, nodes: 1, bytes: 10 },
    { phase: "minute 1", elapsedMs: 60000, pid: 7, nodes: 2, bytes: 20 },
    { phase: "minute 2", elapsedMs: 120000, pid: 7, nodes: 3, bytes: 30 },
  ]);
});

test("the options name the application by its configuration folder and sok, and take the trace state", () => {
  assert.deepEqual(parseOptions(["--sok", "/s", "--config-dir", "/c", "--trace", "1"]), { sok: "/s", configDir: "/c", trace: 1, minutes: 10 });
  assert.equal(parseOptions(["--sok", "/s", "--config-dir", "/c", "--trace", "0", "--minutes", "3"]).minutes, 3);
  assert.throws(() => parseOptions(["--sok", "/s", "--config-dir", "/c"]), /TRACE must be 0 or 1, not set/);
  assert.throws(() => parseOptions(["--sok", "/s", "--config-dir", "/c", "--trace", "2"]), /TRACE must be 0 or 1, not "2"/);
  assert.throws(() => parseOptions(["--config-dir", "/c", "--trace", "0"]), /required options: --sok PATH --config-dir DIR/);
  assert.throws(() => parseOptions(["--sok", "/s", "--config-dir", "/c", "--trace", "0", "--minutes", "0"]), /--minutes must be a positive integer/);
  assert.throws(() => parseOptions(["--pid", "7", "--trace", "0"]), /Unknown option '--pid'/);
});

test("the host is the process of the release bundle of the mygo host that has the --config-dir of the application, and the trace state is set", async (t) => {
  const configDir = mkdtempSync(join(tmpdir(), "host-allocations-"));
  t.after(() => rmSync(configDir, { recursive: true, force: true }));
  const processes = [
    { pid: 10, command: `node scripts/measure-host-allocations.mjs --sok /s --config-dir ${configDir} --trace 1` },
    { pid: 11, command: `/app/target/release/mygo/soksak.app/Contents/MacOS/soksak-mygo --config-dir ${configDir}` },
    { pid: 12, command: `${configDir}/sidecars/pty/0.0.1/pty --config-dir ${configDir}` },
    { pid: 13, command: "/app/target/release/wailsv3/soksak.app/Contents/MacOS/soksak-wailsv3 --config-dir /other" },
  ];
  const calls = [];
  const run = async (command, params) => {
    calls.push([command, params.key]);
    if (params.key === "diagnostics.log") {
      const classes = { lifecycle: "error", input: "error", call: "error", io: "error", frame: "error", ...params.value };
      setTimeout(() => writeFileSync(join(configDir, "log-policy.json"), JSON.stringify({ schema: 1, classes })), 20);
    }
    return null;
  };
  assert.equal(await prepare({ processes, configDir, realPath: configDir, run, trace: 1 }), 11);
  assert.deepEqual(calls, [["core.settings.change", "diagnostics.log"], ["core.settings.change", "diagnostics.performance"]]);
  await assert.rejects(prepare({ processes: processes.filter(({ pid }) => pid !== 11), configDir, realPath: configDir, run, trace: 1 }),
    new RegExp(`no host process has --config-dir ${configDir}`));
  assert.equal(calls.length, 2, "the trace state was set for an application without a host process");
});
