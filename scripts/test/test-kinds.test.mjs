// The name of a make target decides the kind of its checks (docs/operations/examples.md#test-kinds): a target whose name starts
// with `e2e` runs end-to-end checks, and every other target runs unit tests only. A workflow runs no `e2e` target.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
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

/**
 * Whether a script of the checkout starts an application through the `start` step of runPlan: it imports runPlan from
 * scripts/e2e-run.mjs and declares a step of the kind `start`.
 */
function startsApplications(path, readScript) {
  const source = readScript(path);
  const folder = posix.dirname(path);
  const imports = [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)]
    .some(([, names, from]) => /\brunPlan\b/.test(names) && posix.normalize(posix.join(folder, from)) === "scripts/e2e-run.mjs");
  return imports && /\bkind:\s*["']start["']/.test(source);
}

/**
 * The targets of a root Makefile that run end-to-end checks without the e2e prefix: a recipe that runs a window-check script, the
 * native end-to-end target or scripts/e2e-run.mjs, or that runs a script that starts an application through the `start` step of
 * runPlan. `readScript(path)` reads a file of the checkout.
 */
function misnamedRootTargets(makefile, readScript) {
  const endToEnd = (recipe) => /run verify|--script verify|make -C native\/darwin e2e|e2e-run\.mjs|\bgo\b.*\btest\b.*-tags[ =]"?(?:[\w ]* )?e2e\b/.test(recipe)
    || [...recipe.matchAll(/\bnode\s+(scripts\/[\w./-]+\.mjs)\b/g)].some(([, path]) => startsApplications(path, readScript));
  return rules(makefile).filter((rule) => endToEnd(rule.recipe) && !rule.target.startsWith("e2e")).map((rule) => rule.target);
}

test("a root target that starts an application through the start step of runPlan without the e2e prefix is reported", { timeout: 1000 }, () => {
  const makefile = "b3:\n\t@node scripts/fixture-b3.mjs --runs 1\n\ne2e-fixture:\n\t@node scripts/fixture-b3.mjs\n\nbuilds:\n\t@node scripts/fixture-builds.mjs\n";
  const scripts = {
    "scripts/fixture-b3.mjs": "import { runPlan } from './e2e-run.mjs';\nawait runPlan([{ name: 'start app', phase: 'prepare', kind: 'start', app: 'app', argv: [] }], { write: console.log });\n",
    "scripts/fixture-builds.mjs": "import { runPlan } from './e2e-run.mjs';\nawait runPlan([{ name: 'build', phase: 'prepare', kind: 'run', argv: ['make'] }], { write: console.log });\n",
  };
  assert.deepEqual(misnamedRootTargets(makefile, (path) => scripts[path]), ["b3"]);
});

test("a root target that runs go test with the tag e2e without the e2e prefix is reported", { timeout: 1000 }, () => {
  const makefile = 'host-go:\n\t@go -C packages/host/mygo test -tags e2e ./tests/...\n\ne2e-host-go:\n\t@go -C packages/host/mygo test -tags e2e ./tests/...\n\nunit:\n\t@go -C packages/host/mygo test -tags diagnostics ./tests/...\n';
  assert.deepEqual(misnamedRootTargets(makefile, () => ""), ["host-go"]);
});

test("the root target e2e-host-go runs the tests with the build constraint e2e of the Go library and adapters", { timeout: 1000 }, () => {
  const recipe = rules(read("Makefile")).find((rule) => rule.target === "e2e-host-go")?.recipe ?? "";
  assert.match(recipe, /-tags e2e/, "make e2e-host-go does not run the tag e2e");
  for (const library of ["packages/host/go", "packages/host/wailsv3", "packages/host/mygo"]) assert.ok(read("Makefile").includes(library), library);
});

test("the root make targets are the only entry points of the window checks", { timeout: 1000 }, () => {
  const root = rules(read("Makefile"));
  for (const target of ["e2e", "e2e-activation", "e2e-real", "e2e-person", "e2e-b3"]) assert.ok(root.some((rule) => rule.target === target), `the Makefile has no target ${target}`);
  assert.match(root.find((rule) => rule.target === "e2e").recipe, /node scripts\/e2e-run\.mjs/, "make e2e does not run scripts/e2e-run.mjs");
  assert.deepEqual(misnamedRootTargets(read("Makefile"), read), [], "a root target runs end-to-end checks without the e2e prefix");
  const scripts = Object.keys(JSON.parse(read("package.json")).scripts ?? {}).filter((name) => name.startsWith("verify"));
  assert.deepEqual(scripts, [], "the root package declares a window-check entry point");
});

// Every script of the e2e package except its unit test script drives a running application.
test("every script of the e2e package that drives an application is run by a root target with the e2e prefix", { timeout: 1000 }, () => {
  const targets = rules(read("Makefile")).filter((rule) => rule.target.startsWith("e2e"));
  const scripts = Object.keys(JSON.parse(read("e2e/package.json")).scripts).filter((name) => name !== "test");
  const runs = (recipe, name) => recipe.split(/\s+/).some((word, index, words) => word === name && ["run", "--script"].includes(words[index - 1]));
  assert.deepEqual(scripts.filter((name) => !targets.some((rule) => runs(rule.recipe, name))), [], "these scripts of e2e/package.json have no e2e target");
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
