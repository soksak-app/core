// The name of a make target decides the kind of its checks (docs/operations/examples.md#test-kinds): a target whose name starts
// with `e2e` runs end-to-end checks, and every other target runs unit tests only. A workflow runs no `e2e` target.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const read = (path) => readFileSync(join(ROOT, path), "utf8");

/** The rules of a Makefile as `{target, recipe}`: a rule line `name: …` and the tab-indented recipe lines that follow it. */
function rules(text) {
  const found = [];
  for (const match of text.matchAll(/^([a-zA-Z0-9_.-]+):(?!=)[^\n]*\n((?:\t[^\n]*\n)*)/gm)) found.push({ target: match[1], recipe: match[2] });
  return found;
}

// A native test case needs the activation of the application or the frontmost state of the session when the runner passes it
// one of these modes, and the presentation tests need a display that presents frames.
const NATIVE_END_TO_END = /\$\(NATIVE_E2E_TESTS\)|,--activation|,--backspace|--frontmost|,--baseline/;

test("native unit targets run no end-to-end case and native end-to-end targets carry the e2e prefix", { timeout: 1000 }, () => {
  const native = rules(read("native/darwin/Makefile"));
  const recipe = (target) => native.find((rule) => rule.target === target)?.recipe ?? "";
  assert.match(recipe("test"), /\$\(NATIVE_TEST_RUNNER\).*\$\(NATIVE_TESTS\)\s*$/m, "make -C native/darwin test does not run NATIVE_TESTS");
  assert.match(recipe("e2e"), /\$\(NATIVE_E2E_TESTS\)/, "make -C native/darwin e2e does not run NATIVE_E2E_TESTS");
  const misnamed = native.filter((rule) => NATIVE_END_TO_END.test(rule.recipe) && !rule.target.startsWith("e2e")).map((rule) => rule.target);
  assert.deepEqual(misnamed, [], "a native target runs an end-to-end case without the e2e prefix");
});

test("the root make targets are the only entry points of the window checks", { timeout: 1000 }, () => {
  const root = rules(read("Makefile"));
  for (const target of ["e2e", "e2e-activation", "e2e-real", "e2e-person"]) assert.ok(root.some((rule) => rule.target === target), `the Makefile has no target ${target}`);
  assert.match(root.find((rule) => rule.target === "e2e").recipe, /node scripts\/e2e-run\.mjs/, "make e2e does not run scripts/e2e-run.mjs");
  const misnamed = root.filter((rule) => /run verify|--script verify|make -C native\/darwin e2e|e2e-run\.mjs/.test(rule.recipe) && !rule.target.startsWith("e2e"))
    .map((rule) => rule.target);
  assert.deepEqual(misnamed, [], "a root target runs end-to-end checks without the e2e prefix");
  const scripts = Object.keys(JSON.parse(read("package.json")).scripts ?? {}).filter((name) => name.startsWith("verify"));
  assert.deepEqual(scripts, [], "the root package declares a window-check entry point");
});

test("the test script of the e2e package runs only its unit test folder", { timeout: 1000 }, () => {
  assert.equal(JSON.parse(read("e2e/package.json")).scripts.test, "node --test test/");
});

test("no workflow runs a target or script of the end-to-end checks", { timeout: 1000 }, () => {
  const workflows = join(ROOT, ".github", "workflows");
  for (const file of readdirSync(workflows).filter((name) => name.endsWith(".yml"))) {
    const text = readFileSync(join(workflows, file), "utf8");
    const found = /\be2e\b|verify:|run verify\b|--script verify\b/.exec(text);
    assert.equal(found, null, `${file} names ${found?.[0]}`);
  }
});
