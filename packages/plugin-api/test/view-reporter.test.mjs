// Checks the reporter of the view bridge (docs/spec/native-surfaces.md#view-surfaces): errors reach the page error hook, and the
// call counts and the reports of a closed surface or a coalesced snapshot stay console records.
import assert from "node:assert/strict";
import test from "node:test";
import { createViewReporter } from "../view.js";

function fixture() {
  const errors = [];
  const debug = [];
  const info = [];
  return {
    errors,
    debug,
    info,
    report: createViewReporter({
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
  assert.equal(h.errors[0].message, "view command: request failed: report error: runtime.error refused");
});

test("ordinary call counts and close or coalescing reports stay out of the application error path", { timeout: 1000 }, () => {
  const h = fixture();
  h.report({ kind: "open-calls", plugin: "probe", count: 2, oldestStartedAt: 5 });
  h.report({ kind: "peer-lost", plugin: "probe", command: "tab.state.write", reason: "surface-closed" });
  h.report({ kind: "skipped", plugin: "probe", status: "probe.location", count: 1 });
  h.report({ kind: "stalled", plugin: "probe", status: "probe.location", reason: "surface-closed", count: 1 });

  assert.deepEqual(h.errors, []);
  assert.equal(h.debug.length, 1);
  assert.equal(h.info.length, 3);
});

test("unexpected transport loss reaches the injected global error hook", { timeout: 1000 }, () => {
  const h = fixture();
  h.report({ kind: "timeout", plugin: "probe", command: "tab.state.read", timeout: 10000 });

  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0].message, /^view bridge timeout: /);
  assert.match(h.errors[0].message, /tab\.state\.read/);
});

test("the reporter refuses a missing error hook or console", { timeout: 1000 }, () => {
  assert.throws(() => createViewReporter({ console: { debug() {}, info() {} } }), /createViewReporter requires reportError/);
  assert.throws(() => createViewReporter({ reportError() {}, console: {} }), /createViewReporter requires console debug and info/);
});
