// 창 검사의 정리 실패가 검사 본문의 실패와 함께 보고되는지 검사한다.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    pageErrorStart: null,
    expectedPageErrors: [],
    get: async () => null,
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

// 본문이 통과해도 검사 동안 page 가 새로 보인 애플리케이션 오류는 검사의 실패다. 검사가 선언한 오류는 실패가
// 아니다(G1.4-111).
function runPageError(t, expected) {
  const dir = mkdtempSync(join(tmpdir(), "soksak-session-page-error-"));
  t.after(() => rmSync(dir, { recursive: true }));
  const file = join(dir, "probe.test.mjs");
  writeFileSync(file, `import test from "node:test";
import { finishSession } from ${JSON.stringify(app)};
test("probe body passes", async (t) => {
  const session = {
    app: { name: "probe" },
    cleanups: [],
    pageErrorStart: null,
    expectedPageErrors: ${expected},
    get: async (name) => name === "core.page.error" ? "rejected: argument request.value is missing" : null,
  };
  t.after(() => finishSession(t, session, () => {}));
});
`);
  const { NODE_TEST_CONTEXT, ...environment } = process.env;
  return spawnSync(process.execPath, ["--test", "--test-reporter=tap", file],
    { encoding: "utf8", timeout: 20000, env: { ...environment, FORCE_COLOR: "0" } });
}

test("a page error that the check does not declare fails the check", { timeout: 30000 }, (t) => {
  const result = runPageError(t, "[]");
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /probe: the page showed an application error that the check did not declare: rejected: argument request\.value is missing/);
});

test("a page error that the check declares does not fail the check", { timeout: 30000 }, (t) => {
  const result = runPageError(t, "[/argument request\\.value is missing/]");
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
