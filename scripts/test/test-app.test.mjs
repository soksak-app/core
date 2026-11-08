// The run of the end-to-end checks (scripts/test-app.mjs, docs/operations/examples.md#end-to-end-run): the steps of a run, a fresh
// configuration root for each run, the report of each step, and the failure on a process that remains after the applications quit.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs, { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { startFakeEndpoint } from "@soksak/client/testing";
import { e2ePlan, finishCandidate, finishRoot, newConfigRoot, remainingProcesses, runPlan, validateOrdinaryArtifacts, quitApplication } from "../test-app.mjs";

const node = (code) => [process.execPath, "-e", code];
// The limit of a test of a start step is the limit of the step (START_LIMIT_MS, 60 s) and some more: at a high load of the file system
// events service the watch of the folder can become active after that limit, and the read at the limit then ends the step.
const START_TEST_LIMIT_MS = 70000;
const step = (name, phase, code) => ({ name, phase, kind: "run", argv: node(code), env: {} });

test("ordinary focused acceptance owns explicit prebuilt artifacts and unchanged quit paths", () => {
  const artifacts = {
    schema: 1,
    hosts: ["mygo", "tauriv2", "wailsv3"].map((app) => ({ app, bundle: `/prebuilt/${app}.app` })),
    registry: { path: "/prebuilt/registry/index.json", components: [{ kind: "plugin", id: "declared-plugin" }] },
  };
  const plan = e2ePlan({ root: "/source", configRoot: "/configuration/fresh", script: "test-app", artifacts, only: "window-end.test.mjs" });
  for (const host of artifacts.hosts) {
    assert.equal(plan.find((item) => item.name === `start ${host.app}`).argv[0], `${host.bundle}/Contents/MacOS/sok-${host.app}`);
    assert.deepEqual(plan.find((item) => item.name === `registry ${host.app}`).argv,
      [`${host.bundle}/Contents/MacOS/sok`, "registry", "use", artifacts.registry.path, "--config-dir", `/configuration/fresh/soksak-check-${host.app}`]);
    assert.equal(plan.find((item) => item.name === `install declared-plugin ${host.app}`).argv[0], `${host.bundle}/Contents/MacOS/sok`);
  }
  const checks = plan.find((item) => item.name === "window checks");
  assert.deepEqual(checks.argv.slice(-2), ["--only", "window-end.test.mjs"]);
  assert.equal(checks.env.SOKSAK_CANDIDATE_RUN_FOLDER, undefined, "ordinary focus must not claim full candidate acceptance");
  assert.deepEqual(plan.filter((item) => item.kind === "quit").map(({ app, by }) => [app, by]), [["wailsv3", "menu"], ["tauriv2", "menu"], ["mygo", "key"]]);
  assert.deepEqual(plan.find((item) => item.kind === "remaining").paths, ["/configuration/fresh", "/prebuilt/wailsv3.app", "/prebuilt/tauriv2.app", "/prebuilt/mygo.app"]);
  assert.ok(!plan.some((item) => item.argv?.includes("install-plugins")), "explicit artifacts cannot use default debug installer");
});

test("candidate plans reject ordinary file selection and artifact overrides", () => {
  const candidate = { hosts: ["mygo", "tauriv2", "wailsv3"].map((app) => ({ app, bundle: `/candidate/${app}.app` })), registry: { path: "/candidate/index.json", components: [] } };
  for (const extra of [{ only: "window-end.test.mjs" }, { artifacts: candidate }]) {
    assert.throws(() => e2ePlan({ root: "/source", configRoot: "/configuration", script: "test-app", candidate, ...extra }), /candidate.*(selection|artifacts|override)/);
  }
});

test("ordinary artifact input rejects relative paths, incomplete hosts and existing configuration data", (t) => {
  const input = { schema: 1, hosts: ["mygo", "tauriv2", "wailsv3"].map((app) => ({ app, bundle: `/prebuilt/${app}.app` })), registry: { path: "/prebuilt/index.json" } };
  assert.equal(validateOrdinaryArtifacts(input), input);
  const change = (fn) => { const value = structuredClone(input); fn(value); return value; };
  assert.throws(() => validateOrdinaryArtifacts(change((v) => { v.hosts[0].bundle = "relative.app"; })), /bundle must be absolute/);
  assert.throws(() => validateOrdinaryArtifacts(change((v) => { v.registry.path = "relative.json"; })), /registry path must be absolute/);
  assert.throws(() => validateOrdinaryArtifacts(change((v) => { v.hosts.pop(); })), /every host exactly once/);
  assert.throws(() => validateOrdinaryArtifacts(change((v) => { v.hosts[0].app = v.hosts[1].app; })), /every host exactly once/);
  assert.throws(() => validateOrdinaryArtifacts(input, "relative-config"), /absolute new directory/);
  const existing = workspace(t);
  writeFileSync(join(existing, "retained.txt"), "existing user state");
  assert.throws(() => validateOrdinaryArtifacts(input, existing), /existing data is never overwritten/);
  assert.equal(readFileSync(join(existing, "retained.txt"), "utf8"), "existing user state");
});

test("candidate CLI rejects all ordinary options before reading context or starting applications", () => {
  for (const args of [["--only", "window-end.test.mjs"], ["--artifacts", "/must-not-read.json"], ["--config-root", "/must-not-create"]]) {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("../test-app.mjs", import.meta.url)), "--script", "test-app", "--candidate", "/must-not-read.json", ...args], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /candidate acceptance rejects ordinary/);
  }
});

test("candidate acceptance has a make entrypoint that requires explicit context and script without rebuilding", { timeout: 10000 }, () => {
  const cwd = fileURLToPath(new URL('../../', import.meta.url));
  const missing = spawnSync('make', ['--no-print-directory', 'test-app-candidate'], { cwd, encoding: 'utf8' });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /CONTEXT=.*SCRIPT=/);
  const planned = spawnSync('make', ['--no-print-directory', '-n', 'test-app-candidate', 'CONTEXT=/candidate/context.json', 'SCRIPT=test-app'], { cwd, encoding: 'utf8' });
  assert.equal(planned.status, 0, planned.stderr);
  assert.match(planned.stdout, /node scripts\/test-app.mjs --candidate "\/candidate\/context.json" --script "test-app"/);
  assert.doesNotMatch(planned.stdout, /pnpm|cargo|go build|build-registry|clang/);
});

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), "soksak-e2e-run-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("plugin installation consumes the built registry without rebuilding sibling sources", { timeout: 10000 }, () => {
  const cwd = fileURLToPath(new URL("../../", import.meta.url));
  const planned = spawnSync("make", ["--no-print-directory", "-n", "install-plugins", "CONFIG=/disposable/config"],
    { cwd, encoding: "utf8", timeout: 5000 });
  assert.equal(planned.error, undefined);
  assert.equal(planned.status, 0, planned.stderr);
  assert.match(planned.stdout, /sok registry use target\/registry\/index.json/);
  assert.doesNotMatch(planned.stdout, /cargo build|workspace-registry\.mjs/, "installation must not rebuild the recorded registry");
});

function installationFixture(t) {
  const root = workspace(t);
  mkdirSync(join(root, "scripts"));
  fs.copyFileSync(new URL("../check-versions.mjs", import.meta.url), join(root, "scripts", "check-versions.mjs"));
  const config = join(root, "configuration with spaces");
  const installed = JSON.stringify({ plugins: { previous: { version: "1.0.0" } } });
  const index = JSON.stringify({ plugins: [{ id: "current" }] });
  mkdirSync(join(config, "plugins", "previous"), { recursive: true });
  writeFileSync(join(config, "plugins", "installed.json"), installed);
  writeFileSync(join(config, "plugins", "previous", "retained.txt"), "previous installation");
  mkdirSync(join(root, "target", "registry"), { recursive: true });
  writeFileSync(join(root, "target", "registry", "index.json"), index);
  mkdirSync(join(root, "target", "debug"), { recursive: true });
  // The CLI is the recipe's command boundary: it validates the index and makes any remove observable on disk.
  writeFileSync(join(root, "target", "debug", "sok"), `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync("calls.jsonl", JSON.stringify(args) + "\\n");
if (args[0] === "registry" && args[1] === "use") JSON.parse(fs.readFileSync(args[2], "utf8"));
if (args[0] === "plugin" && args[1] === "remove") {
  const config = args[args.indexOf("--config-dir") + 1];
  fs.rmSync(path.join(config, "plugins", args[2]), { recursive: true, force: true });
}
`, { mode: 0o755 });
  const makefile = fileURLToPath(new URL("../../Makefile", import.meta.url));
  // Hold the build target while testing installation preconditions; the separate dry run owns the prerequisite graph.
  const run = () => spawnSync("make", ["--no-print-directory", "-f", makefile, "-o", "build-registry", "install-plugins",
    `CONFIG=${config}`], { cwd: root, encoding: "utf8", timeout: 5000 });
  const calls = () => existsSync(join(root, "calls.jsonl"))
    ? readFileSync(join(root, "calls.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
  return { root, config, installed, index, run, calls };
}

test("plugin installation rejects missing build inputs before removing installed plugins", { timeout: 10000 }, async (t) => {
  for (const [missing, condition] of [["target/debug/sok", "missing or not executable"], ["target/registry/index.json", "missing"]]) {
    await t.test(missing, { timeout: 5000 }, (t) => {
      const fixture = installationFixture(t);
      rmSync(join(fixture.root, missing));
      const result = fixture.run();
      assert.equal(result.error, undefined);
      assert.equal(result.status, 2, "missing installation inputs must fail");
      assert.equal(readFileSync(join(fixture.config, "plugins", "previous", "retained.txt"), "utf8"), "previous installation");
      assert.equal(readFileSync(join(fixture.config, "plugins", "installed.json"), "utf8"), fixture.installed);
      assert.equal(result.stderr.split("\n")[0], `${missing} is ${condition}; run make build-registry before installation`,
        "the actual precondition must identify the missing input and preparation command");
      assert.deepEqual(fixture.calls(), [], "required inputs must be checked before any CLI mutation");
    });
  }
});

test("plugin installation uses the existing registry and replaces the installed set", { timeout: 10000 }, (t) => {
  const fixture = installationFixture(t);
  const result = fixture.run();
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fixture.calls(), [
    ["registry", "use", "target/registry/index.json", "--config-dir", fixture.config],
    ["plugin", "remove", "previous", "--config-dir", fixture.config],
    ["plugin", "install", "current", "--config-dir", fixture.config],
  ]);
  assert.equal(existsSync(join(fixture.config, "plugins", "previous")), false);
  assert.equal(readFileSync(join(fixture.root, "target", "registry", "index.json"), "utf8"), fixture.index);
});

function recorder() {
  const lines = [];
  return { lines, write: (line) => lines.push(line) };
}

test("a final configuration cleanup failure cannot leave passing candidate evidence", { timeout: 5000 }, async (t) => {
  const root = workspace(t), runFolder = join(root, "run");
  mkdirSync(runFolder);
  const selection = { only: null, exclude: [], changed: false, namePattern: null, apps: ["tauriv2", "wailsv3"] };
  writeFileSync(join(runFolder, "manifest.json"), JSON.stringify({ schema: 1, run: "fixture", finished_us: 1,
    script: "benchmark:fixture", selection, tests: [{ name: "fixture.test.mjs", status: "pass" }] }));
  writeFileSync(join(runFolder, "judgment.json"), JSON.stringify({ run: "fixture", audit: { status: "pass", findings: [] },
    tests: selection.apps.map((app) => ({ app, result: "pass" })) }));
  const inputs = { head: "fixture", dirty: false, hosts: [] }, failures = [];
  const context = { candidate: { artifacts: [] }, assets: [], registry: { sha256: "fixture", pack: "required", components: [] } };
  await finishCandidate({ root, context, configRoot: join(root, "config"), runFolder, script: "benchmark:fixture",
    initializationId: "initial", inputs: { before: inputs, after: inputs }, steps: [{ name: "checks", status: "pass" }],
    failures, dispose: async () => {}, write: () => {} },
  { capture: async () => inputs, cleanup: () => { throw new Error("configuration removal denied"); } }).catch((error) => {
    assert.match(error.message, /configuration removal denied/);
  });
  const { acceptance } = JSON.parse(readFileSync(join(runFolder, "manifest.json"), "utf8"));
  assert.ok(acceptance.run.errors.some((error) => /configuration removal denied/.test(error)));
  assert.equal(acceptance.run.plan.status, "fail");
  assert.deepEqual(acceptance.run.plan.steps.at(-1), { name: "configuration cleanup", status: "fail" });
});

test("each run gets a new empty configuration root under target/e2e", { timeout: 5000 }, (t) => {
  const root = workspace(t);
  const first = newConfigRoot(root);
  const second = newConfigRoot(root);
  assert.notEqual(first, second);
  for (const folder of [first, second]) {
    assert.equal(join(folder, ".."), join(root, "target", "e2e"));
    assert.deepEqual(readdirSync(folder), []);
  }
});

test("the plan prepares, starts the three applications, checks and quits them in this order", { timeout: 5000 }, () => {
  const root = "/work";
  const configRoot = "/work/target/e2e/run";
  const plan = e2ePlan({ root, configRoot, script: "verify", native: "e2e" });
  assert.deepEqual(plan.map((item) => [item.phase, item.name]), [
    ["prepare", "registry certificates"],
    ["prepare", "install plugins wailsv3"],
    ["prepare", "install plugins tauriv2"],
    ["prepare", "install plugins mygo"],
    ["prepare", "start wailsv3"],
    ["prepare", "start tauriv2"],
    ["prepare", "start mygo"],
    ["check", "window checks"],
    ["check", "native end-to-end tests"],
    ["cleanup", "quit wailsv3"],
    ["cleanup", "quit tauriv2"],
    ["cleanup", "quit mygo"],
    ["cleanup", "remaining processes"],
  ]);
  for (const item of plan.filter((entry) => entry.kind === "run")) assert.equal(item.env.SOKSAK_CONFIG_ROOT, configRoot, item.name);
  const start = plan.find((item) => item.name === "start wailsv3");
  assert.deepEqual(start.argv, [
    "/work/target/debug/sok-wailsv3.app/Contents/MacOS/sok-wailsv3",
    "--config-dir", "/work/target/e2e/run/soksak-check-wailsv3",
    "--registry-ca", "/work/target/e2e/run/soksak-check-registry-tls/ca.pem",
  ]);
  const checks = plan.find((item) => item.name === "window checks");
  assert.equal(checks.env.SOKSAK_BINARY_TAURIV2, "/work/target/debug/sok-tauriv2.app/Contents/MacOS/sok-tauriv2");
  assert.equal(checks.env.SOKSAK_BINARY_MYGO, "/work/target/debug/sok-mygo.app/Contents/MacOS/sok-mygo");
  assert.deepEqual(plan.find((item) => item.name === "start mygo").argv, [
    "/work/target/debug/sok-mygo.app/Contents/MacOS/sok-mygo",
    "--config-dir", "/work/target/e2e/run/soksak-check-mygo",
    "--registry-ca", "/work/target/e2e/run/soksak-check-registry-tls/ca.pem",
  ]);
  assert.ok(plan.find((item) => item.name === "remaining processes").paths.includes("/work/target/debug/sok-mygo.app"));
  // A person quits through the Quit item of the application menu or its key equivalent: the last application ends by Command+Q.
  assert.deepEqual(plan.filter((item) => item.kind === "quit").map((item) => [item.app, item.by]),
    [["wailsv3", "menu"], ["tauriv2", "menu"], ["mygo", "key"]]);
  assert.equal(checks.env.SOKSAK_CANDIDATE_REGISTRY, "file:///work/target/registry/index.json");
  assert.deepEqual(checks.argv.slice(2, 4), ["--script", "verify"]);
  assert.ok(!checks.argv.includes("--when-idle"));
  assert.deepEqual(plan.find((item) => item.name === "native end-to-end tests").argv, ["make", "-C", "native/darwin", "e2e"]);
  assert.equal(plan.some((item) => item.name === "capture text warm-up"), false);
  const person = e2ePlan({ root, configRoot, script: "test-app:person", whenIdle: "60" });
  assert.deepEqual(person.find((item) => item.name === "window checks").argv.slice(2, 4), ["--script", "test-app:person"]);
  assert.deepEqual(person.find((item) => item.name === "window checks").argv.slice(-2), ["--when-idle", "60"]);
  assert.equal(person.some((item) => item.name === "native end-to-end tests"), false);
});

test("a failed preparation skips the checks, runs the cleanup and names the failed step", { timeout: 10000 }, async () => {
  const { lines, write } = recorder();
  const failures = await runPlan([
    step("first", "prepare", "process.exit(3)"),
    step("second", "prepare", ""),
    step("checks", "check", ""),
    step("end", "cleanup", ""),
  ], { write });
  assert.deepEqual(failures, ["first: exited with code 3"]);
  assert.ok(lines.some((line) => /^failed first .*\d+(\.\d+)?s: exited with code 3$/.test(line)), lines.join("\n"));
  assert.ok(lines.includes("skipped second: first failed"), lines.join("\n"));
  assert.ok(lines.includes("skipped checks: first failed"), lines.join("\n"));
  assert.ok(lines.some((line) => /^passed end /.test(line)), lines.join("\n"));
});

test("a candidate plan uses its bundled installers and frozen registry without building the workspace", { timeout: 5000 }, () => {
  const candidate = {
    hosts: ["mygo", "tauriv2", "wailsv3"].map((app) => ({ app, bundle: `/candidate/${app}.app` })),
    registry: { path: "/candidate/index.json", pack: "required", components: [{ kind: "plugin", id: "fixture" }] },
  };
  const plan = e2ePlan({ root: "/work", configRoot: "/work/target/e2e/run", script: "test-app",
    native: "test-app", candidate, runFolder: "/work/target/test-runs/candidate" });
  assert.equal(plan.some((step) => step.argv?.includes("install-plugins")), false);
  assert.deepEqual(plan.find((step) => step.name === "registry wailsv3").argv,
    ["/candidate/wailsv3.app/Contents/MacOS/sok", "registry", "use", "/candidate/index.json", "--config-dir", "/work/target/e2e/run/soksak-check-wailsv3"]);
  assert.deepEqual(plan.find((step) => step.name === "install fixture wailsv3").argv,
    ["/candidate/wailsv3.app/Contents/MacOS/sok", "plugin", "install", "fixture", "--config-dir", "/work/target/e2e/run/soksak-check-wailsv3"]);
  assert.equal(plan.find((step) => step.name === "start wailsv3").argv[0], "/candidate/wailsv3.app/Contents/MacOS/sok-wailsv3");
  const check = plan.find((step) => step.name === "window checks");
  assert.equal(check.env.SOKSAK_CANDIDATE_RUN_FOLDER, "/work/target/test-runs/candidate");
  assert.equal(check.env.SOKSAK_CANDIDATE_REGISTRY, "file:///candidate/index.json");
  for (const app of candidate.hosts.map((host) => host.app)) {
    assert.equal(check.env[`SOKSAK_BINARY_${app.toUpperCase()}`], `/candidate/${app}.app/Contents/MacOS/sok-${app}`);
  }
  assert.equal(plan.find((step) => step.name === "native end-to-end tests").env.SOKSAK_NATIVE_TEST_RUN_FOLDER,
    "/work/target/test-runs/candidate/native");
  const names = plan.map((step) => step.name);
  for (const app of candidate.hosts.map((host) => host.app)) {
    assert.ok(names.indexOf(`start ${app}`) >= 0, app);
    assert.ok(names.indexOf("acceptance before") > names.indexOf(`start ${app}`), app);
    assert.ok(names.indexOf("acceptance after") < names.indexOf(`quit ${app}`), app);
  }
  assert.ok(names.indexOf("acceptance before") < names.indexOf("window checks"));
  assert.ok(names.indexOf("acceptance after") > names.indexOf("native end-to-end tests"));
});

test("a plan records failed and skipped steps and still captures final inputs before cleanup", { timeout: 10000 }, async () => {
  const outcomes = [], captures = [];
  const failures = await runPlan([
    { name: "acceptance before", phase: "prepare", kind: "capture", capture: "before" },
    step("window checks", "check", "process.exit(1)"),
    { name: "acceptance after", phase: "cleanup", kind: "capture", capture: "after" },
    step("close", "cleanup", ""),
  ], { write() {}, capture: async (phase) => captures.push(phase), outcome: (value) => outcomes.push(value) });
  assert.deepEqual(captures, ["before", "after"]);
  assert.deepEqual(failures, ["window checks: exited with code 1"]);
  assert.deepEqual(outcomes.map(({ name, status }) => [name, status]),
    [["acceptance before", "pass"], ["window checks", "fail"], ["acceptance after", "pass"], ["close", "pass"]]);
  const skipped = [];
  await runPlan([step("prepare", "prepare", "process.exit(1)"), step("check", "check", ""), step("cleanup", "cleanup", "")],
    { write() {}, outcome: (value) => skipped.push(value) });
  assert.deepEqual(skipped.map(({ name, status }) => [name, status]), [["prepare", "fail"], ["check", "skip"], ["cleanup", "pass"]]);
});

test("a failed check does not skip the next check", { timeout: 10000 }, async () => {
  const { lines, write } = recorder();
  const failures = await runPlan([step("one", "check", "process.exit(1)"), step("two", "check", "")], { write });
  assert.deepEqual(failures, ["one: exited with code 1"]);
  assert.ok(lines.some((line) => /^passed two /.test(line)), lines.join("\n"));
});

test("a start step ends when the application writes endpoint.json and fails when the application exits first", { timeout: START_TEST_LIMIT_MS }, async (t) => {
  const configDir = workspace(t);
  const writes = `setTimeout(() => require("fs").writeFileSync(${JSON.stringify(join(configDir, "endpoint.json"))}, "{}"), 200); setInterval(() => {}, 1000)`;
  const { lines, write } = recorder();
  const started = { name: "start app", phase: "prepare", kind: "start", app: "app", argv: node(writes), configDir, output: join(configDir, "app.out") };
  const children = new Map();
  t.after(() => children.get("app")?.kill());
  assert.deepEqual(await runPlan([started], { write, children }), []);
  const exits = { ...started, configDir: workspace(t), argv: node("process.exit(4)") };
  const failures = await runPlan([exits], { write });
  assert.deepEqual(failures, ["start app: the application exited with code 4 before it wrote endpoint.json"]);
  assert.ok(lines.some((line) => line.startsWith("failed start app ")), lines.join("\n"));
});

test("a start step ends when endpoint.json is written before the watch of the folder is active", { timeout: START_TEST_LIMIT_MS }, async (t) => {
  // The file is in the folder before the step starts its watch, so no notification of the watch reports it: only the read of the
  // folder once the watch is active, or at the limit, finds it.
  const configDir = workspace(t);
  writeFileSync(join(configDir, "endpoint.json"), "{}");
  const children = new Map();
  t.after(() => children.get("app")?.kill());
  const started = { name: "start app", phase: "prepare", kind: "start", app: "app", argv: node("setInterval(() => {}, 1000)"), configDir, output: join(configDir, "app.out") };
  assert.deepEqual(await runPlan([started], { write: () => {}, children }), []);
});

/** The application menu that host.menu reports, with the Quit item in the application submenu. */
const MENUS = { language: "en", menus: [
  { title: "soksak", items: [{ title: "About soksak", key: "" }, { title: "Quit soksak", key: "cmd+q" }] },
  { title: "File", items: [{ title: "Close Window", key: "cmd+w" }] },
] };

test("quit deadline covers connection and closes a client that arrives after expiry", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const configDir = workspace(t), child = { exitCode: 0, signalCode: null };
  let arrive, calls = 0, closed = 0, settled = false;
  const client = { request: async (method) => { calls++; return method === "status.get" ? MENUS : null; }, close() { closed++; } };
  const pending = quitApplication({ app: "fixture", by: "menu", configDir }, new Map([["fixture", child]]), 0, () => {}, () => new Promise((resolve) => { arrive = resolve; }));
  const observed = pending.then(() => ({ ok: true }), (error) => ({ error }));
  observed.then(() => { settled = true; });
  t.after(async () => { arrive(client); await observed; });
  t.mock.timers.tick(60_000);
  await new Promise(setImmediate);
  assert.equal(settled, true, "connection bypassed the existing 60-second quit deadline");
  assert.match((await observed).error.message, /quit.*60s/i);
  arrive(client);
  await new Promise(setImmediate);
  assert.equal(calls, 0, "a late connection dispatched a quit after the step had expired");
  assert.equal(closed, 1, "the late client remained connected");
});

test("quit deadline closes a pending RPC and runs the remaining quit and process audit", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const firstDir = workspace(t), nextDir = workspace(t);
  let release, entered;
  const requested = new Promise((resolve) => { entered = resolve; });
  let firstClosed = 0, nextClosed = 0, settled = false;
  const first = { request: async (method) => {
    if (method === "status.get") return MENUS;
    entered(); return new Promise((resolve) => { release = resolve; });
  }, close() { firstClosed++; } };
  const next = { request: async (method) => method === "status.get" ? MENUS : null, close() { nextClosed++; } };
  const { lines, write } = recorder();
  const item = (app, configDir) => ({ name: `quit ${app}`, phase: "cleanup", kind: "quit", by: "menu", app, configDir });
  const pending = runPlan([item("first", firstDir), item("next", nextDir), { name: "remaining processes", phase: "cleanup", kind: "remaining", paths: [] }],
    { write, children: new Map([["first", { exitCode: 0, signalCode: null }], ["next", { exitCode: 0, signalCode: null }]]), connectClient: async ({ configDir }) => configDir === firstDir ? first : next });
  pending.then(() => { settled = true; });
  t.after(async () => { release(null); await pending; });
  await requested;
  t.mock.timers.tick(60_000);
  await new Promise(setImmediate);
  assert.equal(settled, true, "pending Quit RPC blocked every later cleanup beyond the declared deadline");
  const failures = await pending;
  assert.equal(failures.length, 1);
  assert.match(failures[0], /quit first:.*60s/);
  assert.equal(firstClosed, 1);
  assert.equal(nextClosed, 1);
  assert.ok(lines.some((line) => line.startsWith("passed quit next")), lines.join("\n"));
  assert.ok(lines.some((line) => line.startsWith("passed remaining processes")), lines.join("\n"));
});

/** A started application that exits with status 0 on SIGTERM, as a host ends after its quit, once it handles the signal. */
async function quittingApplication(t) {
  const app = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => process.exit(0)); process.stdout.write('ready'); setInterval(() => {}, 1000)"],
    { stdio: ["ignore", "pipe", "ignore"] });
  t.after(() => app.kill("SIGKILL"));
  await new Promise((resolve) => app.stdout.once("data", resolve));
  return app;
}

test("a quit step by the menu selects the Quit item that host.menu lists and passes when the application exits with status 0", { timeout: 10000 }, async (t) => {
  const app = await quittingApplication(t);
  const fake = await startFakeEndpoint({
    "status.get": (params) => { assert.equal(params.name, "host.menu"); return MENUS; },
    "command.run": (params) => {
      assert.deepEqual([params.name, params.params], ["host.menu.select", { menu: "soksak", title: "Quit soksak" }]);
      app.kill("SIGTERM");
      return null;
    },
  });
  t.after(() => fake.close());
  const failures = await runPlan([{ name: "quit app", phase: "cleanup", kind: "quit", by: "menu", app: "app", configDir: fake.configDir }],
    { write: () => {}, children: new Map([["app", app]]) });
  assert.deepEqual(failures, []);
  assert.deepEqual(fake.requests.map((request) => request.method), ["status.get", "command.run"]);
});

test("a quit step by the key sends Command+Q down and up to the window and passes when the application exits with status 0", { timeout: 10000 }, async (t) => {
  const app = await quittingApplication(t);
  const keys = [];
  const fake = await startFakeEndpoint({
    "windows.list": () => [{ window: "w1" }],
    "input.key": (params) => {
      keys.push(params);
      if (params.phase === "up") app.kill("SIGTERM");
      return null;
    },
  });
  t.after(() => fake.close());
  const failures = await runPlan([{ name: "quit app", phase: "cleanup", kind: "quit", by: "key", app: "app", configDir: fake.configDir }],
    { write: () => {}, children: new Map([["app", app]]) });
  assert.deepEqual(failures, []);
  assert.deepEqual(keys, ["down", "up"].map((phase) => ({ window: "w1", key: "q", text: "q", modifiers: ["command"], phase })));
});

test("a quit step fails when the application ends with another status than 0 after its Quit item", { timeout: 10000 }, async (t) => {
  const app = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const fake = await startFakeEndpoint({ "status.get": () => MENUS, "command.run": () => { app.kill("SIGTERM"); return null; } });
  t.after(() => fake.close());
  const failures = await runPlan([{ name: "quit app", phase: "cleanup", kind: "quit", by: "menu", app: "app", configDir: fake.configDir }],
    { write: () => {}, children: new Map([["app", app]]) });
  assert.deepEqual(failures, ["quit app: the application ended with signal SIGTERM"]);
});

test("a quit step fails when the application menu has no item with the key equivalent cmd+q", { timeout: 10000 }, async (t) => {
  const app = await quittingApplication(t);
  const fake = await startFakeEndpoint({ "status.get": () => ({ language: "en", menus: [MENUS.menus[1]] }) });
  t.after(() => fake.close());
  const failures = await runPlan([{ name: "quit app", phase: "cleanup", kind: "quit", by: "menu", app: "app", configDir: fake.configDir }],
    { write: () => {}, children: new Map([["app", app]]) });
  assert.deepEqual(failures, ["quit app: the application menu has no item with the key equivalent cmd+q"]);
});

test("a quit step ends when the process that holds the configuration lock exits, also when that process is not the started one", { timeout: 10000 }, async (t) => {
  // diagnostics.host.relaunch replaces the started application with a new process, which owns process.lock (docs/spec/endpoint.md).
  const started = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((resolve) => started.once("exit", resolve));
  const fake = await startFakeEndpoint({ "status.get": () => MENUS, "command.run": () => null });
  t.after(() => fake.close());
  const holder = spawn("lockf", [join(fake.configDir, "process.lock"), process.execPath, "-e", "process.stdout.write('held'); setTimeout(() => {}, 400)"]);
  t.after(() => holder.kill());
  await new Promise((resolve) => holder.stdout.once("data", resolve));
  const failures = await runPlan([{ name: "quit app", phase: "cleanup", kind: "quit", by: "menu", app: "app", configDir: fake.configDir }],
    { write: () => {}, children: new Map([["app", started]]) });
  assert.deepEqual(failures, []);
  assert.notEqual(holder.exitCode, null, "the quit step ended while the process that holds process.lock was running");
});

test("a failed start skips the quit of its application, so the run reports the start as its one failure", { timeout: 10000 }, async (t) => {
  const configDir = workspace(t);
  const { lines, write } = recorder();
  const failures = await runPlan([
    { name: "start app", phase: "prepare", kind: "start", app: "app", argv: node("process.exit(4)"), configDir, output: join(configDir, "app.out") },
    { name: "quit app", phase: "cleanup", kind: "quit", app: "app", configDir },
  ], { write });
  assert.deepEqual(failures, ["start app: the application exited with code 4 before it wrote endpoint.json"]);
  assert.ok(lines.includes("skipped quit app: app was not started"), lines.join("\n"));
});

test("a quit step without a started application is skipped", { timeout: 5000 }, async () => {
  const { lines, write } = recorder();
  assert.deepEqual(await runPlan([{ name: "quit app", phase: "cleanup", kind: "quit", app: "app", configDir: "/none" }], { write }), []);
  assert.ok(lines.includes("skipped quit app: app was not started"), lines.join("\n"));
});

test("a process whose command names the configuration root or an application bundle remains", { timeout: 1000 }, () => {
  const text = [
    "  101 /work/target/debug/sok-wailsv3.app/Contents/MacOS/vt --config-dir /x",
    "  102 /usr/bin/other /tmp",
    "  103 /bin/sh -c cat /work/target/e2e/run/soksak-check-tauriv2/logs/host.jsonl",
  ].join("\n");
  assert.deepEqual(remainingProcesses(text, ["/work/target/e2e/run", "/work/target/debug/sok-wailsv3.app"], 999),
    ["101 /work/target/debug/sok-wailsv3.app/Contents/MacOS/vt --config-dir /x", "103 /bin/sh -c cat /work/target/e2e/run/soksak-check-tauriv2/logs/host.jsonl"]);
  assert.deepEqual(remainingProcesses("  999 node scripts/test-app.mjs /work/target/e2e/run", ["/work/target/e2e/run"], 999), []);
});

test("a passed run removes its configuration root and a failed run keeps it", { timeout: 5000 }, (t) => {
  const root = workspace(t);
  const { lines, write } = recorder();
  const passed = newConfigRoot(root);
  finishRoot(passed, [], write);
  assert.equal(existsSync(passed), false);
  const failed = newConfigRoot(root);
  finishRoot(failed, ["one: exited with code 1"], write);
  assert.equal(existsSync(failed), true);
  assert.ok(lines.includes(`kept ${failed}: 1 step failed`), lines.join("\n"));
});

test("a failed run keeps the logs and removes the service folders, so the services of a host that ended without host.quit exit", { timeout: 5000 }, (t) => {
  const root = workspace(t);
  const failed = newConfigRoot(root);
  for (const app of ["soksak-check-wailsv3", "soksak-check-tauriv2"]) {
    mkdirSync(join(failed, app, "services", "sok-vt-alacritty"), { recursive: true });
    writeFileSync(join(failed, app, "services", "sok-vt-alacritty", "endpoint.json"), "{}");
    mkdirSync(join(failed, app, "logs"), { recursive: true });
    writeFileSync(join(failed, app, "logs", "host.jsonl"), "{}\n");
  }
  const { lines, write } = recorder();
  finishRoot(failed, ["window checks: exited with code 1"], write);
  for (const app of ["soksak-check-wailsv3", "soksak-check-tauriv2"]) {
    assert.equal(existsSync(join(failed, app, "services")), false, `${app}: the service folders are removed`);
    assert.equal(existsSync(join(failed, app, "logs", "host.jsonl")), true, `${app}: the logs are kept`);
  }
  assert.ok(lines.includes(`removed ${join(failed, "soksak-check-tauriv2", "services")}: the services of the run exit`), lines.join("\n"));
});

test("an interrupting signal ends the running step, runs the cleanup steps and fails the run with the signal", { timeout: 10000 }, async (t) => {
  const root = workspace(t);
  const pidFile = join(root, "check.pid");
  const cleaned = join(root, "cleaned");
  const controller = new AbortController();
  const { lines, write } = recorder();
  const steps = [
    // The rename makes the file appear with its content, so the interrupt below cannot read a file that the step has created but not written.
    step("checks", "check", `const fs = require("node:fs"); fs.writeFileSync(${JSON.stringify(`${pidFile}.partial`)}, String(process.pid)); fs.renameSync(${JSON.stringify(`${pidFile}.partial`)}, ${JSON.stringify(pidFile)}); setTimeout(() => {}, 30000);`),
    step("later checks", "check", "process.exit(0)"),
    step("cleanup", "cleanup", `require("node:fs").writeFileSync(${JSON.stringify(cleaned)}, "")`),
  ];
  const interrupt = setInterval(() => { if (existsSync(pidFile)) { clearInterval(interrupt); controller.abort("SIGTERM"); } }, 20);
  t.after(() => clearInterval(interrupt));
  let timer;
  const ended = new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error("the run did not end within 5 s of the interrupt")), 5000); });
  t.after(() => clearTimeout(timer));
  const failures = await Promise.race([runPlan(steps, { write, interrupted: controller.signal }), ended]);
  assert.deepEqual(failures, ["checks: interrupted by SIGTERM"]);
  assert.ok(lines.includes("skipped later checks: interrupted by SIGTERM"), lines.join("\n"));
  assert.ok(existsSync(cleaned), "the cleanup step did not run after the interrupt");
  const pid = Number(readFileSync(pidFile, "utf8"));
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, `the process ${pid} of the interrupted step remains`);
});

test("each end-to-end target of the Makefile names prerequisites, a window-check script and a native target that exist", { timeout: 5000 }, () => {
  const declared = (makefile) => new Set([...readFileSync(makefile, "utf8").matchAll(/^([a-z][a-z0-9-]*):/gm)].map((match) => match[1]));
  const makefile = readFileSync("Makefile", "utf8");
  const scripts = JSON.parse(readFileSync("e2e/package.json", "utf8")).scripts;
  const root = declared("Makefile");
  const native = declared("native/darwin/Makefile");
  const build = /^E2E_BUILD = (.*)$/m.exec(makefile);
  assert.ok(build !== null, "the Makefile declares E2E_BUILD");
  assert.ok(build[1].split(/\s+/).includes("build-registry"), "ordinary application targets must explicitly build their registry");
  for (const prerequisite of build[1].split(/\s+/)) assert.ok(root.has(prerequisite), `E2E_BUILD: the Makefile declares no target ${prerequisite}`);
  const runs = [...makefile.matchAll(/^\t@node scripts\/test-app\.mjs --script (\S+)(?: --native (\S+))?/gm)];
  assert.ok(runs.length > 0, "the Makefile runs scripts/test-app.mjs");
  for (const [line, script, target] of runs) {
    assert.ok(scripts[script] !== undefined, `${line.trim()}: e2e/package.json declares no script ${script}`);
    if (target !== undefined) assert.ok(native.has(target), `${line.trim()}: native/darwin/Makefile declares no target ${target}`);
  }
});
