// Checks the page side of the commands of a view (docs/spec/native-surfaces.md#view-surfaces): a command that the page runs for
// its exposure request is sent to the view and answered by the reply of the view. The post and the reports are fakes.
import assert from "node:assert/strict";
import test from "node:test";
import { createViewCommands } from "../view-commands.js";

function setup({ timeoutOf = () => undefined, post = async () => {} } = {}) {
  const posted = [];
  const reports = [];
  const commands = createViewCommands({
    plugin: "probe",
    post: async (message) => { posted.push(message); return post(message); },
    timeoutOf,
    report: (event) => reports.push(event),
  });
  return { commands, posted, reports };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("a command run is posted to the view and resolves with the result of its reply", async () => {
  const { commands, posted } = setup();
  const result = commands.run("probe.run", { a: 1 });
  await tick();
  assert.equal(posted.length, 1);
  assert.equal(posted[0].command, "probe.run");
  assert.deepEqual(posted[0].params, { a: 1 });
  commands.receive({ surface: "probe-surface", plugin: "probe", id: posted[0].id, result: { n: 2 } });
  assert.deepEqual(await result, { n: 2 });
});

test("a reply with an error rejects the command run with its message", async () => {
  const { commands, posted } = setup();
  const result = commands.run("probe.run", null);
  await tick();
  commands.receive({ surface: "probe-surface", plugin: "probe", id: posted[0].id, error: { code: -32000, message: "boom" } });
  await assert.rejects(result, { message: "boom" });
});

test("a post that the host refuses rejects the command run with the refusal text", async () => {
  const { commands } = setup({ post: async () => { throw new Error("probe-surface has no ready document"); } });
  await assert.rejects(commands.run("probe.run", null), { message: "probe-surface has no ready document" });
});

test("a command without a reply in its declared time limit rejects, and its late reply is counted", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { commands, posted, reports } = setup({ timeoutOf: () => 50 });
  const result = commands.run("probe.run", null);
  await tick();
  t.mock.timers.tick(50);
  await assert.rejects(result, { message: "command probe.run did not reply within 50ms" });
  assert.deepEqual(reports.map((event) => event.kind), ["open-calls", "timeout", "open-calls"]);
  commands.receive({ surface: "probe-surface", plugin: "probe", id: posted[0].id, result: null });
  assert.equal(reports.at(-1).kind, "late-reply");
});

test("closing the surface rejects the open command runs and reports the peer loss", async () => {
  const { commands, reports } = setup();
  const result = commands.run("probe.run", null);
  await tick();
  commands.close();
  await assert.rejects(result, { message: "command probe.run ended: surface-closed" });
  assert.ok(reports.some((event) => event.kind === "peer-lost" && event.reason === "surface-closed"));
});
