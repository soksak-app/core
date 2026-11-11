// The run of the end-to-end checks (scripts/test-app.mjs, docs/operations/examples.md#end-to-end-run): the steps of a run, a fresh
// configuration root for each run, the report of each step, and the failure on a process that remains after the applications quit.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { startFakeEndpoint } from "@soksak/client/testing";
import { e2ePlan, finishCandidate, finishRoot, newConfigRoot, remainingProcesses, runPlan, validateOrdinaryArtifacts, quitApplication } from "../test-app.mjs";
import { applicationArtifact, applicationExecutables } from "../platform/platform.js";
import { fixturePluginIds } from "../fixture-registry.mjs";

const node = (code) => [process.execPath, "-e", code];
// The limit of a test of a start step is the limit of the step (START_LIMIT_MS, 60 s) and some more: at a high load of the file system
// events service the watch of the folder can become active after that limit, and the read at the limit then ends the step.
const START_TEST_LIMIT_MS = 70000;
const step = (name, phase, code) => ({ name, phase, kind: "run", argv: node(code), env: {} });

test("ordinary focused acceptance owns explicit prebuilt artifacts and unchanged quit paths", async () => {
  const artifacts = {
    schema: 1,
    hosts: ["mygo", "tauriv2", "wailsv3"].map((app) => ({ app, bundle: `/prebuilt/${app}.app` })),
  };
  const plan = await e2ePlan({ root: "/source", configRoot: "/configuration/fresh", script: "test-app", artifacts, only: "window-end.test.mjs",
    platform: "darwin", fixtures: ["probe"] });
  assert.deepEqual(plan.find((item) => item.name === "fixture registry"), { name: "fixture registry", phase: "prepare", kind: "run",
    env: { SOKSAK_CONFIG_ROOT: "/configuration/fresh" }, argv: ["make", "build-fixture-registry-from-sok", "FIXTURE_SOK=/prebuilt/wailsv3.app/Contents/MacOS/sok",
      "FIXTURE_REGISTRY=/configuration/fresh/fixture-registry"] });
  for (const host of artifacts.hosts) {
    assert.equal(plan.find((item) => item.name === `start ${host.app}`).argv[0], `${host.bundle}/Contents/MacOS/sok-${host.app}`);
    assert.deepEqual(plan.find((item) => item.name === `registry ${host.app}`).argv,
      [`${host.bundle}/Contents/MacOS/sok`, "registry", "use", "/configuration/fresh/fixture-registry/index.json", "--config-dir", `/configuration/fresh/soksak-check-${host.app}`]);
    assert.equal(plan.find((item) => item.name === `install probe ${host.app}`).argv[0], `${host.bundle}/Contents/MacOS/sok`);
  }
  const checks = plan.find((item) => item.name === "window checks");
  assert.deepEqual(checks.argv.slice(-2), ["--only", "window-end.test.mjs"]);
  assert.equal(checks.env.SOKSAK_CANDIDATE_RUN_FOLDER, undefined, "ordinary focus must not claim full candidate acceptance");
  assert.deepEqual(plan.filter((item) => item.kind === "quit").map(({ app, by }) => [app, by]), [["wailsv3", "menu"], ["tauriv2", "menu"], ["mygo", "key"]]);
  assert.deepEqual(plan.find((item) => item.kind === "remaining").paths, ["/configuration/fresh", "/prebuilt/wailsv3.app", "/prebuilt/tauriv2.app", "/prebuilt/mygo.app"]);
  assert.ok(!plan.some((item) => item.argv?.includes("install-plugins")), "explicit artifacts cannot use default debug installer");
});

test("candidate plans reject ordinary file selection and artifact overrides", async () => {
  const candidate = { hosts: ["mygo", "tauriv2", "wailsv3"].map((app) => ({ app, bundle: `/candidate/${app}.app` })) };
  for (const extra of [{ only: "window-end.test.mjs" }, { artifacts: candidate }]) {
    await assert.rejects(() => e2ePlan({ root: "/source", configRoot: "/configuration", script: "test-app", candidate, ...extra }), /candidate.*(selection|artifacts|override)/);
  }
});

test("ordinary artifact input rejects relative paths, incomplete hosts and existing configuration data", (t) => {
  const input = { schema: 1, hosts: ["mygo", "tauriv2", "wailsv3"].map((app) => ({ app, bundle: `/prebuilt/${app}.app` })) };
  assert.equal(validateOrdinaryArtifacts(input), input);
  const change = (fn) => { const value = structuredClone(input); fn(value); return value; };
  assert.throws(() => validateOrdinaryArtifacts(change((v) => { v.hosts[0].bundle = "relative.app"; })), /bundle must be absolute/);
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

test("a window run waits for no idle time of the person: the runner and the make targets have no idle option", { timeout: 10000 }, () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("../test-app.mjs", import.meta.url)), "--when-idle", "5"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown option '--when-idle'/);
  const cwd = fileURLToPath(new URL("../../", import.meta.url));
  for (const target of ["test-app", "test-app-capture-input-close"]) {
    const planned = spawnSync("make", ["--no-print-directory", "-n", target, "WHEN_IDLE=60"], { cwd, encoding: "utf8" });
    assert.equal(planned.status, 0, planned.stderr);
    assert.doesNotMatch(planned.stdout, /--when-idle/, `make ${target} passes an idle wait`);
  }
});

test("a window check leaves the default run only where the input that the host emulates cannot reach what it judges", { timeout: 10000 }, () => {
  // The host emulates the keyboard and the pointer inside the application, so a check runs in the default run unless what it judges
  // follows the system: the input method of the really active application, the local event monitors of AppKit, the change of the
  // real key window, the system cursor, or a system panel (docs/operations/examples.md#end-to-end-run).
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const checks = (folder) => readdirSync(join(root, "e2e", folder)).filter((name) => name.endsWith(".test.mjs")).sort();
  assert.deepEqual(checks("activation"), ["ime.test.mjs", "marked-text.test.mjs", "picker-press-outside.test.mjs",
    "registry-active.test.mjs", "view-focus.test.mjs", "view-ime-escape.test.mjs"]);
  assert.deepEqual(checks("real"), ["card-chrome.test.mjs"]);
  assert.deepEqual(checks("person"), ["debug-save.test.mjs"]);
  assert.equal(existsSync(join(root, "packages/window-check/hid.mjs")), false,
    "the published window-check package keeps a tool that posts real input");
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
  const context = { candidate: { artifacts: [] }, assets: [] };
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

test("the plan prepares, starts the three applications, checks and quits them in this order", { timeout: 5000 }, async () => {
  const root = "/work";
  const configRoot = "/work/target/e2e/run";
  const plan = await e2ePlan({ root, configRoot, script: "verify", native: "e2e", platform: "darwin", fixtures: ["probe", "probe2"] });
  assert.deepEqual(plan.map((item) => [item.phase, item.name]), [
    ["prepare", "registry certificates"],
    ...["wailsv3", "tauriv2", "mygo"].flatMap((app) => [
      ["prepare", `registry ${app}`], ["prepare", `install probe ${app}`], ["prepare", `install probe2 ${app}`]]),
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
  // A person quits through the quit item of the application menu or the quit key: the last application ends by the key.
  assert.deepEqual(plan.filter((item) => item.kind === "quit").map((item) => [item.app, item.by]),
    [["wailsv3", "menu"], ["tauriv2", "menu"], ["mygo", "key"]]);
  assert.equal(checks.env.SOKSAK_CANDIDATE_REGISTRY, "file:///work/target/fixture-registry/index.json");
  // The debug bundles install the fixtures of the checkout through the sok of each bundle, and no step builds or installs the
  // workspace registry.
  assert.deepEqual(plan.find((item) => item.name === "registry wailsv3").argv, ["/work/target/debug/sok-wailsv3.app/Contents/MacOS/sok",
    "registry", "use", "/work/target/fixture-registry/index.json", "--config-dir", "/work/target/e2e/run/soksak-check-wailsv3"]);
  assert.deepEqual(plan.find((item) => item.name === "install probe2 mygo").argv, ["/work/target/debug/sok-mygo.app/Contents/MacOS/sok",
    "plugin", "install", "probe2", "--config-dir", "/work/target/e2e/run/soksak-check-mygo"]);
  assert.ok(!/install-plugins|target\/registry|build-registry|workspace-registry/.test(JSON.stringify(plan)), "the plan names the workspace registry");
  assert.deepEqual(checks.argv.slice(2, 4), ["--script", "verify"]);
  assert.ok(!checks.argv.includes("--when-idle"));
  assert.deepEqual(plan.find((item) => item.name === "native end-to-end tests"), { name: "native end-to-end tests", phase: "check", kind: "native",
    target: "e2e", platform: "darwin", env: { SOKSAK_CONFIG_ROOT: configRoot } });
  assert.equal(plan.some((item) => item.name === "capture text warm-up"), false);
  const person = await e2ePlan({ root, configRoot, script: "test-app:person", platform: "darwin" });
  assert.deepEqual(person.find((item) => item.name === "window checks").argv.slice(2, 4), ["--script", "test-app:person"]);
  assert.ok(!person.find((item) => item.name === "window checks").argv.includes("--when-idle"));
  assert.equal(person.some((item) => item.name === "native end-to-end tests"), false);
});

test("test-app resolves the executables of each platform from its declared application artifact", { timeout: 5000 }, async () => {
  const root = "/work";
  const configRoot = "/work/target/e2e/run";
  const plan = await e2ePlan({ root, configRoot, script: "test-app", native: "test-app", platform: "darwin" });
  const checks = plan.find((item) => item.name === "window checks");
  for (const app of ["wailsv3", "tauriv2", "mygo"]) {
    const artifact = await applicationArtifact(join(root, "target", "debug"), app, { platform: "darwin" });
    const { application } = await applicationExecutables(artifact, app, { platform: "darwin" });
    assert.equal(plan.find((item) => item.name === `start ${app}`).argv[0], application, app);
    assert.equal(checks.env[`SOKSAK_BINARY_${app.toUpperCase()}`], application, app);
    assert.ok(plan.find((item) => item.name === "remaining processes").paths.includes(artifact), app);
  }
  // A platform without a declared application artifact fails before any step can start an application, with the named operation.
  for (const platform of ["linux", "win32"]) {
    await assert.rejects(() => e2ePlan({ root, configRoot, script: "test-app", platform }),
      { name: "PlatformOperationNotImplemented", message: `applicationArtifact is not implemented on ${platform}` }, platform);
  }
  // Prebuilt artifacts name their artifacts, and the executables inside them still come from the platform declaration.
  const artifacts = { schema: 1, hosts: ["mygo", "tauriv2", "wailsv3"].map((app) => ({ app, bundle: `/prebuilt/${app}` })) };
  for (const platform of ["linux", "win32"]) {
    await assert.rejects(() => e2ePlan({ root, configRoot: "/configuration/fresh", script: "test-app", artifacts, platform }),
      { name: "PlatformOperationNotImplemented", message: `applicationExecutables is not implemented on ${platform}` }, platform);
  }
});

test("the test-app plan carries platform operations as neutral steps, with no quit key, menu key or program of a platform", { timeout: 5000 }, async () => {
  const plan = await e2ePlan({ root: "/work", configRoot: "/work/target/e2e/run", script: "test-app", native: "test-app", platform: "darwin" });
  assert.deepEqual(plan.filter((item) => item.kind === "quit").map(({ name, phase, kind, by, app, configDir, platform }) =>
    ({ name, phase, kind, by, app, configDir, platform })), plan.filter((item) => item.kind === "quit"));
  assert.deepEqual(plan.find((item) => item.kind === "native"), { name: "native end-to-end tests", phase: "check", kind: "native",
    target: "test-app", platform: "darwin", env: { SOKSAK_CONFIG_ROOT: "/work/target/e2e/run" } });
  assert.deepEqual(Object.keys(plan.find((item) => item.kind === "remaining")).sort(), ["kind", "name", "paths", "phase", "platform"]);
  const text = JSON.stringify(plan);
  for (const term of ["shortcut", "cmd", "command", "Command", "lockf", "\"ps\"", "native/darwin", "Library"]) {
    assert.ok(!text.includes(term), `the plan names ${term}`);
  }
});

test("a quit step quits through the platform operation of its platform and fails with the named error on a platform without it", { timeout: 10000 }, async (t) => {
  const app = await quittingApplication(t);
  const fake = await startFakeEndpoint({});
  t.after(() => fake.close());
  for (const platform of ["linux", "win32"]) {
    const failures = await runPlan([{ name: "quit app", phase: "cleanup", kind: "quit", platform, by: "key", app: "app", configDir: fake.configDir }],
      { write: () => {}, children: new Map([["app", app]]) });
    assert.deepEqual(failures, [`quit app: quitApplication is not implemented on ${platform}`]);
  }
  assert.deepEqual(fake.requests, [], "a platform without the quit operation sends no request");
});

test("a native step and a remaining step fail with the named error on a platform without the operation, and are not skipped", { timeout: 10000 }, async () => {
  const { lines, write } = recorder();
  const failures = await runPlan([
    { name: "native end-to-end tests", phase: "check", kind: "native", target: "test-app", platform: "linux", env: {} },
    { name: "remaining processes", phase: "cleanup", kind: "remaining", paths: ["/never"], platform: "win32" },
  ], { write });
  assert.deepEqual(failures, ["native end-to-end tests: runNativeTests is not implemented on linux",
    "remaining processes: listProcesses is not implemented on win32"]);
  assert.equal(lines.some((line) => line.startsWith("skipped")), false, lines.join("\n"));
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

test("a candidate plan builds the fixture registry of its checkout with its bundled installers and reads no context registry", { timeout: 5000 }, async () => {
  const candidate = { hosts: ["mygo", "tauriv2", "wailsv3"].map((app) => ({ app, bundle: `/candidate/${app}.app` })) };
  const plan = await e2ePlan({ root: "/work", configRoot: "/work/target/e2e/run", script: "test-app",
    native: "test-app", candidate, runFolder: "/work/target/test-runs/candidate", platform: "darwin", fixtures: ["fixture"] });
  assert.equal(plan.some((step) => step.argv?.includes("install-plugins")), false);
  assert.deepEqual(plan.find((step) => step.name === "fixture registry").argv, ["make", "build-fixture-registry-from-sok",
    "FIXTURE_SOK=/candidate/wailsv3.app/Contents/MacOS/sok", "FIXTURE_REGISTRY=/work/target/e2e/run/fixture-registry"]);
  assert.deepEqual(plan.find((step) => step.name === "registry wailsv3").argv,
    ["/candidate/wailsv3.app/Contents/MacOS/sok", "registry", "use", "/work/target/e2e/run/fixture-registry/index.json", "--config-dir", "/work/target/e2e/run/soksak-check-wailsv3"]);
  assert.deepEqual(plan.find((step) => step.name === "install fixture wailsv3").argv,
    ["/candidate/wailsv3.app/Contents/MacOS/sok", "plugin", "install", "fixture", "--config-dir", "/work/target/e2e/run/soksak-check-wailsv3"]);
  assert.equal(plan.find((step) => step.name === "start wailsv3").argv[0], "/candidate/wailsv3.app/Contents/MacOS/sok-wailsv3");
  const check = plan.find((step) => step.name === "window checks");
  assert.equal(check.env.SOKSAK_CANDIDATE_RUN_FOLDER, "/work/target/test-runs/candidate");
  assert.equal(check.env.SOKSAK_CANDIDATE_REGISTRY, "file:///work/target/e2e/run/fixture-registry/index.json");
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
  const pending = quitApplication({ app: "fixture", platform: "darwin", by: "menu", configDir }, new Map([["fixture", child]]), 0, () => {}, () => new Promise((resolve) => { arrive = resolve; }));
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

test("quit deadline closes a pending RPC and runs the remaining quit and process audit", { timeout: 10000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const firstDir = workspace(t), nextDir = workspace(t);
  let release, entered;
  const requested = new Promise((resolve) => { entered = resolve; });
  let firstClosed = 0, nextClosed = 0;
  const first = { request: async (method) => {
    if (method === "status.get") return MENUS;
    entered(); return new Promise((resolve) => { release = resolve; });
  }, close() { firstClosed++; } };
  const next = { request: async (method) => method === "status.get" ? MENUS : null, close() { nextClosed++; } };
  const { lines, write } = recorder();
  const item = (app, configDir) => ({ name: `quit ${app}`, phase: "cleanup", kind: "quit", platform: "darwin", by: "menu", app, configDir });
  const listed = [];
  const processes = async ({ platform }) => { listed.push(platform); return []; };
  const pending = runPlan([item("first", firstDir), item("next", nextDir), { name: "remaining processes", phase: "cleanup", kind: "remaining", paths: [], platform: "darwin" }],
    { write, children: new Map([["first", { exitCode: 0, signalCode: null }], ["next", { exitCode: 0, signalCode: null }]]), connectClient: async ({ configDir }) => configDir === firstDir ? first : next,
      processes });
  t.after(async () => { release(null); await pending; });
  await requested;
  t.mock.timers.tick(60_000);
  // The pending Quit RPC stays pending: the plan ends without it, or the test reaches its limit.
  const failures = await pending;
  assert.equal(failures.length, 1);
  assert.match(failures[0], /quit first:.*60s/);
  assert.equal(firstClosed, 1);
  assert.equal(nextClosed, 1);
  assert.ok(lines.some((line) => line.startsWith("passed quit next")), lines.join("\n"));
  assert.ok(lines.some((line) => line.startsWith("passed remaining processes")), lines.join("\n"));
  assert.deepEqual(listed, ["darwin"]);
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
  const failures = await runPlan([{ name: "quit app", phase: "cleanup", kind: "quit", platform: "darwin", by: "menu", app: "app", configDir: fake.configDir }],
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
  const failures = await runPlan([{ name: "quit app", phase: "cleanup", kind: "quit", platform: "darwin", by: "key", app: "app", configDir: fake.configDir }],
    { write: () => {}, children: new Map([["app", app]]) });
  assert.deepEqual(failures, []);
  assert.deepEqual(keys, ["down", "up"].map((phase) => ({ window: "w1", key: "q", text: "q", modifiers: ["command"], phase })));
});

test("a quit step fails when the application ends with another status than 0 after its Quit item", { timeout: 10000 }, async (t) => {
  const app = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const fake = await startFakeEndpoint({ "status.get": () => MENUS, "command.run": () => { app.kill("SIGTERM"); return null; } });
  t.after(() => fake.close());
  const failures = await runPlan([{ name: "quit app", phase: "cleanup", kind: "quit", platform: "darwin", by: "menu", app: "app", configDir: fake.configDir }],
    { write: () => {}, children: new Map([["app", app]]) });
  assert.deepEqual(failures, ["quit app: the application ended with signal SIGTERM"]);
});

test("a quit step fails when the application menu has no item with the key equivalent cmd+q", { timeout: 10000 }, async (t) => {
  const app = await quittingApplication(t);
  const fake = await startFakeEndpoint({ "status.get": () => ({ language: "en", menus: [MENUS.menus[1]] }) });
  t.after(() => fake.close());
  const failures = await runPlan([{ name: "quit app", phase: "cleanup", kind: "quit", platform: "darwin", by: "menu", app: "app", configDir: fake.configDir }],
    { write: () => {}, children: new Map([["app", app]]) });
  assert.deepEqual(failures, ["quit app: the application menu has no item with the key equivalent cmd+q"]);
});

test("a quit step ends when the process that holds the configuration lock exits, also when that process is not the started one", { timeout: 10000 }, async (t) => {
  // diagnostics.host.relaunch replaces the started application with a new process, which owns process.lock (docs/spec/endpoint.md).
  const started = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((resolve) => started.once("exit", resolve));
  const fake = await startFakeEndpoint({ "status.get": () => MENUS, "command.run": () => null });
  t.after(() => fake.close());
  // The lock release wait of the platform is replaced by one that returns when the holder exits, as the kernel wakes the wait of the
  // platform when the owner of the lock exits (scripts/test/platform/darwin/end-to-end.test.mjs checks the wait of macOS).
  const lock = join(fake.configDir, "process.lock");
  writeFileSync(lock, "");
  const holder = spawn(process.execPath, ["-e", "process.stdout.write('held'); setTimeout(() => {}, 400)"], { stdio: ["ignore", "pipe", "ignore"] });
  t.after(() => holder.kill());
  const holderExit = new Promise((resolve) => holder.once("exit", resolve));
  await new Promise((resolve) => holder.stdout.once("data", resolve));
  const waits = [];
  const lockRelease = async (path, seconds, { platform }) => { waits.push([path, seconds, platform]); await holderExit; return true; };
  const failures = await runPlan([{ name: "quit app", phase: "cleanup", kind: "quit", platform: "darwin", by: "menu", app: "app", configDir: fake.configDir }],
    { write: () => {}, children: new Map([["app", started]]), lockRelease });
  assert.deepEqual(failures, []);
  assert.deepEqual(waits, [[lock, 60, "darwin"]]);
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

test("a process whose executable or arguments name the configuration root or an application artifact remains", { timeout: 1000 }, () => {
  const processes = [
    { pid: 101, ppid: 1, executable: "/work/target/debug/sok-wailsv3/vt", arguments: "vt --config-dir /x" },
    { pid: 102, ppid: 1, executable: "/usr/bin/other", arguments: "/usr/bin/other /tmp" },
    { pid: 103, ppid: 1, executable: "/bin/sh", arguments: "/bin/sh -c cat /work/target/e2e/run/soksak-check-tauriv2/logs/host.jsonl" },
  ];
  assert.deepEqual(remainingProcesses(processes, ["/work/target/e2e/run", "/work/target/debug/sok-wailsv3"], 999),
    ["101 vt --config-dir /x", "103 /bin/sh -c cat /work/target/e2e/run/soksak-check-tauriv2/logs/host.jsonl"]);
  assert.deepEqual(remainingProcesses([{ pid: 999, ppid: 1, executable: "node", arguments: "node scripts/test-app.mjs /work/target/e2e/run" }],
    ["/work/target/e2e/run"], 999), []);
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
    mkdirSync(join(failed, app, "services", "sok-rasterprobe"), { recursive: true });
    writeFileSync(join(failed, app, "services", "sok-rasterprobe", "endpoint.json"), "{}");
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
  assert.deepEqual(build[1].split(/\s+/).filter((target) => /registry/.test(target)), ["build-fixture-registry"],
    "E2E_BUILD builds the fixture registry and no workspace registry");
  for (const prerequisite of build[1].split(/\s+/)) assert.ok(root.has(prerequisite), `E2E_BUILD: the Makefile declares no target ${prerequisite}`);
  const runs = [...makefile.matchAll(/^\t@node scripts\/test-app\.mjs --script (\S+)(?: --native (\S+))?/gm)];
  assert.ok(runs.length > 0, "the Makefile runs scripts/test-app.mjs");
  for (const [line, script, target] of runs) {
    assert.ok(scripts[script] !== undefined, `${line.trim()}: e2e/package.json declares no script ${script}`);
    if (target !== undefined) assert.ok(native.has(target), `${line.trim()}: native/darwin/Makefile declares no target ${target}`);
  }
});

test("the fixture registry of a prebuilt run builds the fake sidecars and the registry with the sok of the bundle and builds no sok", { timeout: 10000 }, () => {
  const planned = spawnSync("make", ["--no-print-directory", "-n", "build-fixture-registry-from-sok", "FIXTURE_SOK=/candidate/sok", "FIXTURE_REGISTRY=/run/fixture-registry"],
    { encoding: "utf8" });
  assert.equal(planned.status, 0, planned.stderr);
  assert.match(planned.stdout, /node scripts\/fixture-registry\.mjs --sok "\/candidate\/sok" --out "\/run\/fixture-registry"/);
  assert.match(planned.stdout, /for dir in e2e\/fixtures\/sidecars\/\S+.*pnpm --dir "\$dir" run build[^\n]*\nnode scripts\/fixture-registry/,
    "the fake sidecars build before the registry");
  assert.doesNotMatch(planned.stdout, /soksak-sok|workspace-registry/);
  const debug = spawnSync("make", ["--no-print-directory", "-n", "build-fixture-registry"], { encoding: "utf8" });
  assert.equal(debug.status, 0, debug.stderr);
  assert.match(debug.stdout, /build --locked -p soksak-sok/);
  assert.match(debug.stdout, /build-fixture-registry-from-sok FIXTURE_SOK=target\/debug\/sok FIXTURE_REGISTRY=target\/fixture-registry/);
});

test("the plan installs every fixture plugin of e2e/fixtures by default", { timeout: 5000 }, async () => {
  const plan = await e2ePlan({ root: "/work", configRoot: "/run", script: "test-app", platform: "darwin" });
  const installs = plan.filter((item) => item.name.startsWith("install ") && item.name.endsWith(" mygo")).map((item) => item.argv[3]);
  assert.deepEqual(installs, fixturePluginIds());
  assert.ok(installs.includes("layoutprobe"), "the default tab of fresh is a fixture plugin");
});
