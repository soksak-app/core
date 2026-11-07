import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const command = new URL("../check-host-callbacks.mjs", import.meta.url).pathname;

test("callback bindings follow the declared native entries and a repeated write preserves the artifact", { timeout: 30000 }, () => {
  const folder = mkdtempSync(join(tmpdir(), "host-callback-bindings-"));
  try {
    const header = join(folder, "callbacks.h"), output = join(folder, "callbacks.go");
    writeFileSync(header, "void unrelated(void);\nvoid sp_host_callback_ready(unsigned long context);\nvoid sp_host_diagnostic_callback_capture(unsigned long context);\n");
    const args = [command, "--header", header, "--output", output];
    const written = spawnSync(process.execPath, [...args, "--write"], { encoding: "utf8" });
    assert.equal(written.status, 0, written.stdout + written.stderr);
    const generated = readFileSync(output, "utf8");
    assert.match(generated, /callbacks\.ready = \(\*\[0\]byte\)\(C\.goHost_ready\)/);
    assert.doesNotMatch(generated, /C\.goHost_unrelated/);
    assert.doesNotMatch(generated, /C\.goHost_capture/);
    const diagnosticFile = join(folder, "callbacks_diagnostics.go");
    const diagnostics = readFileSync(diagnosticFile, "utf8");
    assert.match(diagnostics, /go:build darwin && diagnostics/);
    assert.match(diagnostics, /callbacks\.capture = \(\*\[0\]byte\)\(C\.goHost_capture\)/);
    assert.doesNotMatch(diagnostics, /C\.goHost_ready/);
    const stamp = new Date("2001-01-01T00:00:00Z");
    utimesSync(output, stamp, stamp);
    const repeated = spawnSync(process.execPath, [...args, "--write"], { encoding: "utf8" });
    assert.equal(repeated.status, 0, repeated.stdout + repeated.stderr);
    assert.equal(statSync(output).mtimeMs, stamp.getTime(), "an unchanged binding was rewritten");
    writeFileSync(diagnosticFile, diagnostics + "\n// stale\n");
    const staleDiagnostic = spawnSync(process.execPath, args, { encoding: "utf8" });
    assert.notEqual(staleDiagnostic.status, 0, "a stale diagnostic binding passed its check");
    assert.ok(staleDiagnostic.stderr.includes(diagnosticFile), staleDiagnostic.stderr);
    assert.equal(spawnSync(process.execPath, [...args, "--write"], { encoding: "utf8" }).status, 0);
    writeFileSync(header, "void sp_host_callback_ready(unsigned long context);\n");
    const obsolete = spawnSync(process.execPath, args, { encoding: "utf8" });
    assert.notEqual(obsolete.status, 0, "an obsolete diagnostic binding passed its check");
    assert.ok(obsolete.stderr.includes(diagnosticFile), obsolete.stderr);
    const removed = spawnSync(process.execPath, [...args, "--write"], { encoding: "utf8" });
    assert.equal(removed.status, 0, removed.stdout + removed.stderr);
    assert.equal(existsSync(diagnosticFile), false, "an obsolete generated diagnostic binding remains");
    writeFileSync(output, generated + "\n// stale\n");
    const stale = spawnSync(process.execPath, args, { encoding: "utf8" });
    assert.notEqual(stale.status, 0, "a stale generated binding passed its check");
    assert.ok(stale.stderr.includes(output), stale.stderr);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test("a header without callback entry points is rejected by its path", { timeout: 30000 }, () => {
  const folder = mkdtempSync(join(tmpdir(), "host-callback-bindings-"));
  try {
    const header = join(folder, "empty.h");
    writeFileSync(header, "void unrelated(void);\n");
    const result = spawnSync(process.execPath, [command, "--header", header, "--output", join(folder, "out.go"), "--write"], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes(header), result.stderr);
    assert.match(result.stderr, /no native callback entry points/);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
