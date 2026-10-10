// 창 검사의 정리 실패가 검사 본문의 실패와 함께 보고되는지 검사한다.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const app = new URL("../app.mjs", import.meta.url).href;

// 검사 본문과 정리가 모두 실패하는 검사 파일을 별도의 node:test 실행으로 돌린다. node:test 가 정리 오류를 다루는
// 방식이 검사 대상이므로 이 검사의 실행 문맥(NODE_TEST_CONTEXT)은 넘기지 않는다.
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

const OPEN = event(1, "info", "log.open", { schema: 1 });
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
    eventStart: { "host-1-1.jsonl": ${started} },
    expectedErrors: ${expected},
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

// 검사가 시작한 녹화는 검사가 끝날 때 지워져 있어야 한다. 남은 녹화 폴더는 검사의 실패이고, 다음 검사를 위해 지운다
// (AGENTS.md, docs/features.md F83). 검사가 시작하기 전부터 있던 폴더는 그 검사의 것이 아니다.
test("a recording folder that the check left fails the check and is removed", { timeout: 30000 }, (t) => {
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
  const session = { app: { name: "probe", configDir }, cleanups: [], eventStart: {}, expectedErrors: [],
    recordingsBefore: recordingFolders(configDir) };
  mkdirSync(join(configDir, "logs", "captures", "left"));
  writeFileSync(join(configDir, "logs", "captures", "left", "frame-0001.bgra"), "x");
  t.after(() => finishSession(t, session, () => {}));
});
`);
  const { NODE_TEST_CONTEXT, ...environment } = process.env;
  const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", file],
    { encoding: "utf8", timeout: 20000, env: { ...environment, FORCE_COLOR: "0" } });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /probe: the check left 1 recording: .*captures\/left/);
  assert.deepEqual(readdirSync(join(dir, "logs", "captures")), ["earlier"]);
});
