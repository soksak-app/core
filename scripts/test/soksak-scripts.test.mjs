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
import { auditHostPairs } from "../check-hosts.mjs";
import { auditE2ESource } from "../check-e2e.mjs";
import { auditTerminalProtocolInventory } from "../check-terminal-protocol-inventory.mjs";

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

test("host structure audit reports a clean paired-host graph", { timeout: 5000 }, async () => {
  const result = await run(node, [join(root, "scripts/check-hosts.mjs")]);
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Host structure checks passed:/);
});

test("host structure audit rejects a missing host and a missing counterpart", { timeout: 1000 }, () => {
  const pairs = [{ left: "hosts/wails", right: "hosts/tauri", only: { left: {}, right: {} } }];
  assert.deepEqual(auditHostPairs(["hosts/wails/src/host.go"], pairs), ["hosts/tauri: no files", "hosts/wails/src/host: no counterpart in hosts/tauri"]);
  assert.deepEqual(auditHostPairs(["hosts/wails/src/host.go", "hosts/tauri/src/host.rs", "hosts/tauri/src/extra.rs"], pairs), ["hosts/tauri/src/extra: no counterpart in hosts/wails"]);
});

test("window-source audit rejects forbidden control paths", { timeout: 5000 }, async () => {
  const result = await run(node, [join(root, "scripts/check-e2e.mjs")]);
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Window check sources use only the endpoint/);
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
  assert.equal(auditE2ESource(line, "e2e/terminal.test.mjs").length, 1);
  assert.equal(auditE2ESource(line, "e2e/activation-like.test.mjs").length, 1);
});

test("window-source audit allows activation in the real-input tier and input pacing only in its tool", { timeout: 1000 }, () => {
  const line = 'await session.pointer(x, y, "move", { activate: true });';
  assert.deepEqual(auditE2ESource(line, "e2e/real/terminal.test.mjs"), []);
  const pacing = "  if (step.wait) delay(step.wait / 1000);";
  assert.deepEqual(auditE2ESource(pacing, "e2e/real/hid.mjs"), []);
  assert.deepEqual(auditE2ESource(pacing, "e2e/real/terminal.test.mjs"), ["e2e/real/terminal.test.mjs:1: uses a fixed sleep"]);
  assert.deepEqual(auditE2ESource(pacing, "e2e/terminal.test.mjs"), ["e2e/terminal.test.mjs:1: uses a fixed sleep"]);
});

test("terminal protocol inventory rejects missing, duplicate, or unlinked CSI rows", { timeout: 5000 }, async () => {
  const result = await run(node, [join(root, "scripts/check-terminal-protocol-inventory.mjs")]);
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /PASS terminal protocol inventory: \d+ unique CSI rows and \d+ unique OSC rows with named tests/);
});

test("terminal protocol inventory reproduces missing and duplicate CSI rows as Red", { timeout: 1000 }, async () => {
  const source = await readFile(join(root, "sidecars/vt-alacritty/src/engine.rs"), "utf8");
  const tests = await readFile(join(root, "sidecars/vt-alacritty/tests/engine_test.rs"), "utf8");
  const broken = auditTerminalProtocolInventory({
    engineSource: source.replace('selector: "E/F"', 'selector: "A/B/C/D/G/H/f/s/u"'),
    testSource: tests,
  });
  assert.ok(broken.errors.some((error) => error.includes("duplicate CSI selector row: A/B/C/D/G/H/f/s/u")));
  assert.ok(broken.errors.some((error) => error.includes("required CSI inventory row is missing: E/F")));
  const brokenOsc = auditTerminalProtocolInventory({
    engineSource: source.replace('selector: "0,2"', 'selector: "4"'),
    testSource: tests,
  });
  assert.ok(brokenOsc.errors.some((error) => error.includes("duplicate OSC selector row: 4")));
  assert.ok(brokenOsc.errors.some((error) => error.includes("required OSC inventory row is missing: 0,2")));
});

test("the OSC report in the specification matches the engine inventory selector by selector", { timeout: 5000 }, async () => {
  const specification = await readFile(join(root, "docs/spec/terminal-protocols.md"), "utf8");
  assert.deepEqual(auditTerminalProtocolInventory().errors, []);
  const missing = auditTerminalProtocolInventory({
    specSource: specification.replace(/^\| `46` \|.*\n/m, ""),
  });
  assert.ok(missing.errors.includes("OSC selector 46 has no row in the specification report"), missing.errors.join("\n"));
  const outcome = auditTerminalProtocolInventory({
    specSource: specification.replace("| `4` | Indexed color set/query | `implemented`", "| `4` | Indexed color set/query | `unsupported`"),
  });
  assert.ok(outcome.errors.includes("OSC selector 4 is implemented in the engine but unsupported in the specification report"),
    outcome.errors.join("\n"));
  const evidence = auditTerminalProtocolInventory({
    specSource: specification.replace("`osc104_resets_indexed_colors`", "`osc104_test_that_does_not_exist`"),
  });
  assert.ok(evidence.errors.includes("OSC selector 104 names a test that does not exist: osc104_test_that_does_not_exist"),
    evidence.errors.join("\n"));
});

test("exposure audit verifies every declared core and plugin entry", { timeout: 5000 }, async () => {
  const result = await run(node, [join(root, "scripts/check-exposure.mjs")]);
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Exposure checks passed: core and \d+ plugins/);
});

test("sidecar package discovery follows declared helper edges", { timeout: 5000 }, async () => {
  const result = await run(node, [join(root, "scripts/sidecar-packages.mjs")]);
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /-F @soksak\/sidecar-vt-alacritty/);
  assert.match(result.stdout, /-F @soksak\/sidecar-shell/);
});

test("build environment audit reports the measured toolchain", { timeout: 5000 }, async () => {
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
  // 목록과 잘못된 id 는 결함을 넣은 복사본이 필요 없으므로 복사본을 만들지 않는다.
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

test("release marker scanner finds capture code in an executable without symbols", { timeout: 2000 }, () => {
  // 기호를 벗긴 실행 파일에는 sp_capture_ 기호가 없지만 ObjC 클래스 이름은 문자열로 남는다.
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
