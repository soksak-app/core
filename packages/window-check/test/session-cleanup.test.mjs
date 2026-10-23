// Checks that a cleanup failure of a window check is reported together with the failure of the check body.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const app = new URL("../app.mjs", import.meta.url).href;

// Runs a check file whose body and cleanup both fail in a separate node:test run. How node:test handles the cleanup
// error is the subject of the check, so the execution context of this check (NODE_TEST_CONTEXT) is not passed on.
function run(t) {
  const dir = mkdtempSync(join(tmpdir(), "soksak-session-cleanup-"));
  t.after(() => rmSync(dir, { recursive: true }));
  const file = join(dir, "probe.test.mjs");
  writeFileSync(file, `import test from "node:test";
import { finishSession } from ${JSON.stringify(app)};
test("probe body fails", async (t) => {
  const session = {
    app: { name: "probe" },
    cleanups: [async () => { throw new Error("probe press stayed open"); }, async () => {}],
    expectedErrors: [],
    markTest: async () => null,
  };
  t.after(() => finishSession(t, session, () => {}));
  throw new Error("probe body failed");
});
`);
  const { NODE_TEST_CONTEXT, ...environment } = process.env;
  return spawnSync(process.execPath, ["--test", "--test-reporter=tap", file],
    { encoding: "utf8", timeout: 20000, env: { ...environment, FORCE_COLOR: "0" } });
}

test("a cleanup failure is reported when the check body already failed", { timeout: 30000 }, (t) => {
  const result = run(t);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /probe body failed/);
  assert.match(result.stdout, /# cleanup failed: Error: probe press stayed open/);
});

// A check that passes its body still fails on an error event that the application stored in its event log during the check.
// A reload removes the error from the document but the event log keeps it. An event stored before the check started is not
// the check's, and an error that the check declares is not a failure (F31).
const event = (seq, level, name, fields, layer = "host") =>
  JSON.stringify({ ts_us: 1791000000000000 + seq, seq, level, layer, event: name, fields });

/** The probe's event log, and the number of bytes that were in it before the check started. */
function writeEventLog(dir, lines) {
  const before = `${lines.before.join("\n")}\n`;
  writeFileSync(join(dir, "logs", "host-1-1.jsonl"), `${before}${lines.during.join("\n")}${lines.during.length ? "\n" : ""}`);
  return Buffer.byteLength(before);
}

const OPEN = event(1, "info", "log.open", { schema: 2 });
const PREVIOUS = event(2, "error", "page.record.error", { where: "rejected", text: "an error of the previous check" }, "page");
const RESIZE = event(4, "error", "page.record.error", { where: "page", text: "ResizeObserver loop completed with undelivered notifications. @ wails://localhost/:0" }, "page");

function runLoggedError(t, expected, during) {
  const dir = mkdtempSync(join(tmpdir(), "soksak-session-log-error-"));
  // The check keeps the positions it read in a file beside the configuration folder.
  t.after(() => rmSync(`${dir}.event-offsets`, { force: true }));
  t.after(() => rmSync(dir, { recursive: true }));
  mkdirSync(join(dir, "logs"));
  const started = writeEventLog(dir, { before: [OPEN, PREVIOUS], during });
  const file = join(dir, "probe.test.mjs");
  writeFileSync(file, `import test from "node:test";
import { finishSession } from ${JSON.stringify(app)};
test("probe body passes", async (t) => {
  const session = {
    app: { name: "probe", configDir: ${JSON.stringify(dir)} },
    cleanups: [],
    eventStart: { "host-1-1.jsonl": { offset: ${started}, inode: ${JSON.stringify(String(statSync(join(dir, "logs", "host-1-1.jsonl"), { bigint: true }).ino))} } },
    expectedErrors: ${expected},
    recordings: new Set(),
    markTest: async () => null,
  };
  t.after(() => finishSession(t, session, () => {}));
});
`);
  const { NODE_TEST_CONTEXT, ...environment } = process.env;
  return spawnSync(process.execPath, ["--test", "--test-reporter=tap", file],
    { encoding: "utf8", timeout: 20000, env: { ...environment, FORCE_COLOR: "0" } });
}

const FAILED = event(3, "error", "host.test.failed", { text: "closed" });

test("an error event of the event log fails the check unless it is declared", { timeout: 30000 }, (t) => {
  const undeclared = runLoggedError(t, "[]", [FAILED, RESIZE]);
  assert.equal(undeclared.status, 1, undeclared.stdout + undeclared.stderr);
  assert.match(undeclared.stdout, /# application error: error host host\.test\.failed: \{"text":"closed"\}/);
  assert.match(undeclared.stdout, /probe: the application logged 2 errors that the check did not declare/);
  assert.doesNotMatch(undeclared.stdout, /an error of the previous check/);
  const declared = runLoggedError(t, "[/host\\.test\\.failed/, /ResizeObserver loop/]", [FAILED, RESIZE]);
  assert.equal(declared.status, 0, declared.stdout + declared.stderr);
});

test("a record event of level error fails the check as the line of the text form unless it is declared", { timeout: 30000 }, (t) => {
  const result = runLoggedError(t, "[]", [RESIZE]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /# application error: error page page: ResizeObserver loop completed/);
  assert.match(result.stdout, /probe: the application logged 1 error that the check did not declare/);
  const declared = runLoggedError(t, "[/ResizeObserver loop/]", [RESIZE]);
  assert.equal(declared.status, 0, declared.stdout + declared.stderr);
  assert.match(declared.stdout, /# application error: error page page: ResizeObserver loop completed/);
});

// A recording that the check started must be removed when the check ends. A recording folder that remains fails the
// check and is removed for the next check (AGENTS.md, docs/features.md F83). A folder that existed before the check
// started is not of that check.
test("a recording folder that the check left fails the check and is preserved", { timeout: 30000 }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "soksak-session-recording-"));
  t.after(() => rmSync(dir, { recursive: true }));
  t.after(() => rmSync(`${dir}.event-offsets`, { force: true }));
  mkdirSync(join(dir, "logs"));
  writeEventLog(dir, { before: [OPEN], during: [] });
  mkdirSync(join(dir, "logs", "captures", "earlier"), { recursive: true });
  const file = join(dir, "probe.test.mjs");
  writeFileSync(file, `import test from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { finishSession, recordingFolders } from ${JSON.stringify(app)};
test("probe body passes", async (t) => {
  const configDir = ${JSON.stringify(dir)};
  const session = { app: { name: "probe", configDir }, cleanups: [], eventStart: {}, expectedErrors: [], markTest: async () => null,
    recordingsBefore: recordingFolders(configDir), recordings: new Set(), failedRecordings: new Map() };
  mkdirSync(join(configDir, "logs", "captures", "left"));
  writeFileSync(join(configDir, "logs", "captures", "left", "frame-0001.bgra"), "x");
  t.after(() => finishSession(t, session, () => {}));
});
`);
  const { NODE_TEST_CONTEXT, ...environment } = process.env;
  const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", file],
    { encoding: "utf8", timeout: 20000, env: { ...environment, FORCE_COLOR: "0" } });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /untracked recording: .*captures\/left/);
  assert.match(result.stdout, /kept recording: .*captures\/left/);
  assert.deepEqual(readdirSync(join(dir, "logs", "captures")), ["earlier", "left"]);
});

test("a failed check preserves its capture without an opt-in", { timeout: 30000 }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "soksak-session-failed-recording-"));
  t.after(() => rmSync(dir, { recursive: true }));
  t.after(() => rmSync(`${dir}.event-offsets`, { force: true }));
  mkdirSync(join(dir, "logs"));
  writeEventLog(dir, { before: [OPEN], during: [] });
  const file = join(dir, "probe.test.mjs");
  writeFileSync(file, `import test from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Session, finishSession, recordingFolders } from ${JSON.stringify(app)};
test("probe body fails", async (t) => {
  const configDir = ${JSON.stringify(dir)};
  const captures = join(configDir, "logs", "captures");
  mkdirSync(captures, { recursive: true });
  let activeFrames;
  const client = { endpoint: { pid: process.pid }, request: async (method) => {
    if (method === "diagnostics.capture.start") {
      activeFrames = join(captures, "capture-1");
      mkdirSync(activeFrames);
      return { frames: activeFrames };
    }
    if (method === "diagnostics.capture.stop") return { frames: activeFrames };
    throw new Error("unexpected request " + method);
  } };
  const session = new Session({ name: "probe", configDir }, client);
  session.eventStart = {};
  session.expectedErrors = [];
  session.markTest = async () => null;
  session.recordingsBefore = recordingFolders(configDir);
  const recording = await session.record();
  writeFileSync(join(recording.frames, "frame-0001.bgra"), "capture evidence");
  mkdirSync(join(captures, "failed"), { recursive: true });
  writeFileSync(join(captures, "failed", "frame-0001.bgra"), "capture evidence");
  t.after(() => finishSession(t, session, () => {}));
  throw new Error("probe body failed");
});
`);
  const { NODE_TEST_CONTEXT, SOKSAK_KEEP_FAILURE_CAPTURE, ...environment } = process.env;
  const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", file],
    { encoding: "utf8", timeout: 20000, env: { ...environment, FORCE_COLOR: "0" } });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /probe body failed/);
  assert.deepEqual(readdirSync(join(dir, "logs", "captures")).sort(), ["capture-1", "failed"]);
  assert.match(result.stdout, /kept recording: .*captures\/capture-1/);
  assert.match(result.stdout, /kept recording: .*captures\/failed/);
});
