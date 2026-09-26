import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { findFallbacks } from "../check-fallbacks.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const scan = (files) => findFallbacks(Object.keys(files), (file) => files[file]);

test("defaults and discarded errors without a stated reason are found in product code", () => {
  const found = scan({
    "packages/a/a.js": "const x = y ?? 0;\nconst z = w || \"\";\nf?.();\ntry { g(); } catch {}\np.catch(() => {});\n",
    "sidecars/b/src/b.rs": "let _ = send();\nlet v = x.unwrap_or(0);\nx.ok();\n",
    "sidecars/c/src/c.go": "_ = file.Close()\nv, _ := strconv.Atoi(s)\n",
    "native/darwin/src/d.m": "@try { f(); } @catch (NSException *e) {}\n",
  });
  assert.deepEqual(found.map((item) => `${item.file}:${item.line} ${item.pattern}`), [
    "packages/a/a.js:1 nullish default", "packages/a/a.js:2 or default", "packages/a/a.js:3 optional call",
    "packages/a/a.js:4 empty catch", "packages/a/a.js:5 swallowing catch",
    "sidecars/b/src/b.rs:1 discarded result", "sidecars/b/src/b.rs:2 defaulting unwrap", "sidecars/b/src/b.rs:3 discarded error",
    "sidecars/c/src/c.go:1 discarded error", "sidecars/c/src/c.go:2 ignored second result",
    "native/darwin/src/d.m:1 caught exception",
  ]);
});

test("a reason on the line or in the comment block above accepts a default", () => {
  assert.deepEqual(scan({
    "packages/a/a.js": [
      "// 기본값: 알림을 받는 쪽이 없으면 부르지 않는다.",
      "notify?.();",
      "const size = options.size ?? 13; // 기본값: 명세의 글자 크기 기본값은 13이다.",
      "// default: an absent width means the declared minimum.",
      "// (continued comment)",
      "const w = card.width ?? min;",
    ].join("\n"),
  }), []);
});

test("a short or missing reason does not accept a default", () => {
  const found = scan({ "packages/a/a.js": "// 기본값: 그냥\nconst x = y ?? 0;\n// 다른 설명\nconst z = y ?? 1;\n" });
  assert.deepEqual(found.map((item) => item.line), [2, 4]);
});

test("variable defaults and multiline empty catches are audited", () => {
  const found = scan({
    "packages/a/a.js": "const x = value || fallback;\ntry { run(); } catch (error) {\n  \n}\n",
  });
  assert.deepEqual(found.map((item) => `${item.line} ${item.pattern}`), ["1 or default", "2 empty catch"]);
});

test("tests, tools, vendored code, and generated output are not product code", () => {
  assert.deepEqual(scan({
    "packages/a/test/a.test.mjs": "const x = y ?? 0;",
    "plugins/files/ui/vendor/trees.js": "const x = y ?? 0;",
    "packages/soksak/dist/index.js": "const x = y ?? 0;",
    "scripts/check.mjs": "const x = y ?? 0;",
    "e2e/app.mjs": "const x = y ?? 0;",
    "sidecars/b/tests/b_test.rs": "let _ = f();",
  }), []);
});

test("the repository states a reason for every default and discarded error in product code", () => {
  const output = spawnSync(process.execPath, [join(ROOT, "scripts/check-fallbacks.mjs")], { encoding: "utf8" });
  assert.equal(output.status, 0, output.stderr);
});
