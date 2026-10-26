import assert from "node:assert/strict";
import { test } from "node:test";
import { createBridgeReporter } from "../fixtures/memory-saver/unload-probe/ui/bridge-report.js";

function fixture() {
  const errors = [];
  const debug = [];
  const info = [];
  return {
    errors,
    debug,
    info,
    report: createBridgeReporter({
      reportError: (error) => errors.push(error),
      console: {
        debug: (...args) => debug.push(args),
        info: (...args) => info.push(args),
      },
    }),
  };
}

test("a failed view error report reaches the injected global error hook", { timeout: 1000 }, () => {
  const h = fixture();
  h.report({ where: "view command", text: "request failed", error: new Error("runtime.error refused") });

  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0].message, /view command: request failed/);
  assert.match(h.errors[0].message, /runtime\.error refused/);
});

test("ordinary call counts and close or coalescing reports stay out of the application error path", { timeout: 1000 }, () => {
  const h = fixture();
  h.report({ kind: "open-calls", plugin: "probeunload", count: 2, oldestStartedAt: 5 });
  h.report({ kind: "peer-lost", plugin: "probeunload", command: "tab.state.write", reason: "surface-closed" });
  h.report({ kind: "skipped", plugin: "probeunload", status: "probeunload.location", count: 1 });
  h.report({ kind: "stalled", plugin: "probeunload", status: "probeunload.location", reason: "surface-closed", count: 1 });

  assert.deepEqual(h.errors, []);
  assert.equal(h.debug.length, 1);
  assert.equal(h.info.length, 3);
});

test("unexpected transport loss reaches the injected global error hook", { timeout: 1000 }, () => {
  const h = fixture();
  h.report({ kind: "timeout", plugin: "probeunload", command: "tab.state.read", timeout: 10000 });

  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0].message, /timeout/);
  assert.match(h.errors[0].message, /tab\.state\.read/);
});
