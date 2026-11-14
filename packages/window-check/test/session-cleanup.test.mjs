// Checks that a cleanup failure of a window check is reported together with the failure of the check body.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { connect } from "@soksak/client";
import { startCasePlayer } from "@soksak/client/testing";
import { Session } from "../app.mjs";

// The tracked programs of the runs: each is a check file that node:test runs in a process of its own.
const probe = (name) => fileURLToPath(new URL(`../fixtures/session-probes/${name}`, import.meta.url));

// Runs a check file whose body and cleanup both fail in a separate node:test run. How node:test handles the cleanup
// error is the subject of the check, so the execution context of this check (NODE_TEST_CONTEXT) is not passed on.
function run() {
  const { NODE_TEST_CONTEXT, SOKSAK_RUN_ID, SOKSAK_RUN_FOLDER, ...environment } = process.env;
  return spawnSync(process.execPath, ["--test", "--test-reporter=tap", probe("cleanup-fails.mjs")],
    { encoding: "utf8", timeout: 20000, env: { ...environment, FORCE_COLOR: "0" } });
}

test("a cleanup failure is reported when the check body already failed", { timeout: 30000 }, (t) => {
  const result = run();
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /probe body failed/);
  assert.match(result.stdout, /# cleanup failed: Error: probe press stayed open/);
});

// Runs a passing check whose cleanup steps fail in the first and the third step, in a separate node:test run, and prints the
// order in which the steps ran.
function runSteps() {
  const { NODE_TEST_CONTEXT, SOKSAK_RUN_ID, SOKSAK_RUN_FOLDER, ...environment } = process.env;
  return spawnSync(process.execPath, ["--test", "--test-reporter=tap", probe("cleanup-steps.mjs")],
    { encoding: "utf8", timeout: 20000, env: { ...environment, FORCE_COLOR: "0" } });
}

test("cleanup steps run in their order after a failed step and every failure is reported", { timeout: 30000 }, (t) => {
  const result = runSteps();
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /steps ran: first second third earlier/);
  assert.match(result.stdout, /# cleanup failed: Error: probe first step failed/);
  assert.match(result.stdout, /# cleanup failed: Error: probe third step failed/);
});

// Starts the case player of the case and connects the client of the package to it. Closing the player throws when the case was not
// played to its end.
async function play(t, name) {
  const server = await startCasePlayer(name);
  t.after(() => server.close());
  const client = await connect({ configDir: server.configDir });
  t.after(() => client.close());
  return { server, client };
}

test("an input-source selection in a session tree restores the first source after baseline cleanup", { timeout: 10000 }, async (t) => {
  const { server, client } = await play(t, "window-check-input-source-restore");
  const cleanupEvents = [];
  const session = new Session({ name: "input-source", configDir: "/unused" }, client);
  session.cleanups.push(async () => {
    cleanupEvents.push("baseline");
  });

  await session.selectInputSource("korean");
  await session.on("child").selectInputSource("latin");
  for (const clean of session.cleanups.reverse()) await clean();

  assert.deepEqual(cleanupEvents, ["baseline"]);
  assert.deepEqual(server.requests.map(({ params }) => params.restore), [undefined, undefined, undefined, "person-source"],
    "the session tree captures the original source once and restores it last");
});

test("an input-source selection fails when the endpoint reports another role than the selected one", { timeout: 10000 }, async (t) => {
  const { client } = await play(t, "window-check-input-source-not-selected");
  const session = new Session({ name: "input-source", configDir: "/unused" }, client);
  await assert.rejects(() => session.selectInputSource("korean"), /input source korean was not selected \(current latin\)/);
});

test("a child-first input-source restore uses the root window after the child closes", { timeout: 10000 }, async (t) => {
  const { server, client } = await play(t, "window-check-input-source-child-closed");
  const cleanupEvents = [];
  const root = new Session({ name: "input-source", configDir: "/unused" }, client);
  root.cleanups.push(async () => cleanupEvents.push("baseline"));
  const child = root.on("child");

  await child.selectInputSource("korean");
  await child.close();
  const cleanupErrors = [];
  for (const clean of root.cleanups.reverse()) {
    try { await clean(); } catch (error) { cleanupErrors.push(error); }
  }

  assert.deepEqual(cleanupErrors, []);
  assert.deepEqual(cleanupEvents, ["baseline"]);
  assert.deepEqual(server.requests.filter(({ method }) => method === "diagnostics.input.source").map(({ params }) => params.window),
    ["child", "child", "main"]);
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

const OPEN = event(1, "info", "log.open", { schema: 3 });
const PREVIOUS = event(2, "error", "workbench.record.error", { where: "rejected", text: "an error of the previous check" }, "workbench");
const RESIZE = event(4, "error", "workbench.record.error", { where: "workbench", text: "ResizeObserver loop completed with undelivered notifications. @ wails://localhost/:0" }, "workbench");

function runLoggedError(t, expected, during) {
  const dir = mkdtempSync(join(tmpdir(), "soksak-session-log-error-"));
  t.after(() => rmSync(dir, { recursive: true }));
  mkdirSync(join(dir, "logs"));
  const started = writeEventLog(dir, { before: [OPEN, PREVIOUS], during });
  const { NODE_TEST_CONTEXT, SOKSAK_RUN_ID, SOKSAK_RUN_FOLDER, ...environment } = process.env;
  return spawnSync(process.execPath, ["--test", "--test-reporter=tap", probe("logged-error.mjs")],
    { encoding: "utf8", timeout: 20000, env: { ...environment, FORCE_COLOR: "0", SESSION_PROBE: JSON.stringify({ configDir: dir, started, expected }) } });
}

const FAILED = event(3, "error", "host.test.failed", { text: "closed" });

test("an error event of the event log fails the check unless it is declared", { timeout: 30000 }, (t) => {
  const undeclared = runLoggedError(t, [], [FAILED, RESIZE]);
  assert.equal(undeclared.status, 1, undeclared.stdout + undeclared.stderr);
  assert.match(undeclared.stdout, /# application error: error host host\.test\.failed: \{"text":"closed"\}/);
  assert.match(undeclared.stdout, /probe: the application logged 2 errors that the check did not declare/);
  assert.doesNotMatch(undeclared.stdout, /an error of the previous check/);
  const declared = runLoggedError(t, ["host\\.test\\.failed", "ResizeObserver loop"], [FAILED, RESIZE]);
  assert.equal(declared.status, 0, declared.stdout + declared.stderr);
});

test("a record event of level error fails the check as the line of the text form unless it is declared", { timeout: 30000 }, (t) => {
  const result = runLoggedError(t, [], [RESIZE]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /# application error: error workbench workbench: ResizeObserver loop completed/);
  assert.match(result.stdout, /probe: the application logged 1 error that the check did not declare/);
  const declared = runLoggedError(t, ["ResizeObserver loop"], [RESIZE]);
  assert.equal(declared.status, 0, declared.stdout + declared.stderr);
  assert.match(declared.stdout, /# application error: error workbench workbench: ResizeObserver loop completed/);
});

// A recording that the check started must be removed when the check ends. A recording folder that remains fails the
// check and is removed for the next check (AGENTS.md, docs/features.md F83). A folder that existed before the check
// started is not of that check.
test("a recording folder that the check left fails the check and is preserved", { timeout: 30000 }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "soksak-session-recording-"));
  t.after(() => rmSync(dir, { recursive: true }));
  mkdirSync(join(dir, "logs"));
  writeEventLog(dir, { before: [OPEN], during: [] });
  mkdirSync(join(dir, "logs", "captures", "earlier"), { recursive: true });
  const { NODE_TEST_CONTEXT, SOKSAK_RUN_ID, SOKSAK_RUN_FOLDER, ...environment } = process.env;
  const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", probe("left-recording.mjs")],
    { encoding: "utf8", timeout: 20000, env: { ...environment, FORCE_COLOR: "0", SESSION_PROBE: JSON.stringify({ configDir: dir }) } });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /untracked recording: .*captures\/left/);
  assert.match(result.stdout, /kept recording: .*captures\/left/);
  assert.deepEqual(readdirSync(join(dir, "logs", "captures")), ["earlier", "left"]);
});

test("a failed check preserves its capture without an opt-in", { timeout: 30000 }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "soksak-session-failed-recording-"));
  t.after(() => rmSync(dir, { recursive: true }));
  mkdirSync(join(dir, "logs"));
  writeEventLog(dir, { before: [OPEN], during: [] });
  const { NODE_TEST_CONTEXT, SOKSAK_KEEP_FAILURE_CAPTURE, SOKSAK_RUN_ID, SOKSAK_RUN_FOLDER, ...environment } = process.env;
  const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", probe("failed-capture.mjs")],
    { encoding: "utf8", timeout: 20000, env: { ...environment, FORCE_COLOR: "0", SESSION_PROBE: JSON.stringify({ configDir: dir }) } });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /probe body failed/);
  assert.deepEqual(readdirSync(join(dir, "logs", "captures")).sort(), ["capture-1", "failed"]);
  assert.match(result.stdout, /kept recording: .*captures\/capture-1/);
  assert.match(result.stdout, /kept recording: .*captures\/failed/);
});
