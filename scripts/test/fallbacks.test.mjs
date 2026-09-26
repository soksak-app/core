import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { findFallbacks, listFallbacks } from "../check-fallbacks.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const scan = (files) => findFallbacks(Object.keys(files), (file) => files[file]);

test("defaults and discarded errors without a stated reason are found in product code", () => {
  const found = scan({
    "packages/a/a.js": "const x = y ?? 0;\nconst z = w || \"\";\nf?.();\ntry { g(); } catch {}\np.catch(() => {});\np.catch((error) => {});\np.catch((error) => undefined);\np.catch(\n  (error) => {\n  },\n);\n",
    "packages/a/component.tsx": "const props = input ?? {};",
    "packages/a/component.jsx": "const props = input ?? {};",
    "packages/a/module.cjs": "callback?.();",
    "packages/a/module.mjs": "callback?.();",
    "packages/a/module.mts": "const value = input ?? 0;",
    "packages/a/module.cts": "const value = input ?? 0;",
    "sidecars/b/src/b.rs": "let _ = send();\nlet v = x.unwrap_or(0);\nx.ok();\n",
    "sidecars/c/src/c.go": "_ = file.Close()\nv, _ := strconv.Atoi(s)\nfunc closeIt() { _ = err }\n",
    "native/darwin/src/d.m": "@try { f(); } @catch (NSException *e) {}\n",
  });
  assert.deepEqual(found.map((item) => `${item.file}:${item.line} ${item.pattern}`), [
    "packages/a/a.js:1 nullish default", "packages/a/a.js:2 or default", "packages/a/a.js:3 optional call",
    "packages/a/a.js:4 empty catch", "packages/a/a.js:5 swallowing catch", "packages/a/a.js:6 swallowing catch",
    "packages/a/a.js:7 swallowing catch", "packages/a/a.js:8 swallowing catch",
    "packages/a/component.tsx:1 nullish default", "packages/a/component.jsx:1 nullish default",
    "packages/a/module.cjs:1 optional call", "packages/a/module.mjs:1 optional call",
    "packages/a/module.mts:1 nullish default", "packages/a/module.cts:1 nullish default",
    "sidecars/b/src/b.rs:1 discarded result", "sidecars/b/src/b.rs:2 defaulting unwrap", "sidecars/b/src/b.rs:3 discarded error",
    "sidecars/c/src/c.go:1 discarded error", "sidecars/c/src/c.go:2 ignored second result", "sidecars/c/src/c.go:3 discarded error",
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

test("the audit lists justified and unjustified defaults with their locations and reasons", () => {
  const listed = listFallbacks(["packages/a/a.js"], () => [
    "const width = card.width ?? 120; // default: the public layout contract starts at 120 points.",
    "const callback = readCallback() || fallbackCallback;",
    "selected = readSelected() || defaultSelection;",
    "const parsed = parseInput() || defaultValue;",
    "return readValue() || emptyValue;",
    "const multiline = readValue()\n  || multilineFallback;",
    "configure(readValue() || null);",
    "configure(readValue() || configuredDefault);",
    "value ??= declaredDefault;",
    "value ||= declaredDefault;",
  ].join("\n"));
  assert.deepEqual(listed.map(({ line, pattern, reason }) => ({ line, pattern, reason })), [
    { line: 1, pattern: "nullish default", reason: "default: the public layout contract starts at 120 points." },
    { line: 2, pattern: "or default", reason: null },
    { line: 3, pattern: "or default", reason: null },
    { line: 4, pattern: "or default", reason: null },
    { line: 5, pattern: "or default", reason: null },
    { line: 7, pattern: "or default", reason: null },
    { line: 8, pattern: "or default", reason: null },
    { line: 9, pattern: "or default", reason: null },
    { line: 10, pattern: "nullish assignment", reason: null },
    { line: 11, pattern: "or assignment", reason: null },
  ]);
  assert.deepEqual(findFallbacks(["packages/a/a.js"], () => [
    "const width = card.width ?? 120; // default: the public layout contract starts at 120 points.",
    "const callback = readCallback() || fallbackCallback;",
    "selected = readSelected() || defaultSelection;",
    "const parsed = parseInput() || defaultValue;",
    "return readValue() || emptyValue;",
    "const multiline = readValue()\n  || multilineFallback;",
    "configure(readValue() || null);",
    "configure(readValue() || configuredDefault);",
    "value ??= declaredDefault;",
    "value ||= declaredDefault;",
  ].join("\n")).map(({ line }) => line), [2, 3, 4, 5, 7, 8, 9, 10, 11]);
});

test("ordinary boolean OR conditions are not value fallbacks", () => {
  assert.deepEqual(scan({
    "packages/a/a.js": [
      "if (width < minimum || width > maximum) reject();",
      "const isAhead = side === 'left' || side === 'top';",
      "const aside = (id) => isPlace(id) || isRailId(id);",
      "return !!card && (!!fillOf(id) || soleSlots(card) !== null);",
      "const callback = readCallback() || fallbackCallback;",
      "button.textContent = entry.title || entry.url;",
    ].join("\n"),
  }).map(({ line, pattern }) => `${line} ${pattern}`), ["5 or default", "6 or default"]);
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

test("tests, tools, vendored code, and generated output are excluded while product frontend is scanned", () => {
  assert.deepEqual(scan({
    "packages/a/test/a.test.mjs": "const x = y ?? 0;",
    "plugins/files/ui/vendor/trees.js": "const x = y ?? 0;",
    "packages/soksak/dist/index.js": "const x = y ?? 0;",
    "scripts/check.mjs": "const x = y ?? 0;",
    "packages/a/frontend/module.ts": "const x = y ?? 0;",
    "packages/a/types.d.mts": "const x = y ?? 0;",
    "e2e/app.mjs": "const x = y ?? 0;",
    "sidecars/b/tests/b_test.rs": "let _ = f();",
  }).map(({ file, line, pattern }) => `${file}:${line} ${pattern}`), ["packages/a/frontend/module.ts:1 nullish default"]);
});

test("the repository states a reason for every default and discarded error in product code", () => {
  const output = spawnSync(process.execPath, [join(ROOT, "scripts/check-fallbacks.mjs")], { encoding: "utf8" });
  assert.equal(output.status, 0, output.stderr);
});

test("the command lists repository candidates with locations and contract reasons", () => {
  const output = spawnSync(process.execPath, [join(ROOT, "scripts/check-fallbacks.mjs"), "--list"], { encoding: "utf8" });
  assert.equal(output.status, 0, output.stderr);
  assert.match(output.stdout, /plugins\/browser\/ui\/browser\.js:\d+: or default \[reason=기본값:/);
  assert.match(output.stdout, /Fallback checks passed: \d+ occurrences listed; \d+ have a stated contract reason\./);

  const invalid = spawnSync(process.execPath, [join(ROOT, "scripts/check-fallbacks.mjs"), "--unknown"], { encoding: "utf8" });
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /usage: node scripts\/check-fallbacks\.mjs \[--list\]/);
});
