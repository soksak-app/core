// Checks the program runs of a view (docs/spec/native-surfaces.md#program-runs): a run sends programRun with the surface, the identifier
// of the view call, the name and the arguments; the cancel of an open run sends programCancel; and the sync request carries the programs
// of a view surface only when its plugin declares them.
import assert from "node:assert/strict";
import test from "node:test";
import { createProgramRuns, programsOfSurface } from "../program-runs.js";

const REPLY = { code: 0, stdout: "ok", stderr: "", truncated: { stdout: false, stderr: false } };

test("a run sends programRun with the surface, the call identifier, the name and the arguments, and resolves with the reply", async () => {
  const sent = [];
  const runs = createProgramRuns("probe-surface", (name, payload) => { sent.push([name, payload]); return Promise.resolve(REPLY); });
  assert.deepEqual(await runs.run(7, "probe-tool", ["a"]), REPLY);
  assert.deepEqual(sent, [["programRun", { surface: "probe-surface", id: 7, name: "probe-tool", args: ["a"] }]]);
});

test("the cancel of an open run sends programCancel with the surface and the call identifier, and of a run that is not open sends nothing", async () => {
  const sent = [];
  let finish;
  const runs = createProgramRuns("probe-surface", (name, payload) => {
    sent.push([name, payload]);
    return name === "programRun" ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve(null);
  });
  const run = runs.run(8, "probe-tool", []);
  assert.equal(runs.isOpen(8), true);
  await runs.cancel(8);
  assert.equal(runs.isOpen(8), false);
  assert.deepEqual(sent.at(-1), ["programCancel", { surface: "probe-surface", id: 8 }]);
  // A cancel of a call that is not a run sends nothing.
  await runs.cancel(9);
  assert.equal(sent.length, 2);
  finish(REPLY);
  await run;
  assert.equal(runs.isOpen(8), false);
});

test("a run that the host answers leaves the open runs", async () => {
  const runs = createProgramRuns("probe-surface", () => Promise.resolve(REPLY));
  await runs.run(10, "probe-tool", []);
  assert.equal(runs.isOpen(10), false);
});

test("a run that the host refuses rejects with the host error and leaves the open runs", async () => {
  const runs = createProgramRuns("probe-surface", () => Promise.reject(new Error("program probe-tool is not declared by probe")));
  await assert.rejects(runs.run(11, "probe-tool", []), /program probe-tool is not declared by probe/);
  assert.equal(runs.isOpen(11), false);
});

test("programsOfSurface gives the declared programs of a view surface and nothing for the others", () => {
  const programs = { "probe-tool": { program: "probe-tool" } };
  assert.deepEqual(programsOfSurface({ composition: { kind: "view" }, programs }), { programs });
  assert.deepEqual(programsOfSurface({ composition: { kind: "view" }, programs: null }), {});
  assert.deepEqual(programsOfSurface({ composition: { kind: "dom" }, programs }), {});
});
