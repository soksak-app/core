import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

const root = new URL("../../", import.meta.url).pathname;
const binary = join(root, "sidecars/vt-alacritty/build/soksak-vt-alacritty");
const verifier = join(root, "scripts/verify-vt-recovery.mjs");

function runVerifier() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [verifier, binary], {
      cwd: root,
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

test("VT recovery preserves the live service and session across client restart", { timeout: 10000 }, async () => {
  await access(binary);
  const result = await runVerifier();
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /PASS service_alive_after_application_process_exit/);
  assert.match(result.stdout, /PASS application_process_restarted session=/);
  assert.match(result.stdout, /PASS retained_screen_contains_RECOVERY/);
  assert.match(result.stdout, /PASS recovery_check_duration_ms=\d+/);
});
