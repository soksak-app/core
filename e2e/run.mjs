#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { sessionBaselineEnvironment } from "@soksak/window-check/frontmost.mjs";

export function runE2E({
  args = process.argv.slice(2),
  env = process.env,
  stderr = process.stderr,
  baselineEnvironment = sessionBaselineEnvironment,
  spawn = spawnSync,
  executable = process.execPath,
} = {}) {
  if (args[0] !== "--test") {
    stderr.write("usage: node ./run.mjs --test <node test arguments>\n");
    return 2;
  }

  try {
    for (const name of ["SOKSAK_RUN_ID", "SOKSAK_RUN_FOLDER"]) {
      if (typeof env[name] !== "string" || env[name].length === 0) {
        throw new Error("SOKSAK_RUN_ID and SOKSAK_RUN_FOLDER are required and must both be nonempty");
      }
    }

    const childEnv = {
      ...env,
      ...baselineEnvironment({ env }),
      SOKSAK_RUN_ID: env.SOKSAK_RUN_ID,
      SOKSAK_RUN_FOLDER: env.SOKSAK_RUN_FOLDER,
    };
    const result = spawn(executable, args, { env: childEnv, stdio: "inherit" });
    if (result.error) throw result.error;
    return result.status ?? 1;
  } catch (error) {
    stderr.write(`${error.message}\n`);
    return 1;
  }
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = runE2E();
}
