// The CPU figures of the window benchmarks (e2e/benchmark/cases/process-cpu.mjs): the groups of the processes, the raster probe
// service and the report of an interval.
import assert from "node:assert/strict";
import test from "node:test";

import { cpuGroupOf, cpuLine, cpuReport, percentile, withRasterService } from "../benchmark/cases/process-cpu.mjs";

test("each process role belongs to one group and an unknown role is refused", { timeout: 5000 }, () => {
  assert.deepEqual(["host", "page w1", "document tab-1/page", "webkit webcontent", "sidecar sok-rasterprobe", "rasterprobe service",
    "webkit gpu", "webkit networking"].map(cpuGroupOf), ["host", "webContent", "webContent", "webContent", "sidecars", "sidecars",
    "webkitServices", "webkitServices"]);
  assert.throws(() => cpuGroupOf("window server"), /"window server" belongs to no CPU group/);
});

test("the raster probe service and its session children are added once", { timeout: 5000 }, () => {
  const listed = [{ role: "host", pid: 1, attribution: "config-dir argument" }, { role: "sidecar sok-rasterprobe", pid: 20, attribution: "executable path" }];
  assert.deepEqual(withRasterService(listed, null), listed);
  assert.deepEqual(withRasterService(listed, { service: 20, children: [21, 22] }).map(({ role, pid }) => [role, pid]),
    [["host", 1], ["sidecar sok-rasterprobe", 20], ["rasterprobe session 21", 21], ["rasterprobe session 22", 22]]);
});

test("the report sums each group over the interval and per action, and a missing process fails it", { timeout: 5000 }, () => {
  const rows = [{ role: "host", pid: 1 }, { role: "page w1", pid: 2 }, { role: "rasterprobe service", pid: 3 }, { role: "webkit gpu", pid: 4 }];
  const before = new Map([[1, 10], [2, 5], [3, 1], [4, 0]]);
  const after = new Map([[1, 11], [2, 5.5], [3, 1.25], [4, 0.25]]);
  const report = cpuReport({ rows, before, after, seconds: 2, actions: 100 });
  assert.deepEqual(report.groups.host, { cpuSeconds: 1, cpuPercent: 50, msPerAction: 10 });
  assert.deepEqual(report.groups.webContent, { cpuSeconds: 0.5, cpuPercent: 25, msPerAction: 5 });
  assert.deepEqual(report.groups.sidecars, { cpuSeconds: 0.25, cpuPercent: 12.5, msPerAction: 2.5 });
  assert.deepEqual(report.total, { cpuSeconds: 2, cpuPercent: 100, msPerAction: 20 });
  assert.match(cpuLine(report), /^100 actions in 2\.00 s; host 1\.000 s 50\.0% 10\.00 ms\/action;/);
  after.delete(3);
  assert.throws(() => cpuReport({ rows, before, after, seconds: 2, actions: 100 }), /rasterprobe service \(pid 3\): pid is not in the process table/);
  assert.throws(() => cpuReport({ rows, before, after, seconds: 0, actions: 1 }), /positive number of seconds/);
});

test("the report counts a process that holds the documents of several views once", { timeout: 5000 }, () => {
  // host.window lists each document with the process that draws it, and one WebContent process draws the documents of several views.
  const rows = [{ role: "host", pid: 1 }, { role: "document tab-1/", pid: 2 }, { role: "document tab-2/", pid: 2 }];
  const report = cpuReport({ rows, before: new Map([[1, 10], [2, 5]]), after: new Map([[1, 11], [2, 5.5]]), seconds: 2, actions: 100 });
  assert.deepEqual(report.groups.webContent, { cpuSeconds: 0.5, cpuPercent: 25, msPerAction: 5 });
  assert.deepEqual(report.total, { cpuSeconds: 1.5, cpuPercent: 75, msPerAction: 15 });
  assert.deepEqual(report.rows.map(({ role }) => role), ["host", "document tab-1/", "document tab-2/"]);
});

test("a percentile takes the nearest rank", { timeout: 5000 }, () => {
  assert.deepEqual([percentile([5, 1, 3, 2, 4], 50), percentile([5, 1, 3, 2, 4], 90), percentile([7], 90)], [3, 5, 7]);
  assert.throws(() => percentile([], 50), /no value/);
});
