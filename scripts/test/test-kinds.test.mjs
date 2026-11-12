// The name of a make target decides the kind of its checks (docs/operations/examples.md#test-kinds): a target whose name starts
// with `test-app` or `benchmark-` runs end-to-end checks, and every other target runs unit tests only. A workflow runs no such target.
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

// The functions of a source that start a recording: sp_capture_start and each function whose body calls one of them.
function recordingCalls(source) {
  const names = new Set(["sp_capture_start"]);
  const bodies = [...source.matchAll(/^static [^\n(]*?\b(\w+)\(([^)]*)\) \{\n([\s\S]*?)^\}/gm)];
  for (let grown = true; grown; ) {
    grown = false;
    for (const [, name, , body] of bodies) {
      if (names.has(name) || ![...names].some((called) => new RegExp(`\\b${called}\\(`).test(body))) continue;
      names.add(name);
      grown = true;
    }
  }
  return names;
}

/**
 * Whether every recording of the main function of source takes its images from a stand-in of the window server: main sets
 * captureLookup to a lookup that answers CGWindowListCreateImageFromArray with a function of the test whatever the state, and
 * every call that starts a recording comes after that and before captureLookup is the system lookup again. A stand-in that
 * answers only in some states leaves the other recordings on the window server.
 */
export function controlledRecordings(source) {
  const standIns = new Set([...source.matchAll(
    /^static void \*(\w+)\(void \*handle, const char \*name\) \{\n\s*return strcmp\(name, "CGWindowListCreateImageFromArray"\) == 0 \? \(void \*\)\w+ : dlsym\(handle, name\);\n\}/gm,
  )].map((match) => match[1]));
  const main = /^int main\([^)]*\) \{([\s\S]*)$/m.exec(source)?.[1] ?? "";
  const calls = [...recordingCalls(source)].filter((name) => name !== "main");
  const starts = calls.flatMap((name) => [...main.matchAll(new RegExp(`\\b${name}\\(`, "g"))].map((match) => match.index));
  if (standIns.size === 0 || starts.length === 0) return false;
  const swaps = [...main.matchAll(/\bcaptureLookup = (\w+);/g)].map((match) => ({ at: match.index, standIn: standIns.has(match[1]) }));
  return starts.every((at) => {
    const before = swaps.filter((swap) => swap.at < at).at(-1);
    return before !== undefined && before.standIn;
  });
}

// A recording that starts on a real window waits for frames that the display presents, so it is an end-to-end case; an invalid
// window number is negative, an open alone prepares the target, a still capture takes one image, and a recording whose images
// all come from a stand-in of the window server is a controlled sample that needs no display.
const recordsAWindow = (source) =>
  /sp_capture_open\(\s*[^-\s]/.test(source) && /sp_capture_start\(/.test(source) && !controlledRecordings(source);

test("a recording is controlled only while an unconditional stand-in gives every image", { timeout: 1000 }, () => {
  const standIn = 'static void *lookupTest(void *handle, const char *name) {\n    return strcmp(name, "CGWindowListCreateImageFromArray") == 0 ? (void *)testImage : dlsym(handle, name);\n}\n';
  const failing = 'static void *lookupFailing(void *handle, const char *name) {\n    if (fail && strcmp(name, "CGWindowListCreateImageFromArray") == 0) return (void *)noImage;\n    return dlsym(handle, name);\n}\n';
  const helper = "static bool record(NSWindow *window) {\n    return sp_capture_open(window.windowNumber, false, NULL) && sp_capture_start(\"d\", 10, 0, 4, 1, NULL);\n}\n";
  assert.equal(controlledRecordings(`${standIn}${helper}int main(void) {\n    captureLookup = lookupTest;\n    record(window);\n    captureLookup = dlsym;\n}\n`), true,
    "a helper recording between the stand-in and the system lookup is controlled");
  assert.equal(controlledRecordings(`${standIn}${helper}int main(void) {\n    captureLookup = lookupTest;\n    record(window);\n    captureLookup = dlsym;\n    record(window);\n}\n`), false,
    "a recording after the system lookup is restored records the screen");
  assert.equal(controlledRecordings(`${failing}${helper}int main(void) {\n    captureLookup = lookupFailing;\n    record(window);\n}\n`), false,
    "a stand-in that answers only in some states is not controlled");
  assert.equal(controlledRecordings(`${standIn}${helper}int main(void) {\n    record(window);\n    captureLookup = lookupTest;\n}\n`), false,
    "a recording before the stand-in records the screen");
});

test("a native unit test records no window of the screen", { timeout: 1000 }, () => {
  const makefile = read("native/darwin/Makefile");
  const recording = listedTests(makefile, "NATIVE_TESTS").filter((name) => recordsAWindow(testSource(name)));
  assert.deepEqual(recording, [], "these tests of NATIVE_TESTS record a window and need a display that presents frames");
  const end = listedTests(makefile, "NATIVE_E2E_TESTS");
  assert.ok(end.includes("capture_resize_test"), `NATIVE_E2E_TESTS is read as ${end.join(", ")}`);
});

/**
 * Whether a script of the checkout starts an application through the `start` step of runPlan: it imports runPlan from
 * scripts/test-app.mjs and declares a step of the kind `start`.
 */
function startsApplications(path, readScript) {
  const source = readScript(path);
  const folder = posix.dirname(path);
  const imports = [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)]
    .some(([, names, from]) => /\brunPlan\b/.test(names) && posix.normalize(posix.join(folder, from)) === "scripts/test-app.mjs");
  return imports && /\bkind:\s*["']start["']/.test(source);
}

/**
 * The targets of a root Makefile that run end-to-end checks outside the test-app and benchmark targets: a recipe that runs a window-check script, the
 * native end-to-end target or scripts/test-app.mjs, or that runs a script that starts an application through the `start` step of
 * runPlan. `readScript(path)` reads a file of the checkout.
 */
function misnamedRootTargets(makefile, readScript) {
  const goRunnerUsesE2E = (recipe) => [...recipe.matchAll(/\bnode\s+scripts\/go-tests\.mjs\b([^\n]*)/g)].some(([, args]) =>
    [...args.matchAll(/(?:^|\s)--tags(?:=|\s+)("[^"\n]*"|'[^'\n]*'|[^\s]+)/g)].some(([, value]) =>
      value.replace(/^['"]|['"]$/g, "").split(/[\s,]+/).includes("e2e")));
  const endToEnd = (recipe) => /run test-app|--script test-app|make -C native\/darwin test-app|test-app\.mjs|\bgo\b.*\btest\b.*-tags[ =]"?(?:[\w ]* )?e2e\b/.test(recipe)
    || goRunnerUsesE2E(recipe)
    || [...recipe.matchAll(/\bnode\s+(scripts\/[\w./-]+\.mjs)\b/g)].some(([, path]) => startsApplications(path, readScript));
  return rules(makefile).filter((rule) => endToEnd(rule.recipe) && !/^(?:test-app|benchmark-)/.test(rule.target)).map((rule) => rule.target);
}

test("a root target that starts an application through the start step of runPlan outside the test-app and benchmark targets is reported", { timeout: 1000 }, () => {
  const makefile = "b3:\n\t@node scripts/fixture-b3.mjs --runs 1\n\ntest-app-fixture:\n\t@node scripts/fixture-b3.mjs\n\nbuilds:\n\t@node scripts/fixture-builds.mjs\n";
  const scripts = {
    "scripts/fixture-b3.mjs": "import { runPlan } from './test-app.mjs';\nawait runPlan([{ name: 'start app', phase: 'prepare', kind: 'start', app: 'app', argv: [] }], { write: console.log });\n",
    "scripts/fixture-builds.mjs": "import { runPlan } from './test-app.mjs';\nawait runPlan([{ name: 'build', phase: 'prepare', kind: 'run', argv: ['make'] }], { write: console.log });\n",
  };
  assert.deepEqual(misnamedRootTargets(makefile, (path) => scripts[path]), ["b3"]);
});

test("a root target that runs go test with the tag e2e outside the test-app and benchmark targets is reported", { timeout: 1000 }, () => {
  const makefile = 'host-go:\n\t@go -C packages/host/mygo test -tags e2e ./tests/...\n\ntest-app-host-go:\n\t@go -C packages/host/mygo test -tags e2e ./tests/...\n\nunit:\n\t@go -C packages/host/mygo test -tags diagnostics ./tests/...\n';
  assert.deepEqual(misnamedRootTargets(makefile, () => ""), ["host-go"]);
});

test("the maintained Go runner cannot hide e2e tags inside a unit-named target", { timeout: 1000 }, () => {
  const invocation = "CGO_ENABLED=0 $(call go-env) node scripts/go-tests.mjs --package './packages/host/mygo/tests/...' --tags 'e2e diagnostics mygo' --test '^TestE2E' --count 1 --timeout $(TEST_TIMEOUT)";
  const makefile = `host-go:\n\t@${invocation}\n\ntest-app-host-go:\n\t@${invocation}\n\nunit:\n\t@node scripts/go-tests.mjs --package './packages/host/mygo/tests/...' --tags 'diagnostics mygo' --test '^TestUnit' --count 1\n`;
  assert.deepEqual(misnamedRootTargets(makefile, () => ""), ["host-go"]);
});

// Inventory TestE2E owner paths from the source naming/build-constraint convention.
// Go's selected build graph and runtime test listing remain the execution authority.
function goEndToEndDeclarations(files) {
  const declarations = [];
  for (const [file, source] of files) {
    for (const [, name] of source.matchAll(/^func\s+(TestE2E[^\s(]*)\s*\(/gm)) {
      assert.match(source, /^\/\/go:build\s+[^\n]*\be2e\b/m, `${file}: ${name} must carry the e2e build constraint`);
      declarations.push({ file, name, owner: posix.dirname(file) });
    }
  }
  return declarations;
}

function unmappedGoEndToEndTests(files, patterns) {
  return goEndToEndDeclarations(files).filter(({ owner }) => !patterns.some((pattern) => {
    const selected = pattern.replace(/^\.\//, "");
    const subtree = selected.endsWith("/...") ? selected.slice(0, -4) : undefined;
    return subtree === undefined ? owner === selected : owner === subtree || owner.startsWith(subtree + "/");
  })).map(({ file, name }) => `${file}: ${name}`);
}

function goHostTestSources() {
  const files = new Map();
  function visit(folder) {
    for (const entry of readdirSync(join(ROOT, folder), { withFileTypes: true })) {
      const path = posix.join(folder, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith("_test.go")) files.set(path, read(path));
    }
  }
  for (const host of ["go", "wailsv3", "mygo"]) visit(`packages/host/${host}`);
  return files;
}

test("the root Go E2E target selects every actual registered test through the cgo-free maintained runner", { timeout: 1000 }, () => {
  const makefile = read("Makefile");
  const recipe = rules(makefile).find((rule) => rule.target === "test-app-host-go")?.recipe ?? "";
  const patterns = [...recipe.matchAll(/--package\s+'([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(patterns, ["./packages/host/mygo/tests/..."], "declare the actual E2E owner instead of zero-match host loops");
  const sources = goHostTestSources();
  assert.ok(goEndToEndDeclarations(sources).length > 0, "the target has no actual registered Go E2E tests");
  assert.deepEqual(unmappedGoEndToEndTests(sources, patterns), [], "a registered Go E2E test has no maintained target");
  assert.match(makefile, /^test-app-host-go:[^\n]*\bbuild-native-mygo\b[^\n]*\bbuild-native-tests\b/m);
  assert.match(recipe, /CGO_ENABLED=0/);
  assert.match(recipe, /node scripts\/go-tests\.mjs/);
  assert.match(recipe, /--tags 'e2e diagnostics mygo'/);
  assert.match(recipe, /--test '\^TestE2E'/);
  assert.match(recipe, /--count 1/);
  assert.match(recipe, /--timeout \$\(TEST_TIMEOUT\)/);
  assert.match(recipe, /--ldflags=['"]\$\(GO_INTERNAL_LINK\)['"]/, "CGO0 E2E binaries must declare the same internal-linker macOS minimum");
  assert.doesNotMatch(recipe, /(?:^|\s)go(?:\s+-C\s+\S+)?\s+test\b|-extldflags|GO_LINK|GO_ENV|for package|SOKSAK_NATIVE_(?:TEST_)?LIBRARY/,
    "the target must use the selected runner environment and declared artifacts");
  assert.doesNotMatch(makefile, /^E2E_GO_PACKAGES\s*=/m, "obsolete zero-match package loops remain declared");
});

test("a future shared or Wails Go E2E test fails ownership until the maintained target maps it", () => {
  for (const host of ["go", "wailsv3"]) {
    const file = `packages/host/${host}/tests/new_display_test.go`;
    for (const parameter of ["t *testing.T", "check *testing.T", "\n  check *testing.T,\n"]) {
      const files = new Map([[file, `//go:build darwin && e2e\n\npackage host_test\nimport "testing"\nfunc TestE2EANewDisplayContract(${parameter}) {}\n`]]);
      assert.deepEqual(unmappedGoEndToEndTests(files, ["./packages/host/mygo/tests/..."]), [`${file}: TestE2EANewDisplayContract`]);
      assert.deepEqual(unmappedGoEndToEndTests(files, [`./packages/host/${host}/tests/...`]), []);
    }
  }
});

test("the root make targets are the only entry points of the window checks", { timeout: 1000 }, () => {
  const root = rules(read("Makefile"));
  for (const target of ["test-app", "test-app-activation", "benchmark-b3"]) assert.ok(root.some((rule) => rule.target === target), `the Makefile has no target ${target}`);
  // The save of the debug view is a request of host.dialog that the check answers, so no check waits for a person and no
  // target or script runs one.
  assert.equal(root.some((rule) => rule.target === "test-app-person"), false, "the Makefile still has the person target test-app-person");
  assert.deepEqual(Object.keys(JSON.parse(read("e2e/package.json")).scripts).filter((name) => name === "test-app:person"), [],
    "e2e/package.json still declares the person script test-app:person");
  // The checks of the real-input tier read the system cursor under HID events; the emulated pointer and the cursor of host.window
  // reach the same judgment, so no target or script runs a check with the real input of the window server.
  assert.equal(root.some((rule) => rule.target === "test-app-real"), false, "the Makefile still has the real-input target test-app-real");
  assert.deepEqual(Object.keys(JSON.parse(read("e2e/package.json")).scripts).filter((name) => name === "test-app:real"), [],
    "e2e/package.json still declares the real-input script test-app:real");
  assert.match(root.find((rule) => rule.target === "test-app").recipe, /node scripts\/test-app\.mjs/, "make test-app does not run scripts/test-app.mjs");
  assert.deepEqual(misnamedRootTargets(read("Makefile"), read), [], "a root target runs end-to-end checks outside the test-app targets");
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

test("the build and verify examples state each paragraph once and name only targets of the Makefile", { timeout: 1000 }, () => {
  // `make release` and `make pack` are targets of a sidecar or plugin repository, and `make -C` names another Makefile.
  const elsewhere = new Set(["release", "pack"]);
  const targets = new Set([...read("Makefile").matchAll(/^([A-Za-z0-9_.-]+):/gm)].map((match) => match[1]));
  for (const file of ["docs/operations/examples.md", "docs/operations/examples.ko.md"]) {
    const lines = read(file).split("\n").filter((line) => line.length > 80 && !line.startsWith("|"));
    assert.deepEqual(lines.filter((line, index) => lines.indexOf(line) !== index).map((line) => line.slice(0, 60)), [], `${file} repeats a paragraph`);
    const named = [...read(file).matchAll(/`make ([a-z0-9][a-z0-9_.-]*)/g)].map((match) => match[1]);
    assert.deepEqual(named.filter((name) => !targets.has(name) && !elsewhere.has(name)), [], `${file} names a target that the Makefile lacks`);
  }
});
