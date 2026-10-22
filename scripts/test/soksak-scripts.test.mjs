import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
  mkdir,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { BREAKS } from "../../packages/soksak/scripts/breaks.mjs";
import { find as findReleaseMarkers } from "../check-release.mjs";
import { auditHostPairs, findStubs, findUndecodedCommandArguments } from "../check-hosts.mjs";
import { auditE2ESource } from "../check-e2e.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const packageRoot = join(root, "packages/soksak");
const node = process.execPath;

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? root,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

test("bounded command propagates success and reports its deadline", { timeout: 5000 }, async () => {
  const quick = await run(node, [
    join(packageRoot, "scripts/bounded.mjs"),
    "1000",
    node,
    "-e",
    "process.exit(0)",
  ]);
  assert.equal(quick.code, 0, quick.stderr);

  const timedOut = await run(node, [
    join(packageRoot, "scripts/bounded.mjs"),
    "30",
    node,
    "-e",
    "setTimeout(() => {}, 1000)",
  ]);
  assert.equal(timedOut.code, 124, timedOut.stderr);
});

test("deliberate breaks are uniquely anchored and actionable", { timeout: 2000 }, () => {
  assert.ok(BREAKS.length > 0);
  const ids = new Set();
  for (const entry of BREAKS) {
    assert.match(entry.id, /^[a-z0-9-]+$/);
    assert.equal(ids.has(entry.id), false, `duplicate break id: ${entry.id}`);
    ids.add(entry.id);
    assert.match(entry.file, /^dist\/[a-zA-Z0-9._-]+\.js$/);
    assert.equal(typeof entry.find, "string");
    assert.notEqual(entry.find.length, 0);
    assert.equal(typeof entry.to, "string");
  }
});

test("fuzz runner executes a bounded deterministic smoke case", { timeout: 5000 }, async () => {
  const result = await run(node, [join(packageRoot, "scripts/fuzz.mjs"), "1", "1"], { cwd: packageRoot });
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /0\/1 seeds failed/);
});

test("DOM declaration emitter is idempotent and preserves the declaration", { timeout: 5000 }, async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "soksak-dom-reference-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const scripts = join(fixture, "scripts");
  const dist = join(fixture, "dist");
  await mkdir(scripts, { recursive: true });
  await mkdir(dist, { recursive: true });
  const source = await readFile(join(packageRoot, "scripts/emit-dom-reference.mjs"), "utf8");
  await writeFile(join(scripts, "emit-dom-reference.mjs"), source);
  const declaration = "export declare const element: HTMLElement;\n";
  await writeFile(join(dist, "dom.d.ts"), declaration);

  const script = join(scripts, "emit-dom-reference.mjs");
  const first = await run(node, [script], { cwd: fixture });
  assert.equal(first.code, 0, first.stderr);
  const expected = `/// <reference lib="dom" />\n${declaration}`;
  assert.equal(await readFile(join(dist, "dom.d.ts"), "utf8"), expected);

  const second = await run(node, [script], { cwd: fixture });
  assert.equal(second.code, 0, second.stderr);
  assert.equal(await readFile(join(dist, "dom.d.ts"), "utf8"), expected);
});

test("boundary audit reports a clean component graph", { timeout: 5000 }, async () => {
  const result = await run(node, [join(root, "scripts/check-boundaries.mjs")]);
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Boundary checks passed:/);
});

test("boundary audit reports core sources that name a declared plugin or sidecar", { timeout: 5000 }, async (t) => {
  // The fixture names are joined from parts: the boundary audit scans this file for @soksak/ names.
  const scoped = (name) => ["@soksak", name].join("/");
  const fixture = await mkdtemp(join(tmpdir(), "soksak-boundaries-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const core = join(fixture, "core");
  const write = async (path, text) => {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, text);
  };
  await write(join(core, "packages/a/package.json"), JSON.stringify({ name: scoped("a") }));
  await write(join(core, "packages/a/index.js"), `export const id = "probe";\nimport "${scoped("sidecar-probe")}";\n`);
  await write(join(core, "scripts/workspace-registry.json"), JSON.stringify({
    plugins: ["../plugins/probe"], sidecars: [{ repository: "../sidecars/probe", folder: "." }], packs: [],
  }));
  await write(join(fixture, "plugins/probe/package.json"), JSON.stringify({ name: scoped("plugin-probe") }));
  await write(join(fixture, "plugins/probe/plugin.json"), JSON.stringify({ id: "probe" }));
  await write(join(fixture, "sidecars/probe/package.json"), JSON.stringify({ name: scoped("sidecar-probe") }));
  assert.equal((await run("git", ["init", "--quiet", core])).code, 0);
  // The audit reads the tracked files of the checkout.
  assert.equal((await run("git", ["-C", core, "add", "--", "packages", "scripts"])).code, 0);
  const script = join(root, "scripts/check-boundaries.mjs");
  const named = await run(node, [script, core]);
  assert.equal(named.code, 1, `${named.stdout}\n${named.stderr}`);
  assert.deepEqual(named.stderr.trim().split("\n"), [
    `packages/a/index.js:2: core source names ${scoped("sidecar-probe")}, which is not a core package`,
    `packages/a/index.js:1: core ${scoped("a")} names plugin id probe`,
  ]);
  await rm(join(fixture, "sidecars/probe"), { recursive: true });
  const missing = await run(node, [script, core]);
  assert.equal(missing.code, 1, missing.stdout);
  assert.match(missing.stderr, /sidecars\/probe\/package\.json/);
});

test("boundary audit resolves the declared repositories from a worktree of the core checkout", { timeout: 20000 }, async (t) => {
  const scoped = (name) => ["@soksak", name].join("/");
  // A worktree under <main>/.claude/worktrees/ has the declarations of the main checkout, and the declared sibling repositories
  // are siblings of the main checkout, not of the worktree.
  const fixture = await mkdtemp(join(tmpdir(), "soksak-boundaries-worktree-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const core = join(fixture, "core");
  const write = async (path, text) => {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, text);
  };
  await write(join(core, "packages/a/package.json"), JSON.stringify({ name: scoped("a") }));
  await write(join(core, "packages/a/index.js"), 'export const id = "clean";\n');
  await write(join(core, "scripts/workspace-registry.json"), JSON.stringify({
    plugins: ["../plugins/probe"], sidecars: [{ repository: "../sidecars/probe", folder: "." }], packs: [],
  }));
  await write(join(fixture, "plugins/probe/package.json"), JSON.stringify({ name: scoped("plugin-probe") }));
  await write(join(fixture, "plugins/probe/plugin.json"), JSON.stringify({ id: "probe" }));
  await write(join(fixture, "sidecars/probe/package.json"), JSON.stringify({ name: scoped("sidecar-probe") }));
  const git = ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid"];
  assert.equal((await run("git", ["init", "--quiet", core])).code, 0);
  assert.equal((await run("git", ["-C", core, "add", "--", "packages", "scripts"])).code, 0);
  assert.equal((await run("git", [...git, "-C", core, "commit", "--quiet", "-m", "fixture"])).code, 0);
  const worktree = join(core, ".claude/worktrees/probe");
  const added = await run("git", ["-C", core, "worktree", "add", "--quiet", "--detach", worktree]);
  assert.equal(added.code, 0, added.stderr);
  const result = await run(node, [join(root, "scripts/check-boundaries.mjs"), worktree]);
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Boundary checks passed: 3 components/);
});

test("native and host contract tests stage the frontend without resetting an application bundle", { timeout: 60000 }, async () => {
  // A test run must not remove the executable of the debug app that window checks use. It only reads the plan and does not run it.
  for (const target of ["native-test", "host-contract-check"]) {
    const plan = await run("make", ["-n", target], { cwd: root });
    assert.equal(plan.code, 0, plan.stderr);
    assert.deepEqual(plan.stdout.split("\n").filter((line) => /rm -rf \S*\.app\/Contents/.test(line)), [],
      `${target} removes an application bundle`);
  }
});

test("host structure audit reports a clean paired-host graph", { timeout: 5000 }, async () => {
  const result = await run(node, [join(root, "scripts/check-hosts.mjs")]);
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Host structure checks passed:/);
});

test("host structure audit rejects a missing host and a missing counterpart", { timeout: 1000 }, () => {
  const pairs = [{ left: "hosts/wails", right: "hosts/tauri", rows: [] }];
  assert.deepEqual(auditHostPairs(["hosts/wails/src/host.go"], pairs), ["hosts/tauri: no files", "hosts/wails/src/host: no counterpart in hosts/tauri"]);
  assert.deepEqual(auditHostPairs(["hosts/wails/src/host.go", "hosts/tauri/src/host.rs", "hosts/tauri/src/extra.rs"], pairs), ["hosts/tauri/src/extra: no counterpart in hosts/wails"]);
});

test("host structure audit reads the allowed file differences from the table rows", { timeout: 1000 }, async () => {
  const hostsSpec = await readFile(join(root, "docs/spec/hosts.md"), "utf8");
  const withoutH1 = hostsSpec.split("\n").filter((line) => !line.startsWith("| H1 |")).join("\n");
  const tracked = ["packages/host/wailsv3/src/host.go", "packages/host/tauriv2/src/host.rs", "packages/host/tauriv2/build.rs"];
  assert.throws(() => auditHostPairs(tracked, undefined, withoutH1), /H1/);
  const pairs = [{ left: "hosts/wails", right: "hosts/tauri", rows: ["H1"] }];
  assert.deepEqual(auditHostPairs(["hosts/wails/src/host.go", "hosts/tauri/src/host.rs", "hosts/tauri/build.rs"], pairs, hostsSpec), []);
  assert.deepEqual(auditHostPairs(["hosts/wails/src/host.go", "hosts/tauri/src/host.rs", "hosts/tauri/src/extra.rs"], pairs, hostsSpec), ["hosts/tauri/src/extra: no counterpart in hosts/wails"]);
});

test("command argument audit rejects a Tauri command argument that the framework decodes", { timeout: 1000 }, () => {
  const source = `
#[tauri::command]
fn place(window: Window, request: Argument<PlaceRequest>) -> Result<(), String> {}

#[tauri::command(async)]
fn run(
    plugins: tauri::State<'_, Plugins>,
    id: String,
) -> Result<(), String> {}
`;
  assert.deepEqual(findUndecodedCommandArguments(source, "bindings.rs"),
    ["bindings.rs: command run argument id is String, not Argument<T>"]);
});

test("stub audit reads every product source file and reports a file it cannot read", { timeout: 1000 }, () => {
  const files = {
    "native/darwin/src/a.m": "// TODO: Implement the panel\n",
    "packages/host/wailsv3/src/a.go": "func f() {}\n",
    "packages/host/wailsv3/tests/a_test.go": "// TODO: Implement later\n",
    "packages/host/wailsv3/src/platform/windows/unsupported.go": "// not yet implemented\n",
  };
  assert.deepEqual(findStubs(Object.keys(files), (file) => files[file]), ["native/darwin/src/a.m:1: TODO:\\s*Implement"]);
  assert.throws(() => findStubs(["native/darwin/src/a.m"], () => { throw new Error("EACCES: permission denied"); }),
    /native\/darwin\/src\/a\.m: EACCES: permission denied/);
});

test("window-source audit rejects forbidden control paths", { timeout: 5000 }, async () => {
  const result = await run(node, [join(root, "scripts/check-e2e.mjs")]);
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Window check sources use only the endpoint/);
});

test("window-source audit rejects a source path of another repository component", { timeout: 1000 }, () => {
  for (const line of [
    'import { THEMES } from "../packages/workbench/settings.js";',
    'const { THEMES } = await import("../packages/workbench/settings.js");',
    'readFileSync(join(root, "plugins/probe/plugin.json"));',
  ]) {
    const errors = auditE2ESource(line, "e2e/fixture.test.mjs");
    assert.equal(errors.length, 1, `${line}: ${JSON.stringify(errors)}`);
    assert.match(errors[0], /source path of another repository component/);
  }
  assert.deepEqual(auditE2ESource('import { APPS } from "./app.mjs";', "e2e/fixture.test.mjs"), []);
});

test("window-source audit requires window-check cleanup through the session", { timeout: 1000 }, () => {
  const line = "t.after(() => server.close());";
  assert.deepEqual(auditE2ESource(line, "e2e/fixture.test.mjs"), [
    "e2e/fixture.test.mjs:1: uses t.after for cleanup; register it with session.cleanup",
  ]);
  assert.deepEqual(auditE2ESource(line, "e2e/real/fixture.test.mjs").length, 1);
  assert.deepEqual(auditE2ESource(line, "packages/window-check/app.mjs"), []);
  assert.deepEqual(auditE2ESource(line, "e2e/test/fixture.test.mjs"), []);
  assert.deepEqual(auditE2ESource("s.cleanup(() => server.close());", "e2e/fixture.test.mjs"), []);
});

test("window-source audit rejects native input that activates the application", { timeout: 1000 }, () => {
  const errors = auditE2ESource(
    'await session.pointer(x, y, "move", { activate: true });',
    "e2e/fixture.mjs",
  );
  assert.deepEqual(errors, [
    "e2e/fixture.mjs:1: uses application activation that takes user focus",
  ]);
  assert.deepEqual(auditE2ESource('await session.pointer(x, y, "move");', "e2e/clean.mjs"), []);
});

test("window-source audit allows activation only in the activation tier", { timeout: 1000 }, () => {
  const line = 'await session.pointer(x, y, "move", { activate: true });';
  assert.deepEqual(auditE2ESource(line, "e2e/activation/ime.test.mjs"), []);
  assert.equal(auditE2ESource(line, "e2e/probe.test.mjs").length, 1);
  assert.equal(auditE2ESource(line, "e2e/activation-like.test.mjs").length, 1);
});

test("window-source audit allows activation in the real-input tier and input pacing only in its tool", { timeout: 1000 }, () => {
  const line = 'await session.pointer(x, y, "move", { activate: true });';
  assert.deepEqual(auditE2ESource(line, "e2e/real/probe.test.mjs"), []);
  const pacing = "  if (step.wait) delay(step.wait / 1000);";
  assert.deepEqual(auditE2ESource(pacing, "e2e/real/hid.mjs"), []);
  assert.deepEqual(auditE2ESource(pacing, "e2e/real/probe.test.mjs"), ["e2e/real/probe.test.mjs:1: uses a fixed sleep"]);
  assert.deepEqual(auditE2ESource(pacing, "e2e/probe.test.mjs"), ["e2e/probe.test.mjs:1: uses a fixed sleep"]);
});

test("exposure audit verifies every declared core entry", { timeout: 5000 }, async () => {
  const result = await run(node, [join(root, "scripts/check-exposure.mjs")]);
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Exposure checks passed: core/);
});

// The limit bounds a hang: the audit starts the node, pnpm and shasum commands, and `pnpm --version` takes about 2 s alone, more than
// 5 s when the push gate runs the package tests in parallel (F244-1).
test("build environment audit reports the measured toolchain", { timeout: 30000 }, async () => {
  const result = await run("sh", [join(root, "scripts/check-build-environment.sh")]);
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /BUILD_ENVIRONMENT_READY node=v\S+ pnpm=\S+ runtime=\S+\/\S+ lockSHA256=[a-f0-9]{64}/);
});

test("break inventory lists only requested, known entries", { timeout: 5000 }, async () => {
  const copies = async () => (await readdir(tmpdir())).filter((name) => name.startsWith("soksak-breaks-"));
  const before = new Set(await copies());
  const result = await run(node, [
    join(packageRoot, "scripts/check-breaks.mjs"),
    "state",
    "--list",
  ]);
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /^state\tdist\/soksak\.js\t/m);
  assert.doesNotMatch(result.stdout, /^frozen\t/m);

  const invalid = await run(node, [
    join(packageRoot, "scripts/check-breaks.mjs"),
    "not-a-break",
    "--list",
  ]);
  assert.equal(invalid.code, 2);
  assert.match(invalid.stderr, /Unknown break id/);
  // A list and an invalid id need no copy with an injected defect, so no copy is made.
  assert.deepEqual((await copies()).filter((name) => !before.has(name)), [],
    "listing or rejecting break ids left a package copy");
});

test("mutation inventory lists candidates without running the mutation suite", { timeout: 5000 }, async () => {
  const result = await run(node, [join(packageRoot, "scripts/mutate.mjs"), "--list"]);
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /mutation candidates/);
  assert.match(result.stdout, /\.js:/);
  assert.doesNotMatch(result.stdout, /score /);
});

test("release marker scanner reports diagnostics and ignores clean content", { timeout: 2000 }, () => {
  const errors = [];
  findReleaseMarkers(errors, "fixture.js", "const x = diagnostics.fixture();");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /diagnostic method/);

  const clean = [];
  findReleaseMarkers(clean, "clean.js", "export const ready = true;");
  assert.deepEqual(clean, []);
});

test("release marker scanner finds the diagnostic registry authority argument", { timeout: 2000 }, () => {
  const errors = [];
  findReleaseMarkers(errors, "soksak-wailsv3", "unknown argument\u0000registry-ca\u0000config-dir");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /diagnostic argument/);
});

test("release marker scanner finds capture code in an executable without symbols", { timeout: 2000 }, () => {
  // An executable with symbols stripped has no sp_capture_ symbol, but the ObjC class names remain as strings.
  const errors = [];
  findReleaseMarkers(errors, "stripped", "\u0000SPCapture\u0000frame-%04d.bgra\u0000");
  assert.equal(errors.length, 1, errors.join("\n"));
  assert.match(errors[0], /window capture/);
});

test("platform audit accepts only declared platform boundaries", { timeout: 5000 }, async () => {
  const result = await run(node, [join(root, "scripts/check-platforms.mjs")]);
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Platform checks passed: \d+ files/);
});
