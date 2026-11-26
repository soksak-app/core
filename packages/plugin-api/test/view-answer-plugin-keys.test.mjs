// Checks the route of the data calls of a view without a project in answerViewCall (docs/spec/plugins.md#plugin-data, F1210-3): a plugin
// key is read, written and followed without a project, and a project key of a view without a project is refused.
import assert from "node:assert/strict";
import test from "node:test";
import { answerViewCall } from "../view-answer.js";

/** The options of answerViewCall for a view of probe without a project, whose data declares the plugin key accounts and the project key marks. */
function optionsWithout(calls) {
  const data = {
    declares: (key) => key === "accounts" || key === "marks",
    scope: (key) => (key === "accounts" ? "plugin" : "project"),
    get: (key) => { calls.push(["get", key]); return []; },
    set: async (key, value) => { calls.push(["set", key, value]); },
    replace: async (key, base, value) => { calls.push(["replace", key, base, value]); return true; },
  };
  return {
    plugin: "probe", surface: "settings/probe", pending: new Map(), emitEvent() {}, startProject: () => null,
    runtime: {
      dependsOn: () => false,
      data: { of: (project, owner) => { calls.push(["of", project, owner]); return data; } },
      subscribe: { data: async (owner) => { calls.push(["on", owner]); } },
    },
  };
}

test("a view without a project reads, writes, replaces and follows a plugin key", async () => {
  const calls = [];
  const options = optionsWithout(calls);
  assert.deepEqual(await answerViewCall({ id: 1, command: "runtime.data.get", params: { key: "accounts" } }, options), []);
  assert.equal(await answerViewCall({ id: 2, command: "runtime.data.set", params: { key: "accounts", value: ["a"] } }, options), null);
  assert.equal(await answerViewCall({ id: 3, command: "runtime.data.replace", params: { key: "accounts", base: ["a"], value: ["b"] } }, options), true);
  assert.equal(await answerViewCall({ id: 4, command: "runtime.data.on", params: null }, options), null);
  assert.deepEqual(calls.filter((call) => call[0] !== "of"), [["get", "accounts"], ["set", "accounts", ["a"]], ["replace", "accounts", ["a"], ["b"]], ["on", undefined]]);
  assert.ok(calls.filter((call) => call[0] === "of").every((call) => call[1] === null && call[2] === "probe"));
});

test("a project key of a view without a project is refused and reaches no store", async () => {
  for (const [command, params] of [["runtime.data.get", { key: "marks" }], ["runtime.data.set", { key: "marks", value: [] }], ["runtime.data.replace", { key: "marks", base: [], value: [] }]]) {
    const calls = [];
    await assert.rejects(answerViewCall({ id: 5, command, params }, optionsWithout(calls)), new RegExp(`^Error: view call ${command.replaceAll(".", "\\.")} requires a project$`));
    assert.deepEqual(calls.filter((call) => call[0] !== "of"), []);
  }
});
