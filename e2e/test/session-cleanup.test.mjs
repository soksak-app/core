// 창 검사의 정리 실패가 검사 본문의 실패와 함께 보고되는지 검사한다.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    logStart: 0,
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

// 본문이 통과해도 검사 동안 애플리케이션 로그에 쓰인 오류 줄은 검사의 실패다. reload 가 문서에서 지운 오류도
// 로그에는 남는다. 검사가 시작하기 전의 줄은 그 검사의 것이 아니고, 검사가 선언한 오류는 실패가 아니다(F31).
function runLoggedError(t, expected) {
  const dir = mkdtempSync(join(tmpdir(), "soksak-session-log-error-"));
  // 검사는 읽은 위치를 설정 폴더 옆의 파일에 남긴다.
  t.after(() => rmSync(`${dir}.log-offset`, { force: true }));
  t.after(() => rmSync(dir, { recursive: true }));
  mkdirSync(join(dir, "logs"));
  const before = "error: rejected: an error of the previous check\n";
  writeFileSync(join(dir, "logs", "application.log"), before +
    "verify: 18 pass\nerror: ResizeObserver loop completed with undelivered notifications. @ wails://localhost/:0\n");
  const file = join(dir, "probe.test.mjs");
  writeFileSync(file, `import test from "node:test";
import { finishSession } from ${JSON.stringify(app)};
test("probe body passes", async (t) => {
  const session = {
    app: { name: "probe", configDir: ${JSON.stringify(dir)} },
    cleanups: [],
    logStart: ${Buffer.byteLength(before)},
    expectedErrors: ${expected},
  };
  t.after(() => finishSession(t, session, () => {}));
});
`);
  const { NODE_TEST_CONTEXT, ...environment } = process.env;
  return spawnSync(process.execPath, ["--test", "--test-reporter=tap", file],
    { encoding: "utf8", timeout: 20000, env: { ...environment, FORCE_COLOR: "0" } });
}

test("an error line that the application logged during the check fails the check unless it is declared", { timeout: 30000 }, (t) => {
  const result = runLoggedError(t, "[]");
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /# application error: error: ResizeObserver loop completed/);
  assert.match(result.stdout, /probe: the application logged 1 error that the check did not declare/);
  assert.doesNotMatch(result.stdout, /an error of the previous check/);
});

test("an error line that the check declares does not fail the check", { timeout: 30000 }, (t) => {
  const result = runLoggedError(t, "[/ResizeObserver loop/]");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /# application error: error: ResizeObserver loop completed/);
});
