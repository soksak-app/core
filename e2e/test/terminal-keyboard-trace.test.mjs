import assert from "node:assert/strict";
import test from "node:test";
import { traceTerminalInput } from "../terminal-keyboard-trace.mjs";

for (const fails of [false, true]) test(`keyboard trace stops and reports public evidence on ${fails ? "failure" : "success"}`, { timeout: 5000 }, async () => {
  const calls = [], diagnostics = [];
  const original = new Error("terminal output absent");
  const trace = { enabled: false, overflow: false, entries: [{ kind: "terminal-input", input: { operation: "input", text: "\r" } }] };
  const session = {
    run: async (name, params, surface) => {
      calls.push([name, params.action, surface]);
      if (name === "terminal.pty.pending") return { pending: 0 };
      assert.equal(name, "terminal.ime.trace");
      return params.action === "stop" ? trace : { enabled: true, overflow: false, entries: [] };
    },
    get: async (name, surface) => { calls.push([name, surface]); return { observed: name }; },
  };
  const work = async () => { calls.push(["work"]); if (fails) throw original; return "done"; };
  const operation = traceTerminalInput({ diagnostic: line => diagnostics.push(line) }, session, "surface", "continued", work);
  if (fails) await assert.rejects(operation, error => error === original);
  else assert.equal(await operation, "done");
  assert.deepEqual(calls.slice(0, 3), [["terminal.ime.trace", "start", "surface"], ["work"], ["terminal.ime.trace", "stop", "surface"]]);
  assert.ok(diagnostics.some(line => line.includes('"terminal-input"')));
  if (fails) {
    for (const name of ["host.window", "core.surface.input", "terminal.session", "terminal.pty.pending"]) {
      assert.ok(calls.some(call => call[0] === name), `missing public ${name} failure evidence`);
    }
  }
});

test("failure evidence collection cannot replace the original input failure", { timeout: 5000 }, async () => {
  const original = new Error("missing Enter");
  const diagnostics = [];
  const session = { run: async (_name, { action }) => {
    if (action === "stop") throw new Error("trace stop failed");
  }, get: async () => { throw new Error("status failed"); } };
  await assert.rejects(traceTerminalInput({ diagnostic: line => diagnostics.push(line) }, session, "surface", "continued", async () => { throw original; }),
    error => error === original);
  assert.ok(diagnostics.some(line => line.includes("trace stop failed")));
});
