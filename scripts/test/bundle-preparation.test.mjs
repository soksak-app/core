// Runs the Makefile bundle preparation against a disposable bundle while a non-GUI child uses its executable path.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function makePreparationMakefile(temporary) {
  const makefile = join(temporary, "bundle-preparation.mk");
  writeFileSync(makefile, `include ${join(ROOT, "Makefile")}\n.PHONY: bundle-preparation-test\nbundle-preparation-test:\n\t@$(call bundle-info,$(BUNDLE),tauriv2)\n`);
  return makefile;
}

function runPreparation(makefile, bundle) {
  return spawnSync("make", ["--no-print-directory", "-f", makefile, "bundle-preparation-test", `BUNDLE=${bundle}`], {
    cwd: ROOT,
    encoding: "utf8",
  });
}

test("bundle preparation refuses a running bundle executable before removing Contents", { timeout: 10000, skip: process.platform !== "darwin" }, async () => {
  const temporary = mkdtempSync(join(tmpdir(), "soksak-bundle-preparation-"));
  const bundle = join(temporary, "soksak-tauriv2.app");
  const contents = join(bundle, "Contents");
  const executable = join(contents, "MacOS", "soksak-tauriv2");
  const source = join(temporary, "child.c");
  const sentinel = join(contents, "Resources", "preserve-me.txt");
  mkdirSync(dirname(executable), { recursive: true });
  mkdirSync(dirname(sentinel), { recursive: true });
  writeFileSync(source, "#include <unistd.h>\nint main(void) { for (;;) pause(); }\n");
  const compiled = spawnSync("cc", ["-o", executable, source], { encoding: "utf8" });
  assert.equal(compiled.status, 0, `failed to compile the disposable child: ${compiled.stderr}`);
  writeFileSync(sentinel, "bundle contents are in use\n");
  const makefile = makePreparationMakefile(temporary);

  const child = spawn(executable, [], { detached: true, stdio: "ignore" });
  try {
    await once(child, "spawn");
    const result = runPreparation(makefile, bundle);
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    assert.notEqual(result.status, 0, `preparation succeeded while PID ${child.pid} used ${bundle}; output: ${output}`);
    assert.match(output, new RegExp(`PID ${child.pid}`));
    assert.ok(output.includes(bundle), `preparation error omitted the bundle path ${bundle}: ${output}`);
    assert.ok(existsSync(sentinel), `preparation removed ${sentinel}; output: ${output}`);
    assert.ok(existsSync(executable), `preparation removed the running executable ${executable}; output: ${output}`);
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit");
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("bundle preparation recreates Contents when no process uses the bundle", { timeout: 10000, skip: process.platform !== "darwin" }, () => {
  const temporary = mkdtempSync(join(tmpdir(), "soksak-bundle-preparation-idle-"));
  const bundle = join(temporary, "soksak-tauriv2.app");
  const contents = join(bundle, "Contents");
  const sentinel = join(contents, "Resources", "remove-me.txt");
  mkdirSync(dirname(sentinel), { recursive: true });
  writeFileSync(sentinel, "old bundle contents\n");
  try {
    const result = runPreparation(makePreparationMakefile(temporary), bundle);
    assert.equal(result.status, 0, `preparation failed: ${result.stderr}`);
    assert.equal(existsSync(sentinel), false, "preparation kept old bundle contents");
    assert.ok(existsSync(join(contents, "Info.plist")), "preparation did not write Info.plist");
    assert.ok(existsSync(join(contents, "Resources", "AppIcon.icns")), "preparation did not write the app icon");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
