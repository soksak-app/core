// Checks the route of the view call runtime.program.run in answerViewCall (docs/spec/native-surfaces.md#program-runs): the call
// reaches the runtime with the declared name and the argument texts, and a call with other values is refused before it runs.
import assert from "node:assert/strict";
import test from "node:test";
import { answerViewCall } from "../view-answer.js";

const REPLY = { code: 0, stdout: "ok", stderr: "", truncated: { stdout: false, stderr: false } };

/** The options of answerViewCall for a view whose runtime records each program run in runs. */
function optionsWith(runs) {
  return {
    plugin: "probe",
    surface: "probe-surface",
    pending: new Map(),
    emitEvent() {},
    runtime: { program: { run: (name, args) => { runs.push({ name, args }); return REPLY; } } },
  };
}

test("runtime.program.run passes the declared name and the argument texts to the runtime and replies its result", async () => {
  const runs = [];
  const answer = await answerViewCall({ id: 1, command: "runtime.program.run", params: { name: "probe-tool", args: ["a", "b"] } }, optionsWith(runs));
  assert.deepEqual(runs, [{ name: "probe-tool", args: ["a", "b"] }]);
  assert.deepEqual(answer, REPLY);
});

test("runtime.program.run runs with no arguments when args is absent", async () => {
  const runs = [];
  await answerViewCall({ id: 2, command: "runtime.program.run", params: { name: "probe-tool" } }, optionsWith(runs));
  assert.deepEqual(runs, [{ name: "probe-tool", args: [] }]);
});

test("runtime.program.run refuses a name that is not a non-empty text and an args that is not an array of texts, and runs nothing", async () => {
  const runs = [];
  const refused = [
    [{ name: "", args: [] }, /view call runtime.program.run requires a non-empty name/],
    [{ args: [] }, /view call runtime.program.run requires a non-empty name/],
    [{ name: "probe-tool", args: "a" }, /view call runtime.program.run args must be an array of texts/],
    [{ name: "probe-tool", args: [1] }, /view call runtime.program.run args must be an array of texts/],
    [{ name: "probe-tool", args: null }, /view call runtime.program.run args must be an array of texts/],
  ];
  for (const [params, message] of refused) {
    await assert.rejects(answerViewCall({ id: 3, command: "runtime.program.run", params }, optionsWith(runs)), message);
  }
  assert.deepEqual(runs, []);
});
