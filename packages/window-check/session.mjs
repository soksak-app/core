// The start of a window check run. node:test runs it once before the first check file with --test-global-setup.
//
// When the application that is active before the checks is a host to check, every synthetic pointer measurement of that
// run would measure an active application, so the run fails once without starting any check
// (docs/operations/examples.md).
import { existsSync } from "node:fs";
import { readEndpoint } from "@soksak/client";
import { APPS } from "./app.mjs";
import { SESSION_BASELINE_ENV, sessionBaselineFromEnvironment } from "./frontmost.mjs";

/** The limit of the session start. It reads the endpoint of each application, and each read has its own wait. */
export const SESSION_SETUP_LIMIT_MS = 120_000;

/**
 * Runs the setup `work` and rejects with the name of the setup and its limit when it does not settle within `limitMs`, so a setup that
 * awaits never holds the run. The limit is a timer of the setup itself (AbortSignal.timeout); a setup that blocks the event loop is
 * ended by the event watchdog of the test runner (scripts/test-runner.mjs).
 */
export function withSetupLimit(name, limitMs, work) {
  const signal = AbortSignal.timeout(limitMs);
  const exceeded = new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(new Error(`global setup ${name} exceeded its limit of ${limitMs} ms`)), { once: true });
  });
  return Promise.race([work(), exceeded]);
}

export async function globalSetup() {
  await withSetupLimit("window-check session", SESSION_SETUP_LIMIT_MS, async () => {
    // An application without an executable is skipped by open, so it is not a host to check.
    const hosts = [];
    for (const app of Object.values(APPS)) {
      if (!existsSync(app.binary)) continue;
      hosts.push({ name: app.name, pid: (await readEndpoint(app.configDir)).pid });
    }
    const baseline = sessionBaselineFromEnvironment(process.env, { hosts });
    process.env[SESSION_BASELINE_ENV] = JSON.stringify(baseline);
  });
}
