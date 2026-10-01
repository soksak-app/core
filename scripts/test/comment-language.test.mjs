import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { comments, findEnglishComments } from "../check-comment-language.mjs";

const scan = (files) => findEnglishComments(Object.keys(files), (file) => files[file])
  .map((item) => `${item.file}:${item.line}`);

test("English comment sentences outside packages/soksak are reported", () => {
  assert.deepEqual(scan({
    "packages/a/a.js": "// Wait for the layout.\nconst x = 1; // keep this value\n/* Block comment here\n * continues on */\n",
    "native/darwin/src/a.m": "// Frames displayed before the request\n",
    "packages/host/x/src/a.go": "// Host owns the window\n",
    "packages/host/y/src/a.rs": "/// Returns the window list\n",
    "Makefile": "# builds the library\nall:\n",
    "packages/a/index.html": "<!-- the main page -->\n<script>\n// runs the page\n</script>\n",
    "packages/a/a.css": "/* card layout rules */\n",
  }), [
    "packages/a/a.js:1", "packages/a/a.js:2", "packages/a/a.js:3", "packages/a/a.js:4",
    "native/darwin/src/a.m:1", "packages/host/x/src/a.go:1", "packages/host/y/src/a.rs:1", "Makefile:1",
    "packages/a/index.html:1", "packages/a/index.html:3", "packages/a/a.css:1",
  ]);
});

test("Korean comments, directives, identifiers and other places are not reported", () => {
  assert.deepEqual(scan({
    "packages/a/a.js": "// 배치를 기다린다(core.grid).\n// eslint-disable-next-line no-console\nconst url = \"http://a.b/c\"; // core.grid\n",
    "packages/host/x/src/a.go": "//go:build diagnostics\n//export sp_window_ready\n// contract: endpoint.transport.invalid-json-closes\n",
    "packages/soksak/src/a.ts": "// Comments in the library are English.\n",
    "plugins/files/ui/vendor/trees.js": "// third party code here\n",
    "packages/a/b.js": "const text = \"see // not a comment here\";\nconst more = `multi\n// still a string here\n`;\n",
    "scripts/run.sh": "#!/bin/sh\necho \"# not a comment here\"\n",
    "native/darwin/src/a.h": "// {frame, content, scale: {x, y}}\n// `status.next` `core.grid`\n// <script src=\"./x\">\n",
    "sidecars/a/src/a.rs": "/// 사용법:\n/// ```\n/// let mut composer = State::new();\n/// ```\n",
    "scripts/check-a.mjs": "// 경계를 검사한다. 다음처럼 실행한다.\n//   node scripts/check-a.mjs\n//   status  {name, description}\n",
  }), []);
});

test("a Rust lifetime does not start a string", () => {
  assert.deepEqual(comments("a.rs", "fn f<'a>(x: &'a str) {} // returns the slice\n").map((item) => item.line), [1]);
});

test("a cgo preamble is C code, and only its C comments are checked", () => {
  assert.deepEqual(scan({
    "packages/host/x/src/platform/darwin/a.go": "package darwin\n\n/*\n#cgo CFLAGS: -x objective-c\nextern void soksak_ready(void);\n// returns the window here\nstatic void call(void) { soksak_ready(); }\n*/\nimport \"C\"\n",
  }), ["packages/host/x/src/platform/darwin/a.go:6"]);
});

test("the repository has no English comment outside packages/soksak", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
  const result = spawnSync(process.execPath, ["scripts/check-comment-language.mjs"], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});
