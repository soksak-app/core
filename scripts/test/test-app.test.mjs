// The run of the end-to-end checks (scripts/test-app.mjs, docs/operations/examples.md#end-to-end-run): the steps of a run, a fresh
// configuration root for each run, the report of each step, and the failure on a process that remains after the applications quit.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs, { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startFakeEndpoint } from "@soksak/client/testing";
import { e2ePlan, finishRoot, newConfigRoot, remainingProcesses, runPlan } from "../test-app.mjs";

const node = (code) => [process.execPath, "-e", code];
const step = (name, phase, code) => ({ name, phase, kind: "run", argv: node(code), env: {} });

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), "soksak-e2e-run-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function recorder() {
  const lines = [];
  return { lines, write: (line) => lines.push(line) };
}

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

test("the plan prepares, starts both applications, checks and quits them in this order", { timeout: 5000 }, () => {
  const root = "/work";
  const configRoot = "/work/target/e2e/run";
  const plan = e2ePlan({ root, configRoot, script: "verify", native: "e2e" });
  assert.deepEqual(plan.map((item) => [item.phase, item.name]), [
    ["prepare", "registry certificates"],
    ["prepare", "install plugins wailsv3"],
    ["prepare", "install plugins tauriv2"],
    ["prepare", "start wailsv3"],
    ["prepare", "start tauriv2"],
    ["check", "window checks"],
    ["check", "native end-to-end tests"],
    ["cleanup", "quit wailsv3"],
    ["cleanup", "quit tauriv2"],
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
  assert.equal(checks.env.SOKSAK_CANDIDATE_REGISTRY, "file:///work/target/registry/index.json");
  assert.deepEqual(checks.argv.slice(2, 4), ["--script", "verify"]);
  assert.ok(!checks.argv.includes("--when-idle"));
  assert.deepEqual(plan.find((item) => item.name === "native end-to-end tests").argv, ["make", "-C", "native/darwin", "e2e"]);
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

test("a failed check does not skip the next check", { timeout: 10000 }, async () => {
  const { lines, write } = recorder();
  const failures = await runPlan([step("one", "check", "process.exit(1)"), step("two", "check", "")], { write });
  assert.deepEqual(failures, ["one: exited with code 1"]);
  assert.ok(lines.some((line) => /^passed two /.test(line)), lines.join("\n"));
});

test("a start step ends when the application writes endpoint.json and fails when the application exits first", { timeout: 10000 }, async (t) => {
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

test("a start step ends when endpoint.json is written before the watch of the folder is active", { timeout: 10000 }, async (t) => {
  // A node:fs watch of a folder returns before the FSEvents stream of macOS is active and reports nothing that changed before; at a high
  // load that time exceeds the 200 ms after which the application writes the file. The fault injection gives every node:fs watch that
  // time (no notification in the first 400 ms), so a start step that relies on a notification of the write never ends.
  const real = fs.watch;
  t.mock.method(fs, "watch", (path, ...rest) => {
    const watcher = real(path, ...rest);
    const activeAt = Date.now() + 400;
    const emit = watcher.emit.bind(watcher);
    watcher.emit = (name, ...event) => (name === "change" && Date.now() < activeAt ? false : emit(name, ...event));
    return watcher;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const configDir = workspace(t);
  const writes = `setTimeout(() => require("fs").writeFileSync(${JSON.stringify(join(configDir, "endpoint.json"))}, "{}"), 200); setInterval(() => {}, 1000)`;
  const children = new Map();
  t.after(() => children.get("app")?.kill());
  const started = { name: "start app", phase: "prepare", kind: "start", app: "app", argv: node(writes), configDir, output: join(configDir, "app.out") };
  assert.deepEqual(await runPlan([started], { write: () => {}, children }), []);
});

test("a quit step requests host.quit and ends when the application exits", { timeout: 10000 }, async (t) => {
  const app = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const fake = await startFakeEndpoint({ "command.run": (params) => { assert.equal(params.name, "host.quit"); app.kill("SIGTERM"); return null; } });
  t.after(() => fake.close());
  const children = new Map([["app", app]]);
  const failures = await runPlan([{ name: "quit app", phase: "cleanup", kind: "quit", app: "app", configDir: fake.configDir }], { write: () => {}, children });
  assert.deepEqual(failures, ["quit app: the application ended with signal SIGTERM"]);
  assert.equal(fake.requests[0].params.name, "host.quit");
});

test("a quit step ends when the process that holds the configuration lock exits, also when that process is not the started one", { timeout: 10000 }, async (t) => {
  // diagnostics.host.relaunch replaces the started application with a new process, which owns process.lock (docs/spec/endpoint.md).
  const started = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((resolve) => started.once("exit", resolve));
  const fake = await startFakeEndpoint({ "command.run": () => null });
  t.after(() => fake.close());
  const holder = spawn("lockf", [join(fake.configDir, "process.lock"), process.execPath, "-e", "process.stdout.write('held'); setTimeout(() => {}, 400)"]);
  t.after(() => holder.kill());
  await new Promise((resolve) => holder.stdout.once("data", resolve));
  const failures = await runPlan([{ name: "quit app", phase: "cleanup", kind: "quit", app: "app", configDir: fake.configDir }],
    { write: () => {}, children: new Map([["app", started]]) });
  assert.deepEqual(failures, []);
  assert.notEqual(holder.exitCode, null, "the quit step ended while the process that holds process.lock was running");
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
  for (const prerequisite of build[1].split(/\s+/)) assert.ok(root.has(prerequisite), `E2E_BUILD: the Makefile declares no target ${prerequisite}`);
  const runs = [...makefile.matchAll(/^\t@node scripts\/test-app\.mjs --script (\S+)(?: --native (\S+))?/gm)];
  assert.ok(runs.length > 0, "the Makefile runs scripts/test-app.mjs");
  for (const [line, script, target] of runs) {
    assert.ok(scripts[script] !== undefined, `${line.trim()}: e2e/package.json declares no script ${script}`);
    if (target !== undefined) assert.ok(native.has(target), `${line.trim()}: native/darwin/Makefile declares no target ${target}`);
  }
});
