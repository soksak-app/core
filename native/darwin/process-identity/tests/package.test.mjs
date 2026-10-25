import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

function runNativeTarget(target) {
  return new Promise((resolve, reject) => {
    const child = spawn("make", [target], { cwd: packageRoot, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`make ${target} exited ${code ?? signal}`));
      }
    });
  });
}

test("the native process identity test target passes", { timeout: 120_000 }, () =>
  runNativeTarget("test-process-identity"));

test("the native package relocation test target passes", { timeout: 120_000 }, () =>
  runNativeTarget("test-package-relocation"));
