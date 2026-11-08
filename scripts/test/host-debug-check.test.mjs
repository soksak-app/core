// Verifies that the check of the debug build compiles what the debug apps compile, and its connection to check-host-files.
import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";

const root = resolve(import.meta.dirname, "../..");
const modules = ["apps/wailsv3", "apps/mygo", "packages/host/go", "packages/host/wailsv3", "packages/host/mygo", "packages/sok/go"];

function dryRun(target, ...skipped) {
  const options = ["build-native", ...skipped].flatMap((name) => ["-o", name]);
  return execFileSync("make", ["-n", ...options, target], { cwd: root, encoding: "utf8", timeout: 20000 });
}

function debugConfiguration() {
  const tauri = dryRun("build-tauriv2", "copy-frontend-tauriv2").match(/cargo build --locked -p sok-tauriv2 --features (\S+)/);
  const wails = dryRun("build-wailsv3", "copy-frontend-wailsv3").match(/go build -C apps\/wailsv3 -tags "([^"]+)"/);
  assert.ok(tauri, "build-tauriv2 names its features");
  assert.ok(wails, "build-wailsv3 names its tags");
  return { features: tauri[1], tags: wails[1] };
}

function assertCompilesDebugConfiguration(output) {
  const { features, tags } = debugConfiguration();
  assert.ok(
    output.includes(`cargo check --locked --tests -p soksak-sok -p soksak-host -p soksak-host-tauriv2 -p sok-tauriv2 --features ${features}`),
    output,
  );
  for (const module of modules) assert.ok(output.includes(`go vet -C ${module} -tags "${tags}" ./src/...`), output);
}

test("the debug check compiles the features and tags of the debug apps", { timeout: 60000 }, () => {
  assertCompilesDebugConfiguration(dryRun("check-host-debug", "copy-frontend-wailsv3", "copy-frontend-tauriv2", "copy-frontend-mygo"));
});

test("check-host-files runs the debug check", { timeout: 60000 }, () => {
  assertCompilesDebugConfiguration(dryRun("check-host-files", "copy-frontend-wailsv3", "copy-frontend-tauriv2", "copy-frontend-mygo"));
});

test("the debug check builds the native test library that the compiled tests link", { timeout: 60000 }, () => {
  const output = dryRun("check-host-debug", "copy-frontend-wailsv3", "copy-frontend-tauriv2", "copy-frontend-mygo");
  assert.match(output, /build-host-test build-host-callback-abi build-host-callback-worker/, output);
});
