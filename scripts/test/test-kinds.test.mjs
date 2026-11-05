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

test("native unit targets run no end-to-end case and native end-to-end targets start with test-app", { timeout: 1000 }, () => {
  const native = rules(read("native/darwin/Makefile"));
  const recipe = (target) => native.find((rule) => rule.target === target)?.recipe ?? "";
  assert.match(recipe("test"), /\$\(NATIVE_TEST_RUNNER\).*\$\(NATIVE_TESTS\)\s*$/m, "make -C native/darwin test does not run NATIVE_TESTS");
  assert.match(recipe("test-app"), /\$\(NATIVE_E2E_TESTS\)/, "make -C native/darwin test-app does not run NATIVE_E2E_TESTS");
  const misnamed = native.filter((rule) => NATIVE_END_TO_END.test(rule.recipe) && !rule.target.startsWith("test-app")).map((rule) => rule.target);
  assert.deepEqual(misnamed, [], "a native target runs an end-to-end case outside the test-app targets");
});

/** The entries of a make variable that lists native tests: the executable of each `name` or `name,mode` entry. */
function listedTests(makefile, variable) {
  const body = new RegExp(`^${variable} = ((?:[^\\n]*\\\\\\n)*[^\\n]*)$`, "m").exec(makefile)?.[1];
  assert.ok(body, `native/darwin/Makefile has no ${variable}`);
  return body.split(/\s+/).filter((entry) => entry && entry !== "\\").map((entry) => entry.split(",")[0]);
}

/** The source of a native test with the local test sources that it imports; a bundle entry names its executable last. */
function testSource(entry) {
  const path = `native/darwin/tests/${entry.split("/").at(-1)}.m`;
  const source = read(path);
  return [...source.matchAll(/^#import "([a-z0-9_]+\.m)"$/gm)].reduce((text, match) => text + read(`native/darwin/tests/${match[1]}`), source);
}

// A recording that starts on a real window waits for frames that the display presents, so it is an end-to-end case; an invalid
// window number is negative, an open alone prepares the target, a still capture takes one image, and a controlled sample needs
// no display.
const recordsAWindow = (source) => /sp_capture_open\(\s*[^-\s]/.test(source) && /sp_capture_start\(/.test(source);

test("a native unit test records no window of the screen", { timeout: 1000 }, () => {
  const makefile = read("native/darwin/Makefile");
  const recording = listedTests(makefile, "NATIVE_TESTS").filter((name) => recordsAWindow(testSource(name)));
  assert.deepEqual(recording, [], "these tests of NATIVE_TESTS record a window and need a display that presents frames");
  const end = listedTests(makefile, "NATIVE_E2E_TESTS");
  assert.ok(end.includes("capture_resize_test"), `NATIVE_E2E_TESTS is read as ${end.join(", ")}`);
});

test("the root make targets are the only entry points of the window checks", { timeout: 1000 }, () => {
  const root = rules(read("Makefile"));
  for (const target of ["test-app", "test-app-activation", "test-app-real", "test-app-person"]) assert.ok(root.some((rule) => rule.target === target), `the Makefile has no target ${target}`);
  assert.match(root.find((rule) => rule.target === "test-app").recipe, /node scripts\/test-app\.mjs/, "make test-app does not run scripts/test-app.mjs");
  const misnamed = root.filter((rule) => /run test-app|--script test-app|make -C native\/darwin test-app|test-app\.mjs/.test(rule.recipe) && !rule.target.startsWith("test-app"))
    .map((rule) => rule.target);
  assert.deepEqual(misnamed, [], "a root target runs end-to-end checks outside the test-app targets");
  const scripts = Object.keys(JSON.parse(read("package.json")).scripts ?? {}).filter((name) => name.startsWith("test-app"));
  assert.deepEqual(scripts, [], "the root package declares a window-check entry point");
});

// Every script of the e2e package except its unit test script drives a running application.
test("every script of the e2e package that drives an application is run by a root target of its kind", { timeout: 1000 }, () => {
  const targets = rules(read("Makefile")).filter((rule) => /^(test-app|benchmark-|repeat-app-test$)/.test(rule.target));
  const scripts = Object.keys(JSON.parse(read("e2e/package.json")).scripts).filter((name) => name !== "test");
  const runs = (recipe, name) => recipe.split(/\s+/).some((word, index, words) => word === name && ["run", "--script"].includes(words[index - 1]));
  assert.deepEqual(scripts.filter((name) => !targets.some((rule) => runs(rule.recipe, name))), [], "these scripts of e2e/package.json have no root target");
});

test("the test script of the e2e package runs only its unit test folder", { timeout: 1000 }, () => {
  assert.equal(JSON.parse(read("e2e/package.json")).scripts.test, "node --test test/");
});

test("no workflow runs a target or script of the end-to-end checks", { timeout: 1000 }, () => {
  const workflows = join(ROOT, ".github", "workflows");
  for (const file of readdirSync(workflows).filter((name) => name.endsWith(".yml"))) {
    const text = readFileSync(join(workflows, file), "utf8");
    const found = /\be2e\b|\btest-app\b/.exec(text);
    assert.equal(found, null, `${file} names ${found?.[0]}`);
  }
});
