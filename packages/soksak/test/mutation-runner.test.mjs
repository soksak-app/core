import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const bounded = fileURLToPath(new URL("../scripts/bounded.mjs", import.meta.url));
const run = (args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.once("error", reject);
  child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
});

test("bounded command preserves both output streams", { timeout: 10000 }, async () => {
  const result = await run([bounded, "5000", process.execPath, "-e", 'console.log("out"); console.error("error");']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "out\n");
  assert.equal(result.stderr, "error\n");
});

test("a failed command start is an environment error, not a timeout", { timeout: 10000 }, async () => {
  const result = await run([bounded, "5000", "/a-command-that-does-not-exist"]);
  assert.equal(result.code, 125, result.stderr);
  assert.match(result.stderr, /spawn-error.*ENOENT/);
});

async function fixture(t, source) {
  const directory = await mkdtemp(join(tmpdir(), "soksak-mutation-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "case.test.mjs"), source);
  return directory;
}

for (const [name, source, expected] of [
  ["pass", 'import test from "node:test"; test("case", () => {});', "passed"],
  ["assertion", 'import test from "node:test"; import assert from "node:assert/strict"; test("case", () => { console.log("before assertion"); assert.equal(1, 2); });', "assertion-failure"],
  ["runtime", 'import test from "node:test"; test("case", () => { throw new TypeError("mutant runtime"); });', "runtime-failure"],
  ["syntax", "export const invalid = ;", "runtime-failure"],
  ["environment", 'import "./missing-dependency.mjs";', "environment-error"],
  ["empty", "", "environment-error"],
  ["skipped", 'import test from "node:test"; test.skip("not executed", () => {});', "environment-error"],
]) {
  test(`mutation execution classifies ${name} and retains its output`, { timeout: 10000 }, async (t) => {
    const { runMutationTest } = await import("../scripts/mutation-runner.mjs");
    const directory = await fixture(t, source);
    const result = await runMutationTest({ root: directory, file: "case.test.mjs", timeout: 5000, evidence: join(directory, "evidence") });
    assert.equal(result.classification, expected, JSON.stringify(result));
    const stdout = await readFile(result.stdout, "utf8");
    assert.ok(stdout.length > 0);
    assert.equal(typeof await readFile(result.stderr, "utf8"), "string");
    const record = JSON.parse(await readFile(result.record, "utf8"));
    assert.equal(record.classification, expected);
    assert.equal(record.code, result.code);
    if (name === "assertion") assert.match(stdout, /before assertion/);
  });
}

test("a mutant deadline is distinguished from cancellation of the experiment", { timeout: 10000 }, async (t) => {
  const { runMutationTest } = await import("../scripts/mutation-runner.mjs");
  const directory = await fixture(t, 'import test from "node:test"; test("hang", () => new Promise(() => { setInterval(() => {}, 1000); }));');
  const timeout = await runMutationTest({ root: directory, file: "case.test.mjs", timeout: 100, evidence: join(directory, "timeout") });
  assert.equal(timeout.classification, "mutant-timeout");
  const controller = new AbortController();
  const cancelled = await runMutationTest({ root: directory, file: "case.test.mjs", timeout: 5000, evidence: join(directory, "cancelled"), signal: controller.signal, onSpawn: () => controller.abort() });
  assert.equal(cancelled.classification, "environment-error");
  assert.equal(cancelled.reason, "cancelled");
});

test("only mutant-caused failure classes establish detection", { timeout: 1000 }, async () => {
  const { mutationVerdict } = await import("../scripts/mutation-runner.mjs");
  for (const classification of ["assertion-failure", "runtime-failure", "mutant-timeout"]) {
    assert.equal(mutationVerdict({ classification }), "caught");
  }
  assert.equal(mutationVerdict({ classification: "passed" }), "survived");
  assert.equal(mutationVerdict({ classification: "environment-error" }), "invalid");
  assert.throws(() => mutationVerdict({ classification: "unknown" }), /classification/);
});

test("an unexplained process termination cannot establish mutation detection", { timeout: 10000 }, async (t) => {
  const { runMutationTest } = await import("../scripts/mutation-runner.mjs");
  const directory = await fixture(t, 'import test from "node:test"; test("case", () => {});');
  const result = await runMutationTest({ root: directory, file: "case.test.mjs", timeout: 5000,
    evidence: join(directory, "terminated"), onSpawn: (child) => child.kill("SIGTERM") });
  assert.equal(result.reason, "exit");
  assert.equal(result.signal, "SIGTERM");
  assert.equal(result.classification, "environment-error");
});

for (const [name, mutation, expectedCode, expectedOutput] of [
  ["assertion", { to: "export const value = 2;" }, 0, /result=assertion-failure/],
  ["runtime", { to: 'throw new TypeError("mutant"); export const value = 1;' }, 0, /result=runtime-failure/],
  ["environment", { to: 'import "./missing.mjs"; export const value = 1;' }, 2, /result=environment-error/],
  ["survivor", { to: "export const value = 1 + 0;" }, 1, /result=survived/],
  ["stale", { find: "absent" }, 1, /STALE/],
  ["ambiguous", { find: "value", source: "export const value = 1; // value" }, 1, /2 SITES/],
  ["baseline", { source: "export const value = 0;" }, 2, /FAIL baseline/],
]) {
  test(`required mutation command rejects invalid evidence and handles ${name}`, { timeout: 15000 }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "soksak-break-command-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const packageRoot = join(root, "packages/soksak");
    for (const folder of ["dist", "test", "scripts", "src", "docs", "node_modules"]) await mkdir(join(packageRoot, folder), { recursive: true });
    await mkdir(join(root, "scripts"));
    for (const file of ["package.json", "Makefile", ".node-version"]) await writeFile(join(root, file), file === "package.json" ? '{"type":"module"}' : "");
    for (const file of ["package.json", "tsconfig.json"]) await writeFile(join(packageRoot, file), '{"type":"module"}');
    for (const file of ["check-breaks.mjs", "bounded.mjs", "mutation-runner.mjs"]) await cp(new URL(`../scripts/${file}`, import.meta.url), join(packageRoot, "scripts", file));
    for (const file of ["node-test-evidence.mjs", "test-event-reporter.mjs"]) await cp(new URL(`../../../scripts/${file}`, import.meta.url), join(root, "scripts", file));
    const original = mutation.source ?? "export const value = 1;";
    const entry = { id: "value", file: "dist/soksak.js", find: "export const value = 1;", to: "export const value = 2;", what: "return the wrong value", ...mutation };
    await writeFile(join(packageRoot, "scripts/breaks.mjs"), `export const BREAKS = ${JSON.stringify([entry])};`);
    await writeFile(join(packageRoot, "dist/soksak.js"), original);
    await writeFile(join(packageRoot, "test/case.test.mjs"), 'import test from "node:test"; import assert from "node:assert/strict"; import { value } from "../dist/soksak.js"; test("value", () => assert.equal(value, 1));');
    const result = await run([join(packageRoot, "scripts/check-breaks.mjs")], { env: { ...process.env, SOKSAK_MUTATION_RUN_FOLDER: root } });
    assert.equal(result.code, expectedCode, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, expectedOutput);
    assert.equal(await readFile(join(packageRoot, "dist/soksak.js"), "utf8"), original, "a mutation changed the original package");
    const evidence = /^Evidence: (.+)$/m.exec(result.stdout)?.[1];
    assert.ok(evidence, "the command did not identify its retained evidence");
    const baseline = JSON.parse(await readFile(join(evidence, "baseline/test/case.test.mjs/result.json"), "utf8"));
    assert.equal(baseline.classification, name === "baseline" ? "assertion-failure" : "passed");
    assert.ok((await readFile(baseline.stdout, "utf8")).length > 0);
  });
}
