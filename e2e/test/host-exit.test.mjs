// An application whose host process exited fails one check with the exit and the last records of its log, and every later check
// of that application is reported as not run because of that exit; the check never starts the application again, which would hide
// the exit.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { open } from "@soksak/window-check/app.mjs";
import { exitEvidence } from "@soksak/window-check/host-exit.mjs";

delete process.env.SOKSAK_APP;

/** A configuration folder whose endpoint.json names a host process that is gone, with the log that the process wrote. */
function exitedHost(t) {
  const configDir = mkdtempSync(join(tmpdir(), "soksak-exited-host-"));
  t.after(() => rmSync(configDir, { recursive: true, force: true }));
  const { pid } = spawnSync(process.execPath, ["-e", ""]);
  writeFileSync(join(configDir, "endpoint.json"), JSON.stringify({ address: join(configDir, "sok.sock"), pid, transport: "unix" }));
  mkdirSync(join(configDir, "logs"));
  const record = (seq, level, event, fields) => JSON.stringify({ ts_us: 1794212561708833 + seq, seq, level, class: "lifecycle", layer: "host", event, fields });
  writeFileSync(join(configDir, "logs", `host-1794212313-${pid}.jsonl`), [
    record(5403, "info", "workbench.start", { url: "wails://localhost/" }),
    record(5404, "info", "log.closed", { cause: "update" }),
    record(5413, "info", "log.closed", { cause: "exit-request" }),
    record(5416, "info", "log.closed", { cause: "last-window-closed" }),
    record(5417, "error", "host.record.error", { text: "the main webview is not in the window hierarchy", where: "main webview identity" }),
    record(5418, "info", "log.gated", { class: "lifecycle", level: "info", count: 6 }),
  ].join("\n") + "\n");
  return { app: { name: "wailsv3", binary: process.execPath, configDir }, pid };
}

test("the first check of an application whose process exited fails with the exit and the last records of its log", async (t) => {
  const { app, pid } = exitedHost(t);
  const skipped = [];
  await assert.rejects(open({ name: "the first check", skip: (reason) => skipped.push(reason) }, app), (error) => {
    assert.match(error.message, new RegExp(`^wailsv3 process ${pid} exited before the check "the first check", so nothing was measured`));
    assert.match(error.message, /seq 5404 log\.closed cause update; seq 5413 log\.closed cause exit-request; seq 5416 log\.closed cause last-window-closed; seq 5417 host\.record\.error the main webview is not in the window hierarchy \(main webview identity\)/);
    assert.doesNotMatch(error.message, /workbench\.start|log\.gated/);
    return true;
  });
  assert.deepEqual(skipped, []);
  const record = JSON.parse(readFileSync(join(app.configDir, "exited.json"), "utf8"));
  assert.equal(record.check, "the first check");
  assert.equal(record.pid, pid);
});

test("every later check of an application whose process exited is reported as not run because of that exit", async (t) => {
  const { app, pid } = exitedHost(t);
  await assert.rejects(open({ name: "the first check", skip() {} }, app));
  const skipped = [];
  await assert.rejects(open({ name: "a later check", skip: (reason) => skipped.push(reason) }, app), (error) => {
    assert.equal(error.message, skipped[0]);
    return true;
  });
  assert.equal(skipped.length, 1);
  assert.match(skipped[0], new RegExp(`^not run: wailsv3 process ${pid} exited, found by the check "the first check"; `));
  assert.match(skipped[0], /seq 5417 host\.record\.error the main webview is not in the window hierarchy/);
  assert.equal(existsSync(join(app.configDir, "exited.json")), true);
});

/** A folder of the system reports with one report of header and body. */
function reportFolder(t, name, header, body) {
  const folder = mkdtempSync(join(tmpdir(), "soksak-reports-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  writeFileSync(join(folder, name), `${JSON.stringify(header)}\n${JSON.stringify(body, null, 2)}`);
  return folder;
}

/** A configuration folder whose host log of process pid holds only the records of its start, so the log tells no exit. */
function silentHost(t, pid) {
  const configDir = mkdtempSync(join(tmpdir(), "soksak-exited-host-"));
  t.after(() => rmSync(configDir, { recursive: true, force: true }));
  mkdirSync(join(configDir, "logs"));
  const boot = Math.floor(Date.now() / 1000) - 60;
  const log = join(configDir, "logs", `host-${boot}-${pid}.jsonl`);
  writeFileSync(log, `${JSON.stringify({ seq: 1, level: "info", event: "workbench.start", fields: {} })}\n`);
  return { configDir, log };
}

const memory = () => "memory pressure warning, swap total = 2048.00M  used = 1500.00M  free = 548.00M";

test("the exit names the source of the exit request that its log holds", (t) => {
  const { configDir, log } = silentHost(t, 4242);
  writeFileSync(log, `${JSON.stringify({ seq: 9, level: "info", event: "log.closed",
    fields: { cause: "exit-request", source: "apple-event", sender_pid: 77, sender: "com.apple.dt.Xcode" } })}\n`, { flag: "a" });
  const text = exitEvidence(configDir, 4242, { reports: [], memory });
  assert.match(text, /seq 9 log\.closed cause exit-request source apple-event sender_pid 77 sender com\.apple\.dt\.Xcode/);
  assert.doesNotMatch(text, /no exit request/);
});

test("the exit names the crash output of the host when it is not empty", (t) => {
  const { configDir, log } = silentHost(t, 4242);
  writeFileSync(log.replace(/\.jsonl$/, ".crash"), "");
  writeFileSync(log.replace(/\.jsonl$/, ".stderr"), "fatal error: concurrent map writes\n");
  const text = exitEvidence(configDir, 4242, { reports: [], memory });
  assert.match(text, /the crash output .*\.stderr: fatal error: concurrent map writes/);
  assert.doesNotMatch(text, /\.crash:|no exit request/);
});

test("the exit names the crash report of the system for the process of the host", (t) => {
  const { configDir } = silentHost(t, 4242);
  const reports = reportFolder(t, "soksak-check-wailsv3-2026-11-09-172241.ips",
    { app_name: "soksak-check-wailsv3", timestamp: "2026-11-09 17:22:41.00 +0900" }, { pid: 4242 });
  const other = reportFolder(t, "soksak-check-wailsv3-2026-11-09-172242.ips",
    { app_name: "soksak-check-wailsv3", timestamp: "2026-11-09 17:22:42.00 +0900" }, { pid: 4343 });
  const text = exitEvidence(configDir, 4242, { reports: [other, reports], memory });
  assert.match(text, /the crash report .*soksak-check-wailsv3-2026-11-09-172241\.ips of soksak-check-wailsv3 at 2026-11-09 17:22:41\.00 \+0900/);
  assert.doesNotMatch(text, /172242|no exit request/);
});

test("the exit names a jetsam kill of the process with its reason and the largest processes", (t) => {
  const { configDir } = silentHost(t, 4242);
  const reports = reportFolder(t, "JetsamEvent-2026-11-09-172241.ips", { bug_type: "298", timestamp: "2026-11-09 17:22:41.00 +0900" }, {
    memoryStatus: { pageSize: 16384 },
    largestProcess: "Xcode",
    processes: [
      { pid: 10, name: "Xcode", rpages: 262144 },
      { pid: 4242, name: "soksak-check-wailsv3", rpages: 65536, reason: "vm-pageshortage" },
      { pid: 11, name: "WindowServer", rpages: 131072 },
    ],
  });
  const text = exitEvidence(configDir, 4242, { reports: [reports], memory });
  assert.match(text, /the jetsam report .*JetsamEvent-2026-11-09-172241\.ips killed it for vm-pageshortage; the largest processes: Xcode 10 4096 MB, WindowServer 11 2048 MB, soksak-check-wailsv3 4242 1024 MB/);
  assert.doesNotMatch(text, /no exit request/);
});

test("an exit with no exit request, no crash output and no crash report names the memory of the machine", (t) => {
  const { configDir, log } = silentHost(t, 4242);
  writeFileSync(log.replace(/\.jsonl$/, ".crash"), "");
  const reports = reportFolder(t, "JetsamEvent-2026-11-09-172241.ips", { bug_type: "298" },
    { memoryStatus: { pageSize: 16384 }, processes: [{ pid: 10, name: "Xcode", rpages: 1, reason: "per-process-limit" }] });
  const text = exitEvidence(configDir, 4242, { reports: [reports], memory });
  assert.match(text, /it ended with no exit request, no crash output and no crash report, as a SIGKILL or a jetsam kill does; memory pressure warning, swap total = 2048\.00M {2}used = 1500\.00M {2}free = 548\.00M when the exit was found/);
});
