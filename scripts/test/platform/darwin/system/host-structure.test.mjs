// The host structure audit of the whole tree, whose main-thread audit reads the Objective-C syntax trees that clang of the macOS SDK
// makes of the darwin layer.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../../../", import.meta.url));

// The limit ends a stopped audit and does not judge its speed: an audit of every tracked file takes about 2 seconds alone and more
// than 5 seconds at the load of the pre-push checks, which run beside the builds of both hosts.
const TREE_AUDIT_LIMIT_MS = 30000;

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

test("host structure audit reports a clean paired-host graph", { timeout: TREE_AUDIT_LIMIT_MS }, async () => {
  const result = await run(process.execPath, [join(root, "scripts/check-host-files.mjs")]);
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Host structure checks passed:/);
});
