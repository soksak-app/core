// The limit of a window-check global setup, which node:test runs once before the first check file with --test-global-setup.

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
