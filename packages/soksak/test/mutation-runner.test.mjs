import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
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

test("the evidence folder of a mutation run lies under target/mutation-runs of the repository unless the run folder names another", async (t) => {
  const { evidenceFolder } = await import("../scripts/mutation-runner.mjs");
  const root = await mkdtemp(join(tmpdir(), "soksak-mutation-evidence-root-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const kept = evidenceFolder(root, "soksak-break-evidence-", {});
  assert.ok(kept.startsWith(`${join(root, "target", "mutation-runs")}/soksak-break-evidence-`), kept);
  const named = join(root, "named");
  assert.ok(evidenceFolder(root, "soksak-mutation-evidence-", { SOKSAK_MUTATION_RUN_FOLDER: named }).startsWith(`${named}/soksak-mutation-evidence-`));
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

test("a command group whose last member has ended but is not reaped ends without an error", { timeout: 10000 }, async (t) => {
  const { runBounded } = await import("../scripts/bounded.mjs");
  // The leader starts a holder in another group. The holder starts a member that joins the leader's group and exits; the holder never
  // reaps it, so the member stays a zombie in that group. The leader exits once the process table shows the zombie, and prints the holder.
  const leftover = `
    my $leader = $$;
    pipe(my $read, my $write) or die "pipe: $!";
    my $holder = fork() // die "fork: $!";
    if ($holder == 0) {
      close $read;
      open(STDOUT, ">", "/dev/null"); open(STDERR, ">", "/dev/null");
      setpgrp(0, 0) or die "setpgrp: $!";
      my $member = fork() // die "fork: $!";
      if ($member == 0) { setpgrp(0, $leader) or die "setpgrp: $!"; exit 0; }
      print $write "$member\\n"; close $write;
      sleep;
    }
    close $write;
    my $member = <$read>; chomp $member;
    until (\`ps -o stat= -p $member\` =~ /^Z/) { select(undef, undef, undef, 0.01); }
    print "$holder\\n";`;
  let holder = "";
  t.after(() => { if (/^\d+\n$/.test(holder)) process.kill(Number(holder), "SIGKILL"); });
  const result = await runBounded("perl", ["-e", leftover], { timeout: 5000, stdout: "pipe",
    onSpawn: (child) => child.stdout.on("data", (chunk) => { holder += chunk; }) });
  assert.match(holder, /^\d+\n$/, "the leader did not report its holder");
  assert.deepEqual({ reason: result.reason, code: result.code, error: result.error }, { reason: "exit", code: 0, error: null });
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
  ["runtime with assertion text", 'import test from "node:test"; test("case", () => { console.log("ERR_ASSERTION"); throw new TypeError("mutant runtime"); });', "runtime-failure"],
  ["module runtime with environment text", 'console.log("ENOENT"); throw new TypeError("mutant runtime");', "runtime-failure"],
  ["assertion with environment text", 'import test from "node:test"; import assert from "node:assert/strict"; test("case", () => { console.log("ENOENT"); assert.equal(1, 2); });', "assertion-failure"],
  ["syntax", "export const invalid = ;", "runtime-failure"],
  ["test child signal", 'process.kill(process.pid, "SIGTERM");', "environment-error"],
  ["environment", 'import "./missing-dependency.mjs";', "environment-error"],
  ["registered environment error", 'import test from "node:test"; test("case", () => { throw Object.assign(new Error("file refused"), { code: "EACCES" }); });', "environment-error"],
  ["test deadline", 'import test from "node:test"; test("case", { timeout: 20 }, () => new Promise((resolve) => setTimeout(resolve, 50)));', "mutant-timeout"],
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

for (const [title, name, mutation, expectedCode, expectedOutput] of [
  ["required mutation command rejects invalid evidence and handles assertion", "assertion", { to: "export const value = 2;" }, 0, /result=assertion-failure/],
  ["required mutation command rejects invalid evidence and handles runtime", "runtime", { to: 'throw new TypeError("mutant"); export const value = 1;' }, 0, /result=runtime-failure/],
  ["required mutation command rejects invalid evidence and handles environment", "environment", { to: 'import "./missing.mjs"; export const value = 1;' }, 2, /result=environment-error/],
  ["required mutation command rejects invalid evidence and handles survivor", "survivor", { to: "export const value = 1 + 0;" }, 1, /result=survived/],
  ["required mutation command rejects invalid evidence and handles stale", "stale", { find: "absent" }, 1, /STALE/],
  ["required mutation command rejects invalid evidence and handles ambiguous", "ambiguous", { find: "value", source: "export const value = 1; // value" }, 1, /2 SITES/],
  ["required mutation command rejects invalid evidence and handles baseline", "baseline", { source: "export const value = 0;" }, 2, /FAIL baseline/],
  ["required mutation command rejects invalid evidence and handles snapshot", "snapshot", {}, 0, /result=assertion-failure/],
  ["required mutation command rejects invalid evidence and handles required assertion", "required assertion", {}, 0, /PASS break=state result=assertion-failure/],
  ["required mutation command rejects invalid evidence and handles required survivor", "required survivor", { to: "export const value = 1 + 0;" }, 1, /FAIL break=state result=survived/],
  ["required mutation command rejects invalid evidence and handles required baseline", "required baseline", { source: "export const value = 0;" }, 2, /FAIL baseline/],
]) {
  test(title, { timeout: 15000 }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "soksak-break-command-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const packageRoot = join(root, "packages/soksak");
    const selected = name.startsWith("required ");
    const testFile = selected ? "test/soksak.test.mjs" : "test/case.test.mjs";
    for (const folder of ["dist", "test", "scripts", "src", "docs", "node_modules"]) await mkdir(join(packageRoot, folder), { recursive: true });
    await mkdir(join(root, "scripts"));
    await mkdir(join(root, "docs/spec/cases/layout"), { recursive: true });
    for (const file of ["package.json", "Makefile", ".node-version"]) await writeFile(join(root, file), file === "package.json" ? '{"type":"module"}' : "");
    for (const file of ["package.json", "tsconfig.json"]) await writeFile(join(packageRoot, file), '{"type":"module"}');
    for (const file of ["check-breaks.mjs", "bounded.mjs", "mutation-runner.mjs", "required-breaks.mjs", "workspace-copy.mjs"]) await cp(new URL(`../scripts/${file}`, import.meta.url), join(packageRoot, "scripts", file));
    for (const file of ["node-test-evidence.mjs", "test-command.mjs", "test-event-reporter.mjs"]) await cp(new URL(`../../../scripts/${file}`, import.meta.url), join(root, "scripts", file));
    const original = mutation.source ?? "export const value = 1;";
    const entry = { id: selected ? "state" : "value", file: "dist/soksak.js", find: "export const value = 1;", to: "export const value = 2;", what: "return the wrong value", ...mutation };
    await writeFile(join(packageRoot, "scripts/breaks.mjs"), `export const BREAKS = ${JSON.stringify([entry])};`);
    await writeFile(join(packageRoot, "dist/soksak.js"), original);
    const originalTest = 'import test from "node:test"; import assert from "node:assert/strict"; import { value } from "../dist/soksak.js"; test("value", () => assert.equal(value, 1));';
    const changedTest = 'import test from "node:test"; test("unrelated", () => {});';
    const drift = name === "snapshot" ? `\nimport { writeFileSync } from "node:fs"; test("external edit", () => writeFileSync(process.env.MUTATION_LIVE_TEST, ${JSON.stringify(changedTest)}));` : "";
    await writeFile(join(packageRoot, testFile), originalTest + drift);
    const args = [join(packageRoot, "scripts/check-breaks.mjs")];
    if (selected) {
      const git = (...arguments_) => execFileSync("git", arguments_, { cwd: root, encoding: "utf8" }).trim();
      git("init", "--quiet");
      await writeFile(join(packageRoot, "src/soksak.ts"), "before");
      git("add", "packages/soksak/src/soksak.ts");
      git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "before");
      const before = git("rev-parse", "HEAD");
      await writeFile(join(packageRoot, "src/soksak.ts"), "after");
      git("add", "packages/soksak/src/soksak.ts");
      git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "after");
      args.push("--changed", `${before}..HEAD`);
    }
    const { SOKSAK_MUTATION_RUN_FOLDER, ...env } = process.env;
    const result = await run(args, { env: { ...env, MUTATION_LIVE_TEST: join(packageRoot, testFile) } });
    assert.equal(result.code, expectedCode, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, expectedOutput);
    assert.equal(await readFile(join(packageRoot, "dist/soksak.js"), "utf8"), original, "a mutation changed the original package");
    if (name === "snapshot") assert.equal(await readFile(join(packageRoot, "test/case.test.mjs"), "utf8"), changedTest, "the external edit was not exercised");
    const evidence = /^Evidence: (.+)$/m.exec(result.stdout)?.[1];
    assert.ok(evidence, "the command did not identify its retained evidence");
    // The evidence outlives the run, so it lies under target/mutation-runs of the repository and not in the temporary folder.
    assert.ok(evidence.startsWith(`${join(root, "target", "mutation-runs")}/soksak-break-evidence-`), evidence);
    const baseline = JSON.parse(await readFile(join(evidence, "baseline", testFile, "result.json"), "utf8"));
    assert.equal(baseline.classification, name.endsWith("baseline") ? "assertion-failure" : "passed");
    assert.ok((await readFile(baseline.stdout, "utf8")).length > 0);
  });
}
