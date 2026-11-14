// The stall records of the window checks on the live tools of macOS: /usr/bin/sample of a running process, launchctl, and lsof with
// the lock probe of a real flock wait. The owners of the records on recorded output are ../../../stall-sample.test.mjs.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { flockWait, pageProcesses, pageRecord, plannedLength, sampleProcess, sampleStall, samplerState } from "../../../../stall-sample.mjs";

const { whilePending } = await import("../../../../app.mjs");

// The programs of the two processes that flock a file: the holder holds the lock, and the waiter waits for it.
const fixture = (name) => fileURLToPath(new URL(`../../../../fixtures/${name}`, import.meta.url));
// The samples that /usr/bin/sample recorded of a process that waits in no flock, of one that waits in flock, and the header of a
// sample without its sections.
const IDLE_SAMPLE = fixture("stall-tools/sample-idle.txt");
const HEADER_ONLY_SAMPLE = fixture("stall-tools/sample-header-only.txt");
const FLOCK_SAMPLE = fixture("stall-tools/sample-flock-waiter.txt");

/** A folder for the files of the test, removed when it ends. */
function folder(t) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "stall-system-")));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/** A running process of fixtures/idle-process.mjs, which the real sample records. */
async function idle(t) {
  const child = spawn(process.execPath, [fixture("idle-process.mjs")], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => child.kill("SIGKILL"));
  await once(child.stdout, "data");
  return child;
}

/** The pid of a process of the same program that has ended. */
async function endedPid(t) {
  const child = await idle(t);
  child.kill("SIGKILL");
  await once(child, "exit");
  return child.pid;
}

/** Starts the perl program `program` on `file` and resolves when it prints `word`. */
function started(t, program, file, word) {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/perl", [fixture(program), file], { stdio: ["ignore", "pipe", "ignore"] });
    t.after(() => child.kill("SIGKILL"));
    child.on("error", reject);
    child.stdout.on("data", (data) => { if (String(data).includes(word)) resolve(child); });
  });
}

test("a sample that stalls records the stacks of the sampling process before it ends", { timeout: 20000 }, async (t) => {
  const directory = folder(t);
  const file = join(directory, "stall.txt");
  // The process that the real sample samples: it sleeps, and the sample of it runs longer than the limit of 100 ms.
  const sampled = spawn("/bin/sleep", ["60"], { stdio: "ignore" });
  t.after(() => sampled.kill("SIGKILL"));
  const failure = await sampleProcess(sampled.pid, file, { limitMs: 100 }).then(() => null, (error) => error.message);
  // The real sample writes its progress to standard error before the limit ends it.
  const start = new RegExp(`^sample ${sampled.pid}: ended by SIGTERM at its limit of 100 ms; standard error: Sampling process ${sampled.pid} for \\d+ seconds[^;]*; at the limit: `);
  assert.match(failure, start);
  const state = failure.replace(start, "");
  assert.match(state, /^free \d+ MB on \/, load \d+\.\d, stacks of the process: /);
  assert.equal(state.split("stacks of the process: ")[1], `${file}.sampler.txt`);
  assert.match(readFileSync(`${file}.sampler.txt`, "utf8"), /Call graph:/);
});

test("native stall sampling keeps the check event loop responsive", { timeout: 10000 }, async (t) => {
  const directory = folder(t);
  let heartbeat = false;
  const beat = new Promise((resolve) => setImmediate(() => { heartbeat = true; resolve(); }));
  const task = sampleProcess(process.pid, join(directory, "sample.txt"));
  try {
    assert.equal(typeof task?.then, "function", "sampling must return before the child finishes");
    await beat;
    assert.equal(heartbeat, true);
    assert.equal(await task, join(directory, "sample.txt"));
    // sample runs without the services of the symbol lookup and still names the functions of the system libraries.
    assert.match(readFileSync(join(directory, "sample.txt"), "utf8"), /^ +\d+ [A-Za-z_][\w:]* +\(in libsystem_[a-z_]+\.dylib\) \+ \d+/m);
  } finally {
    await task;
  }
});

// A binary without symbols, as /bin/sleep, makes sample look for its dSYM with a Spotlight query, which a loaded machine answers late
// (the command of the sample denies that service; ../../../stall-sample.test.mjs checks the command): the real tool records a
// running process with it.
test("sampleProcess records the threads of a running process into the given file and names the reason of a failure", { timeout: 30000 }, async (t) => {
  const directory = folder(t);
  const running = await idle(t);
  const file = join(directory, "stall.txt");
  assert.equal(await sampleProcess(running.pid, file), file);
  assert.match(readFileSync(file, "utf8"), /^Analysis of sampling /);
  const ended = await endedPid(t);
  await assert.rejects(sampleProcess(ended, join(directory, "ended.txt")),
    new RegExp(`^Error: sample ${ended} exited with 255: .*sample cannot examine process ${ended} .*no longer appears to be running`));
});

test("stacks that the sampling process cannot record are named with the reason", { timeout: 30000 }, async (t) => {
  const directory = folder(t);
  const running = await idle(t);
  assert.match(await samplerState(running.pid, join(directory, "sampler.txt"), { limitMs: 50 }),
    /^free \d+ MB on \/, load \d+\.\d, stacks of the process not recorded: ended by SIGTERM at its limit of 50 ms/);
  const ended = await endedPid(t);
  assert.match(await samplerState(ended, join(directory, "ended.txt")),
    /^free \d+ MB on \/, load \d+\.\d, stacks of the process not recorded: exited with 255: .*no longer appears to be running/);
  const file = join(directory, "running.txt");
  assert.equal(await samplerState(running.pid, file).then((text) => text.replace(/^free \d+ MB on \/, load \d+\.\d, /, "")),
    `stacks of the process: ${file}`);
});

test("the page processes of a host are read from the launchd domain of the host by launchctl", { timeout: 20000 }, async () => {
  // A process that runs no page has no WebContent service in its domain.
  assert.deepEqual(await pageProcesses(process.pid), []);
  await assert.rejects(pageProcesses("none"), /^Error: launchctl print pid\/none exited with \d+: /);
});

test("a failed sample of a pending request is named in the report instead of hiding it", { timeout: 30000 }, async (t) => {
  const directory = folder(t);
  const ended = await endedPid(t);
  const reports = [];
  const held = Promise.withResolvers();
  void whilePending(new Promise(() => {}), "probe", () => sampleProcess(ended, join(directory, "ended.txt")),
    (text) => reports.push(text), (sample) => held.resolve(sample), 0, 0);
  const pattern = new RegExp(`^Error: probe still pending after 0 ms; sampling the host failed: sample ${ended} exited with 255: .*no longer appears to be running\\.$`);
  await assert.rejects(held.promise, pattern);
  assert.equal(reports.length, 1);
  assert.match(`Error: ${reports[0]}`, pattern);
});

test("a pending request records the host and its page processes when its stall is due", { timeout: 30000 }, async (t) => {
  const directory = folder(t);
  const [host, first, second] = [await idle(t), await idle(t), await idle(t)];
  const sample = async () => (await sampleStall({ host: host.pid, pages: [first.pid, second.pid], directory, time: 7 })).join(", ");
  const reported = Promise.withResolvers();
  const reports = [];
  void whilePending(new Promise(() => {}), "wailsv3 status.get host.windows", sample, (text) => { reports.push(text); reported.resolve(); },
    () => {}, 0, 0);
  await reported.promise;
  const files = [`stall-${host.pid}-7.txt`, `stall-${host.pid}-7-page-${first.pid}.txt`, `stall-${host.pid}-7-page-${second.pid}.txt`].map((name) => join(directory, name));
  assert.deepEqual(reports, [`wailsv3 status.get host.windows still pending after 0 ms; the host's threads at that moment: ${files.join(", ")}`]);
  for (const file of files) assert.equal(existsSync(file), true, `${file} was not recorded`);
});

test("a drag being measured is reported with the planned length of the drag and its stall after it", { timeout: 30000 }, async (t) => {
  const directory = folder(t);
  const running = await idle(t);
  const planned = plannedLength("diagnostics.drag", { axis: "x", line: 2, dx: -250, dy: 0, ms: 48, times: 15 });
  const reported = Promise.withResolvers();
  const reports = [];
  void whilePending(new Promise(() => {}), "mygo diagnostics.drag", () => sampleProcess(running.pid, join(directory, "drag.txt")),
    (text) => { reports.push(text); reported.resolve(); }, () => {}, planned, 0);
  await reported.promise;
  assert.deepEqual(reports, [`mygo diagnostics.drag still pending 0 ms after its planned 1440 ms; the host's threads at that moment: ${join(directory, "drag.txt")}`]);
});

test("a request that answers before its stall is due does not start a sample", { timeout: 30000 }, async (t) => {
  const directory = folder(t);
  const running = await idle(t);
  const file = join(directory, "answered.txt");
  // The finally of whilePending clears the stall timer in a microtask that runs before the next timer turn, so the answer wins
  // without a sleep, and the sample that it would start leaves no file.
  const answer = whilePending(Promise.resolve(5), "probe", () => sampleProcess(running.pid, file), () => {}, () => {}, 0, 0);
  assert.equal(await answer, 5);
  assert.equal(existsSync(file), false);
});

test("a page that does not reply records the host and its page processes and names the records", { timeout: 30000 }, async (t) => {
  const directory = folder(t);
  const [host, first, second] = [await idle(t), await idle(t), await idle(t)];
  const files = await sampleStall({ host: host.pid, pages: [first.pid, second.pid], directory, time: 7 });
  assert.deepEqual(files, [`stall-${host.pid}-7.txt`, `stall-${host.pid}-7-page-${first.pid}.txt`, `stall-${host.pid}-7-page-${second.pid}.txt`]
    .map((name) => join(directory, name)));
  for (const file of files) assert.match(readFileSync(file, "utf8"), /Sort by top of stack, same collapsed/);
});

test("a page process that already ended does not cost the records of the host and the other pages", { timeout: 30000 }, async (t) => {
  const directory = folder(t);
  const [host, page] = [await idle(t), await idle(t)];
  const ended = await endedPid(t);
  const results = await sampleStall({ host: host.pid, pages: [ended, page.pid], directory, time: 7 });
  assert.equal(results.length, 3);
  assert.equal(results[0], join(directory, `stall-${host.pid}-7.txt`));
  assert.match(results[1], new RegExp(`^page ${ended} not sampled: sample ${ended} exited with 255: .*no longer appears to be running\\.$`));
  assert.equal(results[2], join(directory, `stall-${host.pid}-7-page-${page.pid}.txt`));
});

test("a page process that waits in no flock has no flock fields in its record", { timeout: 20000 }, async (t) => {
  const running = await idle(t);
  assert.equal(await pageRecord(running.pid, IDLE_SAMPLE), IDLE_SAMPLE);
  assert.equal(await flockWait(running.pid, IDLE_SAMPLE), null);
});

test("a flock wait that cannot be read is named in the record with the reason", { timeout: 20000 }, async (t) => {
  const ended = await endedPid(t);
  // The sample of the recording shows a wait in flock, and the real lsof finds no process.
  assert.equal(await pageRecord(ended, FLOCK_SAMPLE),
    `${FLOCK_SAMPLE}; flock.error=/usr/sbin/lsof -n -P -F pcftn -p ${ended} exited with 1: no standard error`);
  assert.equal(await pageRecord(ended, HEADER_ONLY_SAMPLE),
    `${HEADER_ONLY_SAMPLE}; flock.error=the sample has no section "Sort by top of stack, same collapsed"`);
});

test("lsof and the lock probe of macOS name the file and the holder of a real flock wait", { timeout: 40000 }, async (t) => {
  const directory = folder(t);
  const file = join(directory, "shaders.data");
  closeSync(openSync(file, "w"));
  const holder = await started(t, "flock-holder.pl", file, "held");
  const waiter = await started(t, "flock-waiter.pl", file, "opened");
  const host = await idle(t);
  // The real sample of the waiter shows its thread in flock, and the page record of a stall names the file and the holder.
  const [, record] = await sampleStall({ host: host.pid, pages: [waiter.pid], directory, time: 9 });
  assert.equal(record, `${join(directory, `stall-${host.pid}-9-page-${waiter.pid}.txt`)}; flock.file=${file}; flock.holder=${holder.pid} perl`);
  assert.deepEqual(await flockWait(waiter.pid, join(directory, `stall-${host.pid}-9-page-${waiter.pid}.txt`)),
    { file, holder: { pid: holder.pid, command: "perl" } });
});
