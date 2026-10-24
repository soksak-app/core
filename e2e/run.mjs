#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { sessionBaselineEnvironment } from "@soksak/window-check/frontmost.mjs";

const args = process.argv.slice(2);
if (args[0] !== "--test") {
  process.stderr.write("usage: node ./run.mjs --test <node test arguments>\n");
  process.exitCode = 2;
} else {
  try {
    const env = { ...process.env, ...sessionBaselineEnvironment() };
    const result = spawnSync(process.execPath, args, { env, stdio: "inherit" });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
