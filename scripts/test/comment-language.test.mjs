import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { comments, findKoreanComments, workingTreeFiles } from "../check-comment-language.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const scan = (files) => findKoreanComments(Object.keys(files), (file) => files[file])
  .map((item) => `${item.file}:${item.line}`);

test("comment lines that hold Hangul are reported in every source language", () => {
  assert.deepEqual(scan({
    "packages/a/a.js": "// 배치를 기다린다.\nconst x = 1; // 값을 둔다\n/* 블록 주석\n * 이어진다 */\n",
    "native/darwin/src/a.m": "// 요청 전에 보인 frame\n",
    "packages/host/x/src/a.go": "// host 가 창을 갖는다\n",
    "packages/host/y/src/a.rs": "/// 창 목록을 돌려준다\n",
    "Makefile": "# 라이브러리를 만든다\nall:\n",
    "packages/a/index.html": "<!-- 주 페이지 -->\n<script>\n// 페이지를 실행한다\n</script>\n",
    "packages/a/a.css": "/* 카드 배치 */\n",
    "packages/soksak/src/a.ts": "// 라이브러리 주석\n",
  }), [
    "packages/a/a.js:1", "packages/a/a.js:2", "packages/a/a.js:3", "packages/a/a.js:4",
    "native/darwin/src/a.m:1", "packages/host/x/src/a.go:1", "packages/host/y/src/a.rs:1", "Makefile:1",
    "packages/a/index.html:1", "packages/a/index.html:3", "packages/a/a.css:1", "packages/soksak/src/a.ts:1",
  ]);
});

test("English comments, Hangul outside comments and generated folders are not reported", () => {
  assert.deepEqual(scan({
    "packages/a/a.js": "// Waits for the layout (core.grid).\nconst label = \"// 설정\"; // the label\n",
    "packages/a/b.js": "const more = `multi\n// 문자열 안이다\n`;\n",
    "scripts/run.sh": "#!/bin/sh\necho \"# 주석이 아니다\"\n",
    "packages/a/dist/a.js": "// 생성된 파일\n",
    "packages/a/node_modules/x/a.js": "// 의존성\n",
  }), []);
});

test("hook files and extensionless scripts are checked, and other extensionless files are not", () => {
  assert.deepEqual(scan({
    ".githooks/commit-msg": "#!/bin/sh\n# 커밋 메시지 형식을 검사한다.\nexec node check.js \"$1\"\n",
    "scripts/run-tool": "#!/bin/sh\n# 도구를 실행한다\n",
    "docs/NOTICE": "Notice text 한글\n# 한글 제목\n",
  }), [".githooks/commit-msg:2", "scripts/run-tool:2"]);
});

test("a Rust lifetime does not start a string", () => {
  assert.deepEqual(comments("a.rs", "fn f<'a>(x: &'a str) {} // returns the slice\n").map((item) => item.line), [1]);
});

test("a cgo preamble is C code, and only its C comments are checked", () => {
  assert.deepEqual(scan({
    "packages/host/x/src/platform/darwin/a.go": "package darwin\n\n/*\n#cgo CFLAGS: -x objective-c\nextern void soksak_ready(void);\n// 창을 돌려준다\nstatic void call(void) { soksak_ready(); }\n*/\nimport \"C\"\n",
  }), ["packages/host/x/src/platform/darwin/a.go:6"]);
});

test("the check reads the working tree: new files are read and deleted files are not", () => {
  const listed = { "--deleted": ["a/removed.rs"], "--cached --others --exclude-standard": ["a/kept.go", "a/removed.rs", "a/new.js"] };
  assert.deepEqual(workingTreeFiles((...args) => listed[args.join(" ")]), ["a/kept.go", "a/new.js"]);
});

test("a backslash before a line feed in a string keeps the line numbers of the comments after it", () => {
  assert.deepEqual(scan({
    "packages/a/a.rs": "let s = \"one \\\ntwo \\\nthree\";\n// 주석\n",
  }), ["packages/a/a.rs:4"]);
});

test("a regular expression literal with a quote does not hide the comments after it", () => {
  assert.deepEqual(scan({
    "packages/a/a.js": "const quote = /\"/;\n// 주석\nconst pair = x.replace(/[`']/g, \"\"); // 둘째\n",
  }), ["packages/a/a.js:2", "packages/a/a.js:3"]);
  assert.deepEqual(scan({ "packages/a/b.js": "const ratio = a / b; // fine\nconst text = \"it's\"; // fine\n" }), []);
});

test("no tracked source file of the repository holds a Hangul comment", () => {
  const files = workingTreeFiles((...args) => execFileSync("git", ["ls-files", ...args], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean));
  const found = findKoreanComments(files, (file) => readFileSync(join(ROOT, file), "utf8")).map((item) => `${item.file}:${item.line} ${item.text}`);
  assert.deepEqual(found, []);
});
