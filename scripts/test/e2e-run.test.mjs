// The run of the end-to-end checks (scripts/e2e-run.mjs, docs/operations/examples.md#end-to-end-run): the steps of a run, a fresh
// configuration root for each run, the report of each step, and the failure on a process that remains after the applications quit.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startFakeEndpoint } from "@soksak/client/testing";
import { e2ePlan, finishRoot, newConfigRoot, remainingProcesses, runPlan } from "../e2e-run.mjs";

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
    "/work/target/debug/soksak-wailsv3.app/Contents/MacOS/soksak-wailsv3",
    "--config-dir", "/work/target/e2e/run/soksak-check-wailsv3",
    "--registry-ca", "/work/target/e2e/run/soksak-check-registry-tls/ca.pem",
  ]);
  const checks = plan.find((item) => item.name === "window checks");
  assert.equal(checks.env.SOKSAK_BINARY_TAURIV2, "/work/target/debug/soksak-tauriv2.app/Contents/MacOS/soksak-tauriv2");
  assert.equal(checks.env.SOKSAK_CANDIDATE_REGISTRY, "file:///work/target/registry/index.json");
  assert.deepEqual(checks.argv.slice(2, 4), ["--script", "verify"]);
  assert.ok(!checks.argv.includes("--when-idle"));
  assert.deepEqual(plan.find((item) => item.name === "native end-to-end tests").argv, ["make", "-C", "native/darwin", "e2e"]);
  const person = e2ePlan({ root, configRoot, script: "verify:person", whenIdle: "60" });
  assert.deepEqual(person.find((item) => item.name === "window checks").argv.slice(2, 4), ["--script", "verify:person"]);
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
  assert.deepEqual(await runPlan([started], { write, children }), []);
  children.get("app").kill();
  const exits = { ...started, configDir: workspace(t), argv: node("process.exit(4)") };
  const failures = await runPlan([exits], { write });
  assert.deepEqual(failures, ["start app: the application exited with code 4 before it wrote endpoint.json"]);
  assert.ok(lines.some((line) => line.startsWith("failed start app ")), lines.join("\n"));
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

test("a quit step without a started application is skipped", { timeout: 5000 }, async () => {
  const { lines, write } = recorder();
  assert.deepEqual(await runPlan([{ name: "quit app", phase: "cleanup", kind: "quit", app: "app", configDir: "/none" }], { write }), []);
  assert.ok(lines.includes("skipped quit app: app was not started"), lines.join("\n"));
});

test("a process whose command names the configuration root or an application bundle remains", { timeout: 1000 }, () => {
  const text = [
    "  101 /work/target/debug/soksak-wailsv3.app/Contents/MacOS/vt --config-dir /x",
    "  102 /usr/bin/other /tmp",
    "  103 /bin/sh -c cat /work/target/e2e/run/soksak-check-tauriv2/logs/host.jsonl",
  ].join("\n");
  assert.deepEqual(remainingProcesses(text, ["/work/target/e2e/run", "/work/target/debug/soksak-wailsv3.app"], 999),
    ["101 /work/target/debug/soksak-wailsv3.app/Contents/MacOS/vt --config-dir /x", "103 /bin/sh -c cat /work/target/e2e/run/soksak-check-tauriv2/logs/host.jsonl"]);
  assert.deepEqual(remainingProcesses("  999 node scripts/e2e-run.mjs /work/target/e2e/run", ["/work/target/e2e/run"], 999), []);
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
    mkdirSync(join(failed, app, "services", "soksak-vt-alacritty"), { recursive: true });
    writeFileSync(join(failed, app, "services", "soksak-vt-alacritty", "endpoint.json"), "{}");
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
