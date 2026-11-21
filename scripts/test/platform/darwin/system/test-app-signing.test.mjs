// Checks the window run's verification of real macOS bundle signatures.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runPlan } from "../../../../test-app.mjs";

const node = (code) => [process.execPath, "-e", code];

function signedBundle(t) {
  const folder = mkdtempSync(join(tmpdir(), "soksak-bundle-verify-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const bundle = join(folder, "sok-probe.app");
  mkdirSync(join(bundle, "Contents", "MacOS"), { recursive: true });
  writeFileSync(join(bundle, "Contents", "Info.plist"), '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" '
    + '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleExecutable</key><string>sok-probe</string>'
    + '<key>CFBundleIdentifier</key><string>app.soksak.test.probe</string></dict></plist>\n');
  const executable = join(bundle, "Contents", "MacOS", "sok-probe");
  copyFileSync("/usr/bin/true", executable);
  const signed = spawnSync("codesign", ["--sign", "-", "--force", "--deep", bundle], { encoding: "utf8" });
  assert.equal(signed.status, 0, signed.stderr);
  return { folder, bundle, executable };
}

test("a bundle whose executable no longer matches its signature fails its verification with the bundle path, and the start is skipped", { timeout: 20000 }, async (t) => {
  // A real bundle signed ad hoc, whose executable then changes as a build that rewrites it in place changes it.
  const { folder, bundle, executable } = signedBundle(t);
  writeFileSync(executable, Buffer.concat([readFileSync(executable), Buffer.from("changed")]));
  const configDir = join(folder, "config");
  const lines = [];
  const write = (line) => lines.push(line);
  const children = new Map();
  const failures = await runPlan([
    { name: "verify artifact probe", phase: "prepare", kind: "verify", artifact: bundle, platform: "darwin" },
    { name: "start probe", phase: "prepare", kind: "start", app: "probe", argv: node("setInterval(() => {}, 1000)"), configDir, output: join(folder, "probe.out") },
  ], { write, children });
  assert.equal(failures.length, 1, lines.join("\n"));
  assert.ok(failures[0].startsWith(`verify artifact probe: the bundle ${bundle} does not verify: `), failures[0]);
  assert.match(failures[0], /main executable failed strict validation/);
  assert.ok(lines.includes("skipped start probe: verify artifact probe failed"), lines.join("\n"));
  assert.equal(children.size, 0);
});

test("a bundle whose signature verifies passes its verification", { timeout: 20000 }, async (t) => {
  const { bundle } = signedBundle(t);
  const lines = [];
  const write = (line) => lines.push(line);
  const failures = await runPlan([{ name: "verify artifact probe", phase: "prepare", kind: "verify", artifact: bundle, platform: "darwin" }], { write });
  assert.deepEqual(failures, [], lines.join("\n"));
});
