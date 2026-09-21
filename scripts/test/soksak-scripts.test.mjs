import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
  mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { BREAKS } from "../../packages/soksak/scripts/breaks.mjs";
import { find as findReleaseMarkers } from "../check-release.mjs";

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

test("window-source audit rejects forbidden control paths", { timeout: 5000 }, async () => {
  const result = await run(node, [join(root, "scripts/check-e2e.mjs")]);
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Window check sources use only the endpoint/);
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

test("platform audit accepts only declared platform boundaries", { timeout: 5000 }, async () => {
  const result = await run(node, [join(root, "scripts/check-platforms.mjs")]);
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Platform checks passed: \d+ files/);
});
