// When a request is still pending at STALL_AFTER, the check keeps the stacks of the host process at that time (F69).
// What the main thread did while it did not answer can be seen only at that moment. The record ends no request. The decisions of
// this file are functions of data: the instants of a request, the outcome of a sample, and the texts of the tools that the stall
// record reads. The live tools (/usr/bin/sample, lsof, launchctl) are exercised by test/platform/darwin/system/stall-sample.test.mjs.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { connect } from "@soksak/client";
import { startCasePlayer } from "@soksak/client/testing";
import { playClient } from "../fixtures/endpoint-player.mjs";
import { announceStall, flockedFile, flockFields, flockHolder, launchdServicesOf, launchdServicesOfResult, openRegularFiles, plannedLength, probedLocks, runProcess,
  sampleCommand, stallDeadline, stallDue, waitsInFlock, webContentProcesses } from "../stall-sample.mjs";

const { Session, stallLine } = await import("../app.mjs");

// The texts of the tools that the stall record reads, each recorded from the tool on processes of the fixture programs of this
// package (the folder of a recording is named /tmp/record): `lsof -n -P -F pcftn`, the lock probe of stall-sample.mjs,
// `launchctl print pid/<host>` (its services block) and /usr/bin/sample.
const tool = (name) => readFileSync(fileURLToPath(new URL(`../fixtures/stall-tools/${name}`, import.meta.url)), "utf8");

test("the stall deadline and the stall line are functions of the instants and the outcome that they receive", () => {
  // The sample starts `after` (STALL_AFTER by default) after the planned length of the request, from the instant that it started.
  assert.equal(stallDeadline(0, 0), 3000);
  assert.equal(stallDeadline(1000, 1440), 5440);
  assert.equal(stallDeadline(1000, 1440, 0), 2440);
  assert.equal(stallLine("probe", 0, 3000, { error: new Error("sample: no such process") }),
    "probe still pending after 3000 ms; sampling the host failed: sample: no such process");
  assert.equal(stallLine("mygo diagnostics.drag", 1440, 3000, { text: "stacks" }),
    "mygo diagnostics.drag still pending 3000 ms after its planned 1440 ms; the host's threads at that moment: stacks");
  assert.equal(stallDue({ started: 0, planned: 0, pending: true, at: 2999 }), false);
  assert.equal(stallDue({ started: 0, planned: 0, pending: true, at: 3000 }), true);
  // An answered request is never sampled, at any instant.
  assert.equal(stallDue({ started: 0, planned: 0, pending: false, at: 1e9 }), false);
});

test("a request of a session has no time limit and takes no options", async (t) => {
  const configDir = mkdtempSync(join(tmpdir(), "soksak-stall-config-"));
  t.after(() => rmSync(configDir, { recursive: true }));
  const server = await startCasePlayer("window-check-open-idle");
  t.after(() => server.close());
  const client = await connect({ configDir: server.configDir });
  t.after(() => client.close());
  const s = new Session({ name: "tauriv2", configDir }, client);
  assert.throws(() => s.request("status.get", { name: "core.verify" }, { timeout: 10 }), {
    name: "TypeError", message: "request status.get takes no options: a request ends by its answer or the close of the connection",
  });
  assert.throws(() => s.run("core.verify", {}, undefined, { timeout: 10 }), {
    name: "TypeError", message: "run core.verify takes no options: a command ends by its answer or the close of the connection",
  });
});

test("a process ended at its limit is named with the signal, the limit, its standard error and the state of the system", async () => {
  const ended = async (script) => (await runProcess("/bin/sh", ["-c", script], { limitMs: 200 })).error.message;
  assert.match(await ended("echo held >&2; exec sleep 5"),
    /^ended by SIGTERM at its limit of 200 ms; standard error: held; at the limit: free \d+ MB on \/, load \d+\.\d$/);
  assert.match(await ended("exec sleep 5"),
    /^ended by SIGTERM at its limit of 200 ms; standard error: none; at the limit: free \d+ MB on \/, load \d+\.\d$/);
});

test("a process ended by a signal of another sender is not reported as ended at its limit", async () => {
  const { error } = await runProcess("/bin/sh", ["-c", "echo held >&2; kill -KILL $$"], { limitMs: 5000 });
  assert.match(error.message, /^ended by SIGKILL; standard error: held$/);
});

test("the state at the limit is read while the process still runs", async () => {
  let running = false;
  const atLimit = async (pid) => {
    process.kill(pid, 0);
    running = true;
    return `state of ${pid}`;
  };
  const { error } = await runProcess("/bin/sh", ["-c", "exec sleep 5"], { limitMs: 100, atLimit });
  assert.equal(running, true, "the process had ended before its state was read");
  assert.match(error.message, /^ended by SIGTERM at its limit of 100 ms; standard error: none; at the limit: state of \d+$/);
});

test("a state at the limit that does not finish does not hold the end of the process", { timeout: 5000 }, async () => {
  const { error } = await runProcess("/bin/sh", ["-c", "exec sleep 5"], { limitMs: 100, atLimit: () => new Promise(() => {}), stateLimitMs: 100 });
  assert.equal(error.message, "ended by SIGTERM at its limit of 100 ms; standard error: none; at the limit: not read within 100 ms");
});

test("a process at its limit with no state reader is reported without a state", { timeout: 5000 }, async () => {
  const { error } = await runProcess("/bin/sh", ["-c", "exec sleep 5"], { limitMs: 100, atLimit: null });
  assert.equal(error.message, "ended by SIGTERM at its limit of 100 ms; standard error: none");
});

// A binary without symbols, as /bin/sleep, makes sample look for its dSYM with a Spotlight query, which mds answers and tccd
// attributes; on a loaded machine its first reply came after 0.4 to 2 s instead of 0.04 s, and a sample of one second did not
// reach "Sampling completed" within 5 s (the unified log of the window runs of 2026-11-11). A sample that denies those services
// to the tool waits for no such answer, so the command denies both.
test("the command of a stall sample denies the services of the symbol lookup of Spotlight, which a loaded machine answers late", () => {
  const [command, args] = sampleCommand(4321, 2, "/x/stall.txt");
  assert.equal(command, "/usr/bin/sandbox-exec");
  assert.equal(args[0], "-p");
  for (const service of ["com.apple.metadata.mds", "com.apple.coresymbolicationd"]) {
    assert.match(args[1], new RegExp(`\\(deny mach-lookup \\(global-name [^)]*"${service.replaceAll(".", "\\.")}"`));
  }
  assert.deepEqual(args.slice(2), ["/usr/bin/sample", "4321", "2", "-file", "/x/stall.txt"]);
});

test("the page processes of a host are the running WebContent services of its launchd domain", () => {
  // The services block of `launchctl print pid/<host>` of an application that runs a page: the running WebContent service, a running
  // GPU service, a running service of the application, and the services that do not run (pid 0).
  const services = launchdServicesOf(tool("launchctl-services.txt"));
  assert.deepEqual(services.map(({ pid }) => pid), [1648, 1413, 12478, 1635]);
  assert.deepEqual(webContentProcesses(services), [1648]);
  assert.deepEqual(launchdServicesOf(""), []);
});

test("the path of the dump of the host is stored as an event, and its position and the running host calls of the window are named", async (t) => {
  const { client } = await playClient(t, "window-check-stall-dump", "mygo");
  const text = await announceStall((method, params) => client.request(method, params), "main",
    ["/x/logs/stall-10-7.txt", "page 12 not sampled: gone", "/x/logs/stall-10-7-page-13.txt"]);
  assert.equal(text, "host.stall.dump at b1:9; running host calls of main: wait_presented 3.5s, surface_focus 2.5s");
});

test("a dump reply without the running calls of the window is named as a broken reply", async (t) => {
  const { client } = await playClient(t, "window-check-stall-dump-no-running", "mygo");
  const text = await announceStall((method, params) => client.request(method, params), "main", ["/x/logs/stall-10-7.txt"]);
  assert.equal(text, "host.stall.dump at b1:9; the reply names no running host calls: {\"boot\":\"b1\",\"seq\":9}");
});

test("a host that refuses the dump event is named in the message instead of hiding it", async (t) => {
  const { client } = await playClient(t, "window-check-stall-dump-refused", "mygo");
  const text = await announceStall((method, params) => client.request(method, params), "main", ["/x"]);
  assert.equal(text, "host.stall.dump not stored: path does not name a file: /x");
});

test("a host whose connection ends before it answers the dump event is named in the message", async (t) => {
  const { client } = await playClient(t, "window-check-stall-dump-closed", "mygo");
  const text = await announceStall((method, params) => client.request(method, params), "main", ["/x/logs/stall-10-7.txt"]);
  assert.equal(text, "host.stall.dump not stored: endpoint connection closed");
});

test("the dump event takes no limit", async (t) => {
  const { client } = await playClient(t, "window-check-open-idle", "mygo");
  await assert.rejects(announceStall((method, params) => client.request(method, params), "main", ["/x/logs/stall-10-7.txt"], 10),
    /^TypeError: announceStall takes no limit/);
});

test("the planned length of a request is the length of its drag or the wait of its stop, and none for any other", () => {
  assert.equal(plannedLength("diagnostics.drag", { axis: "x", line: 2, dx: -250, dy: 0, ms: 48, times: 15 }), 1440);
  assert.equal(plannedLength("diagnostics.capture.stop", { after: 5100 }, 5000), 100);
  assert.equal(plannedLength("diagnostics.capture.stop", { after: 4000 }, 5000), 0);
  assert.equal(plannedLength("diagnostics.capture.stop", { after: 5100 }, undefined), 0);
  assert.equal(plannedLength("diagnostics.capture.stop", {}, 5000), 0);
  assert.equal(plannedLength("diagnostics.drag", { ms: 48 }), 0);
  assert.equal(plannedLength("status.get", { name: "core.verify" }, 5000), 0);
});

test("a drag being measured is not sampled before 3 s after the end of its planned length", () => {
  const planned = plannedLength("diagnostics.drag", { axis: "x", line: 2, dx: -250, dy: 0, ms: 48, times: 15 });
  assert.equal(stallDue({ started: 0, planned, pending: true, at: 4439 }), false);
  assert.equal(stallDue({ started: 0, planned, pending: true, at: 4440 }), true);
});

// The lsof output of the waiter of a lock of flock, the lock probe over its regular files and the lsof output of that file, recorded
// from the fixture programs flock-holder.pl (process 63341, holds the lock) and flock-waiter.pl (process 63342, waits for it).
const WAITER = 63342;
const SHADERS = "/tmp/record/shaders.data";

test("a page process that waits in flock names the file it waits for and the process that holds its lock", () => {
  assert.equal(waitsInFlock(tool("sample-flock-waiter.txt")), true);
  const paths = openRegularFiles(WAITER, tool("lsof-waiter.txt"));
  assert.deepEqual(paths, [SHADERS]);
  const wait = flockedFile(WAITER, paths, tool("lock-probe-waiter.txt"));
  assert.deepEqual(wait, { file: SHADERS });
  const holder = flockHolder(WAITER, wait.file, tool("lsof-file-holder-waiter.txt"));
  assert.deepEqual(holder, { file: SHADERS, holder: { pid: 63341, command: "perl" } });
  assert.equal(flockFields(holder), `; flock.file=${SHADERS}; flock.holder=63341 perl`);
});

test("a flock wait whose holder cannot be identified names why in the record", () => {
  // The recording of a second waiter has three processes with the file open: the holder and both waiters.
  assert.equal(flockFields(flockHolder(WAITER, SHADERS, tool("lsof-file-holder-two-waiters.txt"))),
    `; flock.file=${SHADERS}; flock.holder.error=one of the processes that have the file open holds it: 63341 perl, 63403 perl`);
  // A waiter without a holder is alone with the file open.
  assert.equal(flockFields(flockHolder(63432, "/tmp/record/alone.data", tool("lsof-file-alone.txt"))),
    "; flock.file=/tmp/record/alone.data; flock.holder.error=no other process of this user has /tmp/record/alone.data open");
  // A process that has the file open twice may hold the lock on one description and wait on the other.
  assert.equal(flockFields(flockHolder(63440, "/tmp/record/reopen.data", tool("lsof-file-reopened.txt"))),
    "; flock.file=/tmp/record/reopen.data; flock.holder=63440 perl");
});

test("a flock wait whose file cannot be identified names why in the record", () => {
  const fileError = (pid, paths, probe) => flockFields(flockedFile(pid, paths, tool(probe)));
  // The process of the recording has no regular file open on a numbered descriptor.
  assert.deepEqual(openRegularFiles(63462, tool("lsof-no-regular-file.txt")), []);
  assert.equal(flockFields(flockedFile(63462, [], "")), "; flock.file.error=process 63462 has no regular file open");
  assert.equal(fileError(WAITER, ["/tmp/record/plain-a.data", "/tmp/record/plain-b.data"], "lock-probe-none.txt"),
    `; flock.file.error=no file that process ${WAITER} has open holds a lock of flock`);
  assert.equal(fileError(WAITER, ["/tmp/record/held-a.data", "/tmp/record/held-b.data"], "lock-probe-two-flocked.txt"),
    `; flock.file.error=2 files that process ${WAITER} has open hold a lock of flock: /tmp/record/held-a.data, /tmp/record/held-b.data`);
  assert.equal(fileError(WAITER, ["/tmp/record/held-c.data", "/tmp/record/denied.data"], "lock-probe-unreadable.txt"),
    "; flock.file.error=the lock of /tmp/record/denied.data not read: Permission denied");
});

test("a lock probe that does not answer every file in its order is refused", () => {
  assert.throws(() => probedLocks(["/tmp/record/held-c.data", "/tmp/record/denied.data"], tool("lock-probe-one-flocked.txt")),
    /^Error: the lock probe answered 1 of 2 files$/);
  assert.throws(() => probedLocks(["/tmp/record/denied.data"], tool("lock-probe-one-flocked.txt")),
    /^Error: the lock probe answered "locked\\t-1\\t\/tmp\/record\/held-c\.data" for \/tmp\/record\/denied\.data$/);
});

test("a sample that waits in no flock has no flock fields in its record, and one without its section cannot be read", () => {
  assert.equal(waitsInFlock(tool("sample-idle.txt")), false);
  assert.equal(flockFields(null), "");
  assert.throws(() => waitsInFlock(tool("sample-header-only.txt")), /^Error: the sample has no section "Sort by top of stack, same collapsed"$/);
});

// The process results of `launchctl print pid/<host>` as the tool gave them: the domain of an application with WebKit services, the domain of a
// process without one, and the refusal for pid 0 (status 112); each file holds the command, its status, its output and its error output.
const launchctl = (name) => JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url)), "utf8"));

test("the services of a launchd domain are read from the result of launchctl print, and a refusal is an error that names the process", () => {
  const all = launchctl("launchctl-print-all-services");
  assert.deepEqual(launchdServicesOfResult(all.pid, all).map(({ pid }) => pid), [1648, 1413, 12478, 1635]);
  const host = launchctl("launchctl-print-host");
  assert.deepEqual(launchdServicesOfResult(host.pid, host), [], "a domain without a service lists none");
  const refused = launchctl("launchctl-print-refused");
  assert.equal(refused.status, 112);
  assert.throws(() => launchdServicesOfResult(refused.pid, refused),
    /^Error: launchctl print pid\/0 exited with 112: Bad request\.\nCould not find domain for pid: 0$/);
});
