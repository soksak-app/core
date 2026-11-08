// The stall records of the window checks on the live tools of macOS: /usr/bin/sample of a running process and lsof with the
// lock probe of a real flock wait. The owners of the records on recorded output are ../../../stall-sample.test.mjs.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sampleProcess } from "../../../../stall-sample.mjs";

// The sample of a page process whose render queue waits in flock, as /usr/bin/sample of macOS 27 writes it.
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

test("a sample that stalls records the stacks of the sampling process before it ends", { timeout: 20000 }, async (t) => {
  const { runProcess } = await import("../../../../stall-sample.mjs");
  const folder = mkdtempSync(join(tmpdir(), "stall-sampler-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const file = join(folder, "stall.txt");
  const stalled = (command, args, options) => runProcess("/bin/sh", ["-c", "exec sleep 30"], { ...options, limitMs: 100 });
  const failure = await sampleProcess(4321, file, stalled).then(() => null, (error) => error.message);
  const start = "sample 4321: ended by SIGTERM at its limit of 100 ms; standard error: none; at the limit: ";
  assert.ok(failure?.startsWith(start), failure);
  const state = failure.slice(start.length);
  assert.match(state, /^free \d+ MB on \/, load \d+\.\d, stacks of the process: /);
  assert.equal(state.split("stacks of the process: ")[1], `${file}.sampler.txt`);
  assert.match(readFileSync(`${file}.sampler.txt`, "utf8"), /Call graph:/);
});

test("native stall sampling keeps the check event loop responsive", { timeout: 10000 }, async (t) => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = await mkdtemp(join(tmpdir(), "soksak-stall-async-"));
  t.after(() => rm(directory, { recursive: true }));
  let heartbeat = false;
  const beat = new Promise((resolve) => setImmediate(() => { heartbeat = true; resolve(); }));
  const task = sampleProcess(process.pid, join(directory, "sample.txt"));
  try {
    assert.equal(typeof task?.then, "function", "sampling must return before the child finishes");
    await beat;
    assert.equal(heartbeat, true);
    assert.equal(await task, join(directory, "sample.txt"));
  } finally {
    await task;
  }
});

test("lsof and the lock probe of macOS name the file and the holder of a real flock wait", { timeout: 20000 }, async (t) => {
  const { spawn } = await import("node:child_process");
  const { realpathSync, writeFileSync } = await import("node:fs");
  const { flockWait } = await import("../../../../stall-sample.mjs");
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "stall-flock-")));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const file = join(folder, "shaders.data");
  writeFileSync(file, "");
  const started = (script, word) => new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/perl", ["-e", script, file], { stdio: ["ignore", "pipe", "ignore"] });
    t.after(() => child.kill("SIGKILL"));
    child.on("error", reject);
    child.stdout.on("data", (data) => { if (String(data).includes(word)) resolve(child); });
  });
  const holder = await started('use Fcntl ":flock"; $| = 1; open(my $f, "<", $ARGV[0]) or die; flock($f, LOCK_EX) or die; print "held\\n"; sleep 60', "held");
  const waiter = await started('use Fcntl ":flock"; $| = 1; open(my $f, "<", $ARGV[0]) or die; print "opened\\n"; flock($f, LOCK_EX) or die; sleep 60', "opened");
  assert.deepEqual(await flockWait(waiter.pid, "/x/page.txt", { read: async () => FLOCK_SAMPLE }),
    { file, holder: { pid: holder.pid, command: "perl" } });
});
