import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const fixtureHeader = (name) => new URL(`./fixtures/host-callbacks/${name}`, import.meta.url).pathname;
// The text of a binding that its header no longer produces.
const STALE_BINDING = "stale";
const command = new URL("../check-host-callbacks.mjs", import.meta.url).pathname;

test("default callback outputs include the independent shared-host fixture and explicit outputs remain isolated", async () => {
  const { hostCallbackOutputPaths } = await import("../check-host-callbacks.mjs");
  const defaults = hostCallbackOutputPaths();
  for (const [key, path] of Object.entries({
    output: "packages/host/wailsv3/src/platform/darwin/bindings/callback_bindings.go",
    puregoOutput: "packages/host/mygo/src/platform/darwin/nativecallback/callback_bindings.go",
    typesOutput: "packages/host/go/src/platform/darwin/abi/callback_types.go",
    handlersOutput: "packages/host/go/src/platform/darwin/callback_handlers.go",
    fixtureOutput: "packages/host/go/tests/platform/darwin/standalone/bindings/callback_bindings.go",
    fixturePuregoOutput: "packages/host/go/tests/platform/darwin/standalone/nativecallback/callback_bindings.go",
  })) {
    assert.equal(defaults[key], new URL(`../../${path}`, import.meta.url).pathname);
  }
  const isolated = join(tmpdir(), "fixture_callbacks.go");
  assert.deepEqual(hostCallbackOutputPaths({ output: isolated }), {
    output: isolated, puregoOutput: undefined, typesOutput: undefined, handlersOutput: undefined, fixtureOutput: undefined, fixturePuregoOutput: undefined,
  });
});

test("common handler factories follow header field names and participate in artifact checks", { timeout: 30000 }, async () => {
  const { createHostCallbacks } = await import("../check-host-callbacks.mjs");
  const folder = mkdtempSync(join(tmpdir(), "host-callback-handlers-"));
  try {
    const header = join(folder, "callbacks.h"), output = join(folder, "bindings.go"), handlers = join(folder, "handlers.go");
    const baseHeader = "void unrelated(void);\nvoid sp_host_callback_document_changed(unsigned long context, char *value);\nvoid sp_host_callback_native_committed(unsigned long long identifier);\n";
    writeFileSync(header, baseHeader + "void sp_host_diagnostic_callback_page_objects_counted(unsigned long context, long elements, long documents, char *failure);\n");
    const generated = createHostCallbacks(header);
    assert.equal(typeof generated.handlersBase, "string", "the callback generator does not own common handler factories");
    assert.match(generated.handlersBase, /func callbackHandlers\(\) abi\.Callbacks/);
    assert.match(generated.handlersDiagnostics, /func diagnosticCallbackHandlers\(\) abi\.DiagnosticCallbacks/);
    const mappings = (text) => [...text.matchAll(/(\w+):\s+(goHost_\w+),/g)].map((match) => match.slice(1));
    assert.deepEqual(mappings(generated.handlersBase), [
      ["DocumentChanged", "goHost_document_changed"],
      ["NativeCommitted", "goHost_native_committed"],
    ]);
    assert.deepEqual(mappings(generated.handlersDiagnostics), [["PageObjectsCounted", "goHost_page_objects_counted"]]);
    assert.doesNotMatch(generated.handlersBase + generated.handlersDiagnostics, /import "C"|purego|runtimeCgo|unrelated/);
    const args = [command, "--header", header, "--output", output, "--handlers-output", handlers];
    let result = spawnSync(process.execPath, [...args, "--write"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const diagnosticFile = join(folder, "handlers_diagnostics.go");
    assert.equal(readFileSync(handlers, "utf8"), generated.handlersBase);
    assert.equal(readFileSync(diagnosticFile, "utf8"), generated.handlersDiagnostics);
    assert.match(generated.handlersBase, /go:build darwin\n/);
    assert.match(generated.handlersDiagnostics, /go:build darwin && diagnostics/);
    const stamp = new Date("2001-01-01T00:00:00Z");
    utimesSync(handlers, stamp, stamp);
    utimesSync(diagnosticFile, stamp, stamp);
    result = spawnSync(process.execPath, [...args, "--write"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(statSync(handlers).mtimeMs, stamp.getTime());
    assert.equal(statSync(diagnosticFile).mtimeMs, stamp.getTime());
    for (const [file, source] of [[handlers, generated.handlersBase], [diagnosticFile, generated.handlersDiagnostics]]) {
      writeFileSync(file, source.replace(/goHost_\w+/, "goHost_wrong_handler"));
      result = spawnSync(process.execPath, args, { encoding: "utf8" });
      assert.notEqual(result.status, 0, "a handler wired to the wrong function passed its artifact check");
      assert.ok(result.stderr.includes(file), result.stderr);
      writeFileSync(file, source);
    }
    writeFileSync(header, baseHeader);
    result = spawnSync(process.execPath, [...args, "--write"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(existsSync(diagnosticFile), false, "obsolete diagnostic factory remains after removing its header profile");
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test("callback bindings follow the declared native entries and a repeated write preserves the artifact", { timeout: 30000 }, () => {
  const folder = mkdtempSync(join(tmpdir(), "host-callback-bindings-"));
  try {
    const header = join(folder, "callbacks.h"), output = join(folder, "callbacks.go");
    copyFileSync(fixtureHeader("ready-and-capture.h"), header);
    const args = [command, "--header", header, "--output", output];
    const written = spawnSync(process.execPath, [...args, "--write"], { encoding: "utf8" });
    assert.equal(written.status, 0, written.stdout + written.stderr);
    const generated = readFileSync(output, "utf8");
    assert.match(generated, /native\.ready = \(\*\[0\]byte\)\(C\.goHost_ready\)/);
    assert.doesNotMatch(generated, /C\.goHost_unrelated/);
    assert.doesNotMatch(generated, /C\.goHost_capture/);
    const diagnosticFile = join(folder, "callbacks_diagnostics.go");
    const diagnostics = readFileSync(diagnosticFile, "utf8");
    assert.match(diagnostics, /go:build darwin && diagnostics/);
    assert.match(diagnostics, /native\.capture = \(\*\[0\]byte\)\(C\.goHost_capture\)/);
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
    copyFileSync(fixtureHeader("ready-context.h"), header);
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
    copyFileSync(fixtureHeader("unrelated.h"), header);
    const result = spawnSync(process.execPath, [command, "--header", header, "--output", join(folder, "out.go"), "--write"], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes(header), result.stderr);
    assert.match(result.stderr, /no native callback entry points/);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test("cgo-free callback bindings preserve native types and reject unsupported declarations", { timeout: 30000 }, async () => {
  const { createHostCallbacks } = await import("../check-host-callbacks.mjs");
  const folder = mkdtempSync(join(tmpdir(), "host-callback-types-"));
  try {
    const header = join(folder, "callbacks.h");
    writeFileSync(header, "#include <stdbool.h>\n#include <stdint.h>\n#include <stddef.h>\nbool sp_host_callback_reply(uintptr_t token, int result, long count, uint64_t sequence, double elapsed, void **bytes, size_t *length, char **kind);\nvoid sp_host_diagnostic_callback_ready(bool ready);\n");
    const generated = createHostCallbacks(header);
    assert.equal(typeof generated.puregoBase, "string", "no cgo-free binding was generated");
    assert.match(generated.abiBase, /Reply func\(uintptr, int32, int64, uint64, float64, \*unsafe.Pointer, \*uint64, \*\*byte\) bool/);
    assert.doesNotMatch(generated.puregoBase, /import "C"|Ready/);
    assert.doesNotMatch(generated.abiBase, /purego|runtimeCgo|import "C"/);
    assert.match(generated.puregoBase, /purego.NewCallback\(callbacks.Reply\)/);
    assert.match(generated.puregoDiagnostics, /go:build darwin && diagnostics/);
    assert.match(generated.abiDiagnostics, /Ready func\(bool\)/);
    writeFileSync(header, "void sp_host_callback_bad(long double value);\n");
    assert.throws(() => createHostCallbacks(header), /callbacks.h.*unsupported.*long double/);
    writeFileSync(header, "double sp_host_callback_bad(void);\n");
    assert.throws(() => createHostCallbacks(header), /callbacks.h.*unsupported callback result.*double/);
  } finally { rmSync(folder, { recursive: true }); }
});

test("cgo-free generated artifacts are checked and obsolete diagnostics are removed", { timeout: 30000 }, () => {
  const folder = mkdtempSync(join(tmpdir(), "host-callback-purego-"));
  const productionFiles = [
    "packages/host/go/src/platform/darwin/abi/callback_types.go",
    "packages/host/go/src/platform/darwin/abi/callback_types_diagnostics.go",
    "packages/host/go/src/platform/darwin/callback_handlers.go",
    "packages/host/go/src/platform/darwin/callback_handlers_diagnostics.go",
    "packages/host/wailsv3/src/platform/darwin/bindings/callback_bindings.go",
    "packages/host/wailsv3/src/platform/darwin/bindings/callback_bindings_diagnostics.go",
    "packages/host/mygo/src/platform/darwin/nativecallback/callback_bindings.go",
    "packages/host/mygo/src/platform/darwin/nativecallback/callback_bindings_diagnostics.go",
    "packages/host/go/tests/platform/darwin/standalone/bindings/callback_bindings.go",
    "packages/host/go/tests/platform/darwin/standalone/bindings/callback_bindings_diagnostics.go",
  ].map((path) => new URL(`../../${path}`, import.meta.url));
  const productionBefore = productionFiles.map((path) => readFileSync(path, "utf8"));
  try {
    const header = join(folder, "callbacks.h"), output = join(folder, "cgo.go"), binding = join(folder, "native.go");
    copyFileSync(fixtureHeader("quit-and-exit-answered.h"), header);
    const args = [command, "--header", header, "--output", output, "--purego-output", binding];
    let result = spawnSync(process.execPath, [...args, "--write"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(readFileSync(binding, "utf8"), /package nativecallback/);
    const diagnosticFile = join(folder, "native_diagnostics.go");
    assert.ok(existsSync(diagnosticFile));
    const diagnostics = readFileSync(diagnosticFile, "utf8");
    // A file-list build includes the diagnostic binding explicitly; its shared
    // ABI dependency still requires the diagnostic profile's build tag. The
    // bindings and their ABI are of the darwin layer, so the build names darwin
    // on every system.
    for (const profile of [["build", binding], ["build", "-tags", "diagnostics", binding, diagnosticFile]]) {
      const compiled = spawnSync("go", profile, {
        cwd: new URL("../../packages/host/mygo/", import.meta.url),
        env: { ...process.env, CGO_ENABLED: "0", GOOS: "darwin" }, encoding: "utf8",
      });
      assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
    }
    const stamp = new Date("2001-01-01T00:00:00Z");
    utimesSync(binding, stamp, stamp);
    utimesSync(diagnosticFile, stamp, stamp);
    result = spawnSync(process.execPath, [...args, "--write"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(statSync(binding).mtimeMs, stamp.getTime());
    assert.equal(statSync(diagnosticFile).mtimeMs, stamp.getTime());
    writeFileSync(diagnosticFile, diagnostics + "\n// stale\n");
    result = spawnSync(process.execPath, args, { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes(diagnosticFile), result.stderr);
    writeFileSync(diagnosticFile, diagnostics);
    writeFileSync(binding, STALE_BINDING);
    result = spawnSync(process.execPath, args, { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes(binding), result.stderr);
    copyFileSync(fixtureHeader("ready.h"), header);
    result = spawnSync(process.execPath, [...args, "--write"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(existsSync(join(folder, "native_diagnostics.go")), false);
    assert.deepEqual(productionFiles.map((path) => readFileSync(path, "utf8")), productionBefore,
      "isolated callback fixture generation changed production artifacts");
  } finally { rmSync(folder, { recursive: true }); }
});

test("the Go binding checks run with the builds that compile Go, and the native library build needs no Go toolchain", { timeout: 30000 }, () => {
  // The CI native job and the Tauri release job install no Go, so a gofmt that their build runs fails them.
  const checks = (target) => {
    const result = spawnSync("make", ["-n", "--no-print-directory", target], { cwd: new URL("../..", import.meta.url).pathname, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return ["check-host-callbacks.mjs", "check-host-api.mjs"].filter((script) => result.stdout.includes(`scripts/${script}`));
  };
  for (const target of ["build-native", "build-tauriv2", "build-tauriv2-release", "test-tauriv2", "check-release-tauriv2"]) {
    assert.deepEqual(checks(target), [], `${target} runs a Go binding check`);
  }
  for (const target of ["build-wailsv3", "build-wailsv3-release", "test-wailsv3", "build-mygo", "build-mygo-release", "test-mygo", "test-hosts", "test-native"]) {
    assert.deepEqual(checks(target), ["check-host-callbacks.mjs", "check-host-api.mjs"], `${target} omits a Go binding check`);
  }
});
