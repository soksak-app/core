// When a request is still pending at STALL_AFTER, the check keeps the stacks of the host process at that time (F69).
// What the main thread did while it did not answer can be seen only at that moment. The record ends no request.
import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import test, { mock } from "node:test";

// The host pid that no process holds. launchctl and sample answer for it as they do on macOS 27 for a process that does not run,
// so the check of the record of an absent host does not depend on the tools of the system; every other command runs.
const ABSENT_HOST = 999999;
const ABSENT_DOMAIN = `pid/${ABSENT_HOST} = {\n\ttype = pid\n\thandle = ${ABSENT_HOST}\n\tactive count = 1\n\n\tservices = {\n\t}\n\n` +
  "\tunmanaged processes = {\n\t}\n\n\tendpoints = {\n\t}\n\n\tproperties = slain\n}\n";
const ABSENT_SAMPLE = `sample[19329]: sample cannot examine process ${ABSENT_HOST} (with name like '${ABSENT_HOST}') because it no longer appears to be running.\n`;
function execFile(command, args, options, callback) {
  if (command === "/bin/launchctl" && args[1] === `pid/${ABSENT_HOST}`) {
    queueMicrotask(() => callback(null, ABSENT_DOMAIN, ""));
    return { pid: undefined, kill: () => false };
  }
  if (command === "/usr/bin/sample" && args[0] === String(ABSENT_HOST)) {
    queueMicrotask(() => callback(Object.assign(new Error(`Command failed: ${command} ${args.join(" ")}`), { code: 255 }), "", ABSENT_SAMPLE));
    return { pid: undefined, kill: () => false };
  }
  return childProcess.execFile(command, args, options, callback);
}
mock.module("node:child_process", {
  namedExports: { ...childProcess, execFile },
  defaultExport: { ...childProcess.default, execFile },
});
const { whilePending, within } = await import("../app.mjs");
const { sampleProcess } = await import("../stall-sample.mjs");

test("a search that does not end within its limit fails naming the search", async () => {
  await assert.rejects(within(new Promise(() => {}), 10, "the chain probe"), /^Error: the chain probe did not answer within 10 ms$/);
});

test("a search that ends within its limit returns its value", async () => {
  assert.equal(await within(Promise.resolve(7), 1000, "probe"), 7);
});

test("a failed sample of a pending request is named in the report instead of hiding it", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const reports = [];
  const held = [];
  void whilePending(new Promise(() => {}), "probe", async () => { throw new Error("sample: no such process"); },
    (text) => reports.push(text), (started) => held.push(started));
  t.mock.timers.tick(3000);
  await assert.rejects(held[0], /^Error: probe still pending after 3000 ms; sampling the host failed: sample: no such process$/);
  assert.deepEqual(reports, ["probe still pending after 3000 ms; sampling the host failed: sample: no such process"]);
});

test("a request of a session has no time limit and takes no options", async (t) => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { Session } = await import("../app.mjs");
  const configDir = mkdtempSync(join(tmpdir(), "soksak-stall-config-"));
  t.after(() => rmSync(configDir, { recursive: true }));
  const s = new Session({ name: "tauriv2", configDir }, { endpoint: { pid: ABSENT_HOST }, request: async () => 1 });
  assert.throws(() => s.request("status.get", { name: "core.verify" }, { timeout: 10 }), {
    name: "TypeError", message: "request status.get takes no options: a request ends by its answer or the close of the connection",
  });
  assert.throws(() => s.run("core.verify", {}, undefined, { timeout: 10 }), {
    name: "TypeError", message: "run core.verify takes no options: a command ends by its answer or the close of the connection",
  });
});

test("sampleProcess runs sample on the host process into the given file and reports its failure", async () => {
  const calls = [];
  const path = await sampleProcess(4321, "/x/stall.txt", (command, args) => { calls.push([command, ...args]); return { status: 0, stderr: "" }; });
  assert.equal(path, "/x/stall.txt");
  assert.deepEqual(calls, [["/usr/bin/sample", "4321", "2", "-file", "/x/stall.txt"]]);
  await assert.rejects(sampleProcess(4321, "/x/stall.txt", () => ({ status: 1, stderr: "sample cannot examine process 4321\n" })),
    /^Error: sample 4321 exited with 1: sample cannot examine process 4321$/);
});

test("a process ended at its limit is named with the signal, the limit, its standard error and the state of the system", async () => {
  const { runProcess } = await import("../stall-sample.mjs");
  const ended = (script) => sampleProcess(4321, "/x/stall.txt", () => runProcess("/bin/sh", ["-c", script], { limitMs: 200 }));
  await assert.rejects(ended("echo held >&2; exec sleep 5"),
    /^Error: sample 4321: ended by SIGTERM at its limit of 200 ms; standard error: held; at the limit: free \d+ MB on \/, load \d+\.\d$/);
  await assert.rejects(ended("exec sleep 5"),
    /^Error: sample 4321: ended by SIGTERM at its limit of 200 ms; standard error: none; at the limit: free \d+ MB on \/, load \d+\.\d$/);
});

test("a process ended by a signal of another sender is not reported as ended at its limit", async () => {
  const { runProcess } = await import("../stall-sample.mjs");
  await assert.rejects(sampleProcess(4321, "/x/stall.txt", () => runProcess("/bin/sh", ["-c", "echo held >&2; kill -KILL $$"], { limitMs: 5000 })),
    /^Error: sample 4321: ended by SIGKILL; standard error: held$/);
});

test("the state at the limit is read while the process still runs", async () => {
  const { runProcess } = await import("../stall-sample.mjs");
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
  const { runProcess } = await import("../stall-sample.mjs");
  const { error } = await runProcess("/bin/sh", ["-c", "exec sleep 5"], { limitMs: 100, atLimit: () => new Promise(() => {}), stateLimitMs: 100 });
  assert.equal(error.message, "ended by SIGTERM at its limit of 100 ms; standard error: none; at the limit: not read within 100 ms");
});

test("the limit of a process holds while a check moves mocked timers", { timeout: 5000 }, async (t) => {
  const { runProcess } = await import("../stall-sample.mjs");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { error } = await runProcess("/bin/sh", ["-c", "exec sleep 5"], { limitMs: 100, atLimit: null });
  assert.equal(error.message, "ended by SIGTERM at its limit of 100 ms; standard error: none");
});

test("stacks that the sampling process cannot record are named with the reason", async () => {
  const { samplerState } = await import("../stall-sample.mjs");
  assert.match(await samplerState(99, "/x/sampler.txt", async () => ({ error: new Error("ended by SIGTERM at its limit of 3000 ms") })),
    /^free \d+ MB on \/, load \d+\.\d, stacks of the process not recorded: ended by SIGTERM at its limit of 3000 ms$/);
  assert.match(await samplerState(99, "/x/sampler.txt", async () => ({ status: 1, stderr: "no such process\n" })),
    /^free \d+ MB on \/, load \d+\.\d, stacks of the process not recorded: exited with 1: no such process$/);
});

test("the page processes of a host are the running WebContent services of its launchd domain", async () => {
  const { pageProcesses } = await import("../stall-sample.mjs");
  const stdout = "pid/10 = {\n\tservices = {\n\t\t       0      - \tcom.apple.WebKit.WebContent\n" +
    "\t\t      11      - \tcom.apple.WebKit.GPU.A\n\t\t      12      - \tcom.apple.WebKit.WebContent.B\n" +
    "\t\t      13      - \tcom.apple.WebKit.WebContent.C\n\t}\n\tendpoints = {\n\t\t   14 com.apple.WebKit.WebContent.D\n\t}\n}\n";
  const calls = [];
  assert.deepEqual(await pageProcesses(10, (command, args) => { calls.push([command, ...args]); return { status: 0, stdout }; }), [12, 13]);
  assert.deepEqual(calls, [["/bin/launchctl", "print", "pid/10"]]);
  await assert.rejects(pageProcesses(10, () => ({ status: 113, stderr: "Could not print domain\n" })),
    /^Error: launchctl print pid\/10 exited with 113: Could not print domain$/);
});

test("a page that does not reply records the host and its page processes and names the records", async () => {
  const { sampleStall } = await import("../stall-sample.mjs");
  const sampled = [];
  const files = await sampleStall({ host: 10, pages: [12, 13], directory: "/x/logs", time: 7,
    sample: (pid, file) => { sampled.push([pid, file]); return file; }, flock: async () => null });
  assert.deepEqual(sampled, [[10, "/x/logs/stall-10-7.txt"], [12, "/x/logs/stall-10-7-page-12.txt"], [13, "/x/logs/stall-10-7-page-13.txt"]]);
  assert.deepEqual(files, sampled.map(([, file]) => file));
});

test("a request that the page did not answer names the stall records or why they could not be made", async (t) => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { EndpointError } = await import("@soksak/client");
  const { Session } = await import("../app.mjs");
  const configDir = mkdtempSync(join(tmpdir(), "soksak-stall-config-"));
  t.after(() => rmSync(configDir, { recursive: true }));
  const client = { endpoint: { pid: ABSENT_HOST }, request: async () => { throw new EndpointError({ code: -32603, message: "the document did not reply within 10000 ms" }); } };
  const s = new Session({ name: "tauriv2", configDir }, client);
  // No process ABSENT_HOST runs, so sample cannot record the host and the reason stays in the error.
  await assert.rejects(s.request("status.get", { name: "core.verify" }),
    /^EndpointError: tauriv2 status\.get core\.verify: the document did not reply within 10000 ms; sampling the host failed: sample 999999 /);
});

test("a page process that already ended does not cost the records of the host and the other pages", async () => {
  const { sampleStall } = await import("../stall-sample.mjs");
  const results = await sampleStall({ host: 10, pages: [12, 13], directory: "/x/logs", time: 7, sample: (pid, file) => {
    if (pid === 12) throw new Error("sample 12 exited with 255: process 12 no longer appears to be running");
    return file;
  }, flock: async () => null });
  assert.deepEqual(results, [
    "/x/logs/stall-10-7.txt",
    "page 12 not sampled: sample 12 exited with 255: process 12 no longer appears to be running",
    "/x/logs/stall-10-7-page-13.txt",
  ]);
});

test("the path of the dump of the host is stored as an event and its position is named", async () => {
  const { announceStall } = await import("../stall-sample.mjs");
  const calls = [];
  const text = await announceStall(async (method, params) => { calls.push([method, params]); return { boot: "b1", seq: 9 }; }, "main",
    ["/x/logs/stall-10-7.txt", "page 12 not sampled: gone", "/x/logs/stall-10-7-page-13.txt"]);
  assert.deepEqual(calls, [["diagnostics.stall.dump", { window: "main", path: "/x/logs/stall-10-7.txt" }]]);
  assert.equal(text, "host.stall.dump at b1:9");
});

test("a host that refuses the dump event is named in the message instead of hiding it", async () => {
  const { announceStall } = await import("../stall-sample.mjs");
  const text = await announceStall(async () => { throw new Error("path does not name a file: /x"); }, "main", ["/x/logs/stall-10-7.txt"]);
  assert.equal(text, "host.stall.dump not stored: path does not name a file: /x");
});

test("a host that does not answer the dump event within the bound is named in the message", async () => {
  const { announceStall } = await import("../stall-sample.mjs");
  const text = await announceStall(() => new Promise(() => {}), "main", ["/x/logs/stall-10-7.txt"], 10);
  assert.equal(text, "host.stall.dump not stored: no answer within 10 ms");
});

test("a request pending past 3 s starts the host and page samples in the same turn", async (t) => {
  const { sampleStall } = await import("../stall-sample.mjs");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const started = [];
  const sample = async () => (await sampleStall({ host: 10, pages: [12, 13], directory: "/x/logs", time: 7,
    sample: (pid, file) => { started.push(pid); return file; }, flock: async () => null })).join(", ");
  const reports = [];
  void whilePending(new Promise(() => {}), "wailsv3 status.get host.windows", sample, (text) => reports.push(text), () => {});
  t.mock.timers.tick(2999);
  assert.deepEqual(started, []);
  t.mock.timers.tick(1);
  assert.deepEqual(started, [10, 12, 13]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(reports, ["wailsv3 status.get host.windows still pending after 3000 ms; the host's threads at that moment: /x/logs/stall-10-7.txt, /x/logs/stall-10-7-page-12.txt, /x/logs/stall-10-7-page-13.txt"]);
});

test("a request that answers before 3 s does not start a sample", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let sampled = 0;
  const answer = whilePending(new Promise((resolve) => setTimeout(() => resolve(5), 1000)), "probe",
    async () => { sampled++; return ""; }, () => {}, () => {});
  t.mock.timers.tick(1000);
  assert.equal(await answer, 5);
  t.mock.timers.tick(10_000);
  assert.equal(sampled, 0);
});


// The sample of a page process whose render queue waits in flock, as /usr/bin/sample of macOS 27 writes it, and of one
// that waits in no flock. Only the section of the tops of the stacks is read.
const FLOCK_SAMPLE = [
  "Call graph:",
  "    1700 Thread_9697167   DispatchQueue_1: com.apple.main-thread  (serial)",
  "      1700 start  (in dyld) + 6688  [0x18113be80]",
  "    1700 Thread_9697170   DispatchQueue_42: com.apple.CoreAnimation.render-queue  (serial)",
  "      1700 flock  (in libsystem_kernel.dylib) + 8  [0x1814d0cdc]",
  "",
  "Total number in stack (recursive counted multiple, when >=5):",
  "",
  "Sort by top of stack, same collapsed (when >= 5):",
  "        flock  (in libsystem_kernel.dylib)        1700",
  "        mach_msg2_trap  (in libsystem_kernel.dylib)        1700",
  "",
  "Binary Images:",
  "",
].join("\n");
const IDLE_SAMPLE = FLOCK_SAMPLE.replace("        flock  (in libsystem_kernel.dylib)        1700\n", "");

// The field output of `lsof -n -P -F pcftn -p 12`: the mapped executable, a pipe, the shader cache and a database.
const LSOF_PAGE = "p12\ncWebContent\nftxt\ntREG\nn/System/WebContent\nf2\ntPIPE\nn->0x1\nf7\ntREG\nn/c/metal/shaders.data\nf9\ntREG\nn/c/web.db\n";
// The answer of the lock probe for both files: a lock of flock on the cache and a lock of fcntl of process 12 on the database.
const PROBE_PAGE = "locked\t-1\t/c/metal/shaders.data\nlocked\t12\t/c/web.db\n";
const opener = (pid, command, fd) => `p${pid}\nc${command}\nf${fd}\ntREG\nn/c/metal/shaders.data\n`;

// An executor that answers each command of the flock reading from outputs, by its program and its last argument.
function commands(outputs, calls) {
  return async (command, args) => {
    calls.push([command, ...args]);
    const answer = outputs[`${command} ${args.at(-1)}`];
    if (answer === undefined) throw new Error(`no answer for ${command} ${args.join(" ")}`);
    return answer;
  };
}

test("a page process that waits in flock names the file it waits for and the process that holds its lock", async () => {
  const { flockWait, sampleStall } = await import("../stall-sample.mjs");
  const calls = [];
  const run = commands({
    "/usr/sbin/lsof 12": { status: 0, stdout: LSOF_PAGE, stderr: "" },
    "/usr/bin/perl /c/web.db": { status: 0, stdout: PROBE_PAGE, stderr: "" },
    "/usr/sbin/lsof /c/metal/shaders.data": { status: 0, stdout: opener(12, "WebContent", 7) + opener(31, "MTLCompilerService", 4), stderr: "" },
  }, calls);
  const read = async (file) => { assert.equal(file, "/x/logs/stall-10-7-page-12.txt"); return FLOCK_SAMPLE; };
  const records = await sampleStall({ host: 10, pages: [12], directory: "/x/logs", time: 7, sample: (pid, file) => file,
    flock: (pid, file) => flockWait(pid, file, { run, read }) });
  assert.deepEqual(records, ["/x/logs/stall-10-7.txt",
    "/x/logs/stall-10-7-page-12.txt; flock.file=/c/metal/shaders.data; flock.holder=31 MTLCompilerService"]);
  assert.deepEqual(calls.map(([command, ...args]) => [command, args[0] === "-e" ? ["-e", "<probe>", ...args.slice(2)] : args].flat()), [
    ["/usr/sbin/lsof", "-n", "-P", "-F", "pcftn", "-p", "12"],
    ["/usr/bin/perl", "-e", "<probe>", "--", "/c/metal/shaders.data", "/c/web.db"],
    ["/usr/sbin/lsof", "-n", "-P", "-F", "pcftn", "--", "/c/metal/shaders.data"],
  ]);
});

test("a flock wait whose holder cannot be identified names why in the record", async () => {
  const { flockWait, flockFields } = await import("../stall-sample.mjs");
  const wait = (openers) => flockWait(12, "/x/page.txt", { read: async () => FLOCK_SAMPLE, run: commands({
    "/usr/sbin/lsof 12": { status: 0, stdout: LSOF_PAGE },
    "/usr/bin/perl /c/web.db": { status: 0, stdout: PROBE_PAGE },
    "/usr/sbin/lsof /c/metal/shaders.data": { status: 0, stdout: openers },
  }, []) }).then(flockFields);
  assert.equal(await wait(opener(12, "WebContent", 7) + opener(31, "WebContent", 4) + opener(32, "WebContent", 5)),
    "; flock.file=/c/metal/shaders.data; flock.holder.error=one of the processes that have the file open holds it: 31 WebContent, 32 WebContent");
  assert.equal(await wait(opener(12, "WebContent", 7)),
    "; flock.file=/c/metal/shaders.data; flock.holder.error=no other process of this user has /c/metal/shaders.data open");
  // A process that has the file open twice may hold the lock on one description and wait on the other.
  assert.equal(await wait(opener(12, "WebContent", 7) + "f8\ntREG\nn/c/metal/shaders.data\n"),
    "; flock.file=/c/metal/shaders.data; flock.holder=12 WebContent");
});

test("a flock wait whose file cannot be identified names why in the record", async () => {
  const { flockWait, flockFields } = await import("../stall-sample.mjs");
  const wait = (lsof, probe) => flockWait(12, "/x/page.txt", { read: async () => FLOCK_SAMPLE, run: commands({
    "/usr/sbin/lsof 12": { status: 0, stdout: lsof },
    "/usr/bin/perl /c/web.db": { status: 0, stdout: probe },
  }, []) }).then(flockFields);
  assert.equal(await wait("p12\ncWebContent\nftxt\ntREG\nn/System/WebContent\n", ""), "; flock.file.error=process 12 has no regular file open");
  assert.equal(await wait(LSOF_PAGE, "none\t/c/metal/shaders.data\nlocked\t12\t/c/web.db\n"),
    "; flock.file.error=no file that process 12 has open holds a lock of flock");
  assert.equal(await wait(LSOF_PAGE, "locked\t-1\t/c/metal/shaders.data\nlocked\t-1\t/c/web.db\n"),
    "; flock.file.error=2 files that process 12 has open hold a lock of flock: /c/metal/shaders.data, /c/web.db");
  assert.equal(await wait(LSOF_PAGE, "locked\t-1\t/c/metal/shaders.data\nerror\tPermission denied\t/c/web.db\n"),
    "; flock.file.error=the lock of /c/web.db not read: Permission denied");
});

test("a page process that waits in no flock has no flock fields in its record", async () => {
  const { flockWait, sampleStall } = await import("../stall-sample.mjs");
  const calls = [];
  const records = await sampleStall({ host: 10, pages: [12], directory: "/x/logs", time: 7, sample: (pid, file) => file,
    flock: (pid, file) => flockWait(pid, file, { run: commands({}, calls), read: async () => IDLE_SAMPLE }) });
  assert.deepEqual(records, ["/x/logs/stall-10-7.txt", "/x/logs/stall-10-7-page-12.txt"]);
  assert.deepEqual(calls, []);
});

test("a flock wait that cannot be read is named in the record with the reason", async () => {
  const { flockWait, sampleStall } = await import("../stall-sample.mjs");
  const record = async (read, run) => (await sampleStall({ host: 10, pages: [12], directory: "/x/logs", time: 7, sample: (pid, file) => file,
    flock: (pid, file) => flockWait(pid, file, { run, read }) }))[1];
  assert.equal(await record(async () => FLOCK_SAMPLE, async () => ({ status: 1, stdout: "", stderr: "" })),
    "/x/logs/stall-10-7-page-12.txt; flock.error=/usr/sbin/lsof -n -P -F pcftn -p 12 exited with 1: no standard error");
  assert.equal(await record(async () => "Call graph:\n", commands({}, [])),
    "/x/logs/stall-10-7-page-12.txt; flock.error=the sample has no section \"Sort by top of stack, same collapsed\"");
  assert.equal(await record(async () => FLOCK_SAMPLE, commands({ "/usr/sbin/lsof 12": { status: 0, stdout: LSOF_PAGE },
    "/usr/bin/perl /c/web.db": { status: 0, stdout: "locked\t-1\t/c/metal/shaders.data\n" } }, [])),
  "/x/logs/stall-10-7-page-12.txt; flock.error=the lock probe answered 1 of 2 files");
});
