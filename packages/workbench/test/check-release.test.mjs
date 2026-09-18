// check-release 스크립트의 find() 함수를 테스트한다.
// sp_diag_ 심볼을 담은 바이너리는 오류를 내고, 담지 않은 것은 통과한다.
import assert from "node:assert/strict";
import test from "node:test";
import { find } from "../../../scripts/check-release.mjs";

test("find() detects sp_diag_ symbols in binary content", () => {
  const errors = [];
  // sp_diag_ 심볼을 포함한 가짜 바이너리 콘텐츠
  find(errors, "fake_binary", "some binary content with sp_diag_foo symbol");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /contains a sidecar diagnostic symbol/);
  assert.match(errors[0], /sp_diag_/);
});

test("find() does not report errors for clean binary content", () => {
  const errors = [];
  // sp_diag_ 심볼을 포함하지 않은 가짜 바이너리 콘텐츠
  find(errors, "clean_binary", "some binary content without diagnostic symbols");
  assert.equal(errors.length, 0);
});

test("find() detects multiple diagnostic symbols", () => {
  const errors = [];
  // 여러 진단 심볼을 포함한 콘텐츠
  find(errors, "multi_symbols", "diagnostics.fixture and sp_diag_helper");
  assert.equal(errors.length, 2);
  assert.match(errors[0], /diagnostic method/);
  assert.match(errors[1], /sidecar diagnostic symbol/);
});

test("find() detects window capture symbols", () => {
  const errors = [];
  // sp_capture_ 심볼을 포함한 콘텐츠
  find(errors, "capture_binary", "code with sp_capture_frame function");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /window capture symbol/);
});
