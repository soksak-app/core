// The start of a window check run. node:test runs it once before the first check file with --test-global-setup.
//
// When the application that is active before the checks is a host to check, every synthetic pointer measurement of that
// run would measure an active application, so the run fails once without starting any check
// (docs/operations/examples.md).
import { existsSync } from "node:fs";
import { readEndpoint } from "@soksak/client";
import { APPS } from "./app.mjs";
import { SESSION_BASELINE_ENV, sessionBaselineFromEnvironment } from "./frontmost.mjs";

export async function globalSetup() {
  // An application without an executable is skipped by open, so it is not a host to check.
  const hosts = [];
  for (const app of Object.values(APPS)) {
    if (!existsSync(app.binary)) continue;
    hosts.push({ name: app.name, pid: (await readEndpoint(app.configDir)).pid });
  }
  const baseline = sessionBaselineFromEnvironment(process.env, { hosts });
  process.env[SESSION_BASELINE_ENV] = JSON.stringify(baseline);
}
