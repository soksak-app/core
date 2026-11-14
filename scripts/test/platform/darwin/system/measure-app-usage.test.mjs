// The measurement of the CPU and the memory of the applications on the live tools of macOS: ps, launchctl, pgrep and footprint run for
// real, on a host process and a sidecar process of a configuration folder (fixtures/measure-app-usage/idle-process.mjs) and on a
// sok executable that follows its files (fixtures/measure-app-usage/sok.mjs). The owners of the judgements on recorded output are
// ../../../measure-app-usage.test.mjs and ../../../footprints.test.mjs.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { readFootprint } from "../../../../footprints.mjs";
import { applicationRows, attributeWebKit, measureApps, readCpuSeconds, windowApplicationRows } from "../../../../measure-app-usage.mjs";
import { execute } from "../../../../measure-tools.mjs";

const fixture = (name) => fileURLToPath(new URL(`../../../fixtures/measure-app-usage/${name}`, import.meta.url));
const IDLE = fixture("idle-process.mjs");
const SOK = fixture("sok.mjs");
// The files that the sok fixture answers with: the windows of the application and the host.window reply of its window w1.
const CONFIG_FILES = fixture("config-dir");

/**
 * The application of a disposable configuration folder: a host process whose command line has --config-dir <folder>, a sidecar process
 * whose executable is under <folder>/sidecars, and the files that the sok fixture answers with (CONFIG_FILES). The processes end with the test.
 */
function application(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "measure-usage-system-")));
  const configDir = join(root, "soksak-check-mygo");
  const host = join(root, "sok-mygo.app", "Contents", "MacOS", "soksak");
  const sidecar = join(configDir, "sidecars", "probe", "bin", "probe");
  for (const folder of [dirname(host), dirname(sidecar)]) mkdirSync(folder, { recursive: true });
  symlinkSync(process.execPath, host);
  symlinkSync("/bin/sleep", sidecar);
  cpSync(CONFIG_FILES, configDir, { recursive: true });
  const children = [spawn(host, [IDLE, "--config-dir", configDir], { stdio: "ignore" }), spawn(sidecar, ["600"], { stdio: "ignore" })];
  t.after(() => {
    for (const child of children) child.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  });
  return { configDir, host: children[0].pid, sidecar: children[1].pid };
}

test("a command that runs resolves to its status and output, and a command that does not start resolves to its error", async () => {
  const missing = await execute("/bin/ls", ["/var/tester/no-such-folder"]);
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout, "");
  assert.match(missing.stderr, /No such file or directory/);
  assert.equal(missing.error, undefined);
  const present = await execute("/bin/ls", [dirname(SOK)]);
  assert.deepEqual([present.status, present.stderr], [0, ""]);
  assert.match(present.stdout, /sok\.mjs/);
  const absent = await execute("/var/tester/no-such-command", []);
  assert.equal(absent.error.code, "ENOENT");
});

test("ps lists the cpu seconds of this process, and footprint reads its footprint and its peak", async () => {
  const cpu = await readCpuSeconds();
  assert.ok(cpu.get(process.pid) > 0, "the process of the test has used cpu time");
  const { bytes, peakBytes } = await readFootprint(process.pid);
  assert.ok(bytes > 0 && peakBytes >= bytes, `footprint ${bytes} B, peak ${peakBytes} B`);
  // The error names the command and its exit status and carries the output of footprint, whose wording differs between macOS versions.
  await assert.rejects(readFootprint(2_000_000_000), /^Error: footprint -p 2000000000 exited with 66: footprint: \S/);
});

test("launchctl lists the launchd domain of a process without a WebKit service, and refuses the domain of pid 0 with the folder in the error", async () => {
  assert.deepEqual(await attributeWebKit([{ configDir: "/var/tester/a", pid: process.pid }]), { attributed: [], errors: [] });
  assert.deepEqual(await attributeWebKit([{ configDir: "/var/tester/a", pid: 0 }]), {
    attributed: [],
    errors: ["webkit services of /var/tester/a: launchctl print pid/0 exited with 112: Bad request.\nCould not find domain for pid: 0"],
  });
});

test("the processes of an application are its host and its sidecar, and the windows add the rows of host.window", async (t) => {
  const { configDir, host, sidecar } = application(t);
  assert.deepEqual(await applicationRows({ configDir }), [
    { role: "host", pid: host, attribution: "config-dir argument" },
    { role: "sidecar probe", pid: sidecar, attribution: "executable path" },
  ]);
  const statuses = [{ window: "w1", pageProcess: host, documents: [] }];
  assert.deepEqual(await windowApplicationRows({ configDir, statuses }), {
    rows: [
      { role: "host", pid: host, attribution: "config-dir argument" },
      { role: "sidecar probe", pid: sidecar, attribution: "executable path" },
      { role: "page w1", pid: host, attribution: "host.window" },
    ],
    errors: [],
  });
  await assert.rejects(applicationRows({ configDir: join(configDir, "..") }), /no host process has --config-dir/);
});

test("measureApps reads the footprints, the marks around the counts and the cpu interval, and the cpu seconds of an application", { timeout: 60000 }, async (t) => {
  const { configDir, host, sidecar } = application(t);
  const order = [];
  const result = await measureApps({
    sok: SOK, configDirs: [configDir], interval: 1, footprints: "at-once",
    marks: { before: async () => { order.push("before"); return "marks before"; }, after: async () => { order.push("after"); return "marks after"; } },
    beforeCpu: async () => { order.push("counts written"); },
    span: async () => { order.push("interval"); },
    afterCpu: async () => { order.push("records read"); },
  });
  assert.deepEqual(order, ["before", "counts written", "interval", "records read", "after"]);
  // The WebKit services of the other applications of the machine are unattributed rows whose end is no error of this application.
  assert.deepEqual(result.errors.filter((error) => error.startsWith(configDir)), []);
  const [app] = result.apps;
  assert.deepEqual(app.windows, ["w1"]);
  assert.deepEqual(app.rows.map(({ role, pid }) => [role, pid]), [["host", host], ["sidecar probe", sidecar]]);
  for (const row of app.rows) {
    assert.ok(row.bytes > 0 && row.peakBytes >= row.bytes, `${row.role}: ${row.bytes} B, peak ${row.peakBytes} B`);
    assert.ok(row.cpuSeconds >= 0 && row.cpuPercent >= 0, `${row.role}: ${row.cpuSeconds} s`);
  }
  assert.deepEqual(result.marks, { before: "marks before", after: "marks after" });
  assert.ok(result.seconds > 0);
  assert.equal(app.totals.sidecars.bytes, app.rows[1].bytes);
  assert.equal(app.totals.application.bytes, app.rows[0].bytes);
});
