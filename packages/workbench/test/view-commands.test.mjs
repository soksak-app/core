// Checks the page side of the commands of a view (docs/spec/native-surfaces.md#view-surfaces): a command that the page runs for
// its exposure request is sent to the view and answered by the reply of the view. A command has no time limit: its reply, the
// close of its surface or the end of the view ends it. The post and the report are the functions that createViewCommands takes as parameters;
// the test records what they receive.
import assert from "node:assert/strict";
import test from "node:test";
import { createViewCommands } from "../view-commands.js";

function setup({ post = async () => {} } = {}) {
  const posted = [];
  const reports = [];
  // arrival() gives a promise that resolves when the next request is posted to the view.
  let arrived = () => {};
  const commands = createViewCommands({
    plugin: "probe",
    post: async (message) => { posted.push(message); arrived(); return post(message); },
    report: (event) => reports.push(event),
  });
  const arrival = () => new Promise((resolve) => { arrived = resolve; });
  return { commands, posted, reports, arrival };
}

test("a command run is posted to the view and resolves with the result of its reply", async () => {
  const { commands, posted, arrival } = setup();
  const sent = arrival();
  const result = commands.run("probe.run", { a: 1 });
  await sent;
  assert.equal(posted.length, 1);
  assert.equal(posted[0].command, "probe.run");
  assert.deepEqual(posted[0].params, { a: 1 });
  commands.receive({ surface: "probe-surface", plugin: "probe", id: posted[0].id, result: { n: 2 } });
  assert.deepEqual(await result, { n: 2 });
});

test("a reply with an error rejects the command run with its message", async () => {
  const { commands, posted, arrival } = setup();
  const sent = arrival();
  const result = commands.run("probe.run", null);
  await sent;
  commands.receive({ surface: "probe-surface", plugin: "probe", id: posted[0].id, error: { code: -32000, message: "boom" } });
  await assert.rejects(result, { message: "boom" });
});

test("a post that the host refuses rejects the command run with the refusal text", async () => {
  const { commands } = setup({ post: async () => { throw new Error("probe-surface has no ready document"); } });
  await assert.rejects(commands.run("probe.run", null), { message: "probe-surface has no ready document" });
});

test("a native stale-source disposition resolves the command without converting it to a pull error", { timeout: 1000 }, async () => {
  const cancellation = { cancelled: true, sourceGeneration: 4 };
  const { commands } = setup({ post: async () => cancellation });
  try {
    assert.deepEqual(await commands.run("probe.read", { status: "lines" }), cancellation);
  } finally {
    commands.close();
  }
});

test("createViewCommands takes no time limit of a command", () => {
  assert.throws(() => createViewCommands({ plugin: "probe", post: async () => {}, report: () => {}, timeoutOf: () => 50 }),
    { name: "TypeError", message: /timeoutOf/ }, "the command layer of a view accepted a time limit of a command");
});

// contract: exposure.command.ends-by-reply-or-peer-end
// The command layer has no timer of its own, and the call layer of plugin-api refuses a time limit by contract (docs/spec/plugin-processes.md,
// rule 3), so a command without a reply stays open with no deadline to arm.
test("a command without a reply starts no timer and stays open until the surface closes", async () => {
  const { commands, posted, reports, arrival } = setup();
  const sent = arrival();
  const result = commands.run("probe.run", null);
  await sent;
  assert.equal(posted.length, 1, "the command was not posted to the view");
  assert.deepEqual(reports.map((event) => event.kind), ["open-calls"]);
  commands.close();
  await assert.rejects(result, { message: "command probe.run ended: surface-closed" });
  assert.deepEqual(reports.map((event) => event.kind), ["open-calls", "peer-lost", "open-calls"]);
});

test("closing the surface rejects the open command runs and reports the peer loss", async () => {
  const { commands, reports, arrival } = setup();
  const sent = arrival();
  const result = commands.run("probe.run", null);
  await sent;
  commands.close();
  await assert.rejects(result, { message: "command probe.run ended: surface-closed" });
  assert.ok(reports.some((event) => event.kind === "peer-lost" && event.reason === "surface-closed"));
});

test("a command run that carries the cids of its cause posts them with the request", async () => {
  const { commands, posted, arrival } = setup();
  const sent = arrival();
  const result = commands.run("probe.run", null, ["p1700000000000.7"]);
  await sent;
  assert.deepEqual(posted[0].cids, ["p1700000000000.7"]);
  commands.receive({ surface: "probe-surface", plugin: "probe", id: posted[0].id, result: null });
  await result;
});

test("a command run without cids posts a request without the cids member", async () => {
  const { commands, posted, arrival } = setup();
  const sent = arrival();
  const result = commands.run("probe.run", null);
  await sent;
  assert.equal("cids" in posted[0], false);
  commands.receive({ surface: "probe-surface", plugin: "probe", id: posted[0].id, result: null });
  await result;
});

test("a command run rejects cids that a line cannot hold, and posts nothing", async () => {
  const { commands, posted } = setup();
  await assert.rejects(commands.run("probe.run", null, ["p1.7\"x"]), { name: "TypeError", message: "command cids must be an array of non-empty strings without a quote, a backslash or a control character" });
  assert.equal(posted.length, 0);
});
