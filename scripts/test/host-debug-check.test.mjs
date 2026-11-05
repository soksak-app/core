// Verifies that the check of the debug build compiles what the debug apps compile, and its connection to hosts-check.
import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";

const root = resolve(import.meta.dirname, "../..");
const modules = ["apps/wailsv3", "apps/mygo", "packages/host/go", "packages/host/wailsv3", "packages/host/mygo", "packages/sok/go"];

function dryRun(target, ...skipped) {
  const options = ["native-darwin", ...skipped].flatMap((name) => ["-o", name]);
  return execFileSync("make", ["-n", ...options, target], { cwd: root, encoding: "utf8", timeout: 20000 });
}

function debugConfiguration() {
  const tauri = dryRun("tauriv2-build", "frontend-tauriv2").match(/cargo build --locked -p soksak-tauriv2 --features (\S+)/);
  const wails = dryRun("wailsv3-build", "frontend-wailsv3").match(/go build -C apps\/wailsv3 -tags "([^"]+)"/);
  assert.ok(tauri, "tauriv2-build names its features");
  assert.ok(wails, "wailsv3-build names its tags");
  return { features: tauri[1], tags: wails[1] };
}

function assertCompilesDebugConfiguration(output) {
  const { features, tags } = debugConfiguration();
  assert.ok(
    output.includes(`cargo check --locked --tests -p soksak-sok -p soksak-host -p soksak-host-tauriv2 -p soksak-tauriv2 --features ${features}`),
    output,
  );
  for (const module of modules) assert.ok(output.includes(`go vet -C ${module} -tags "${tags}" ./src/...`), output);
}

test("the debug check compiles the features and tags of the debug apps", { timeout: 60000 }, () => {
  assertCompilesDebugConfiguration(dryRun("host-debug-check", "frontend-wailsv3-core", "frontend-tauriv2-core", "frontend-mygo-core"));
});

test("hosts-check runs the debug check", { timeout: 60000 }, () => {
  assertCompilesDebugConfiguration(dryRun("hosts-check", "frontend-wailsv3-core", "frontend-tauriv2-core", "frontend-mygo-core"));
});
