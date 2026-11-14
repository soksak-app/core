import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { connect } from "@soksak/client";
import { startCasePlayer } from "@soksak/client/testing";

import { Session } from "../app.mjs";

// The configuration folder of the fixture holds no record of an application that stopped replying.
const app = { name: "fixture", configDir: mkdtempSync(join(tmpdir(), "soksak-pointer-presses-")) };
process.once("exit", () => rmSync(app.configDir, { recursive: true, force: true }));
const open = (s) => [...(s.presses?.values() ?? [])];

// Starts the case player of the case and connects the client of the package to it. Closing the player throws when the case was not
// played to its end.
async function play(t, name) {
  const server = await startCasePlayer(name);
  t.after(() => server.close());
  const client = await connect({ configDir: server.configDir });
  t.after(() => client.close());
  return { server, client };
}

// The requests that the client sent to the player, each as the object of its method and params.
const sent = (server) => server.requests.map(({ method, params }) => ({ method, ...params }));

test("a check session releases every press it left open", async (t) => {
  const { server, client } = await play(t, "window-check-presses-release-all");
  const s = new Session(app, client);
  await s.pointer(10, 20, "down");
  await s.on("second").pointer(30, 40, "down", { button: "right" });
  await s.pointer(5, 6, "down", { button: "right" });
  await s.pointer(5, 6, "up", { button: "right" });
  assert.deepEqual(open(s), [
    { window: "main", x: 10, y: 20, button: "left" },
    { window: "second", x: 30, y: 40, button: "right" },
  ]);
  await s.releasePresses();
  assert.deepEqual(open(s), []);
  assert.deepEqual(sent(server).filter((request) => request.method === "input.pointer").slice(-2), [
    { method: "input.pointer", window: "main", x: 10, y: 20, phase: "up", button: "left" },
    { method: "input.pointer", window: "second", x: 30, y: 40, phase: "up", button: "right" },
  ]);
});

test("a check session releases the press of each named pointer", async (t) => {
  const { server, client } = await play(t, "window-check-presses-named-pointers");
  const s = new Session(app, client);
  await s.pointer(10, 20, "down", { pointer: "first" });
  await s.pointer(30, 40, "down", { pointer: "second" });
  assert.deepEqual(open(s), [
    { window: "main", pointer: "first", x: 10, y: 20, button: "left" },
    { window: "main", pointer: "second", x: 30, y: 40, button: "left" },
  ]);
  await s.releasePresses();
  assert.deepEqual(open(s), []);
  assert.deepEqual(sent(server).filter((request) => request.method === "input.pointer").slice(-2), [
    { method: "input.pointer", window: "main", x: 10, y: 20, phase: "up", button: "left", pointer: "first" },
    { method: "input.pointer", window: "main", x: 30, y: 40, phase: "up", button: "left", pointer: "second" },
  ]);
});

test("a refused release keeps the press open until the held button is released", async (t) => {
  const { server, client } = await play(t, "window-check-presses-held-refused");
  const s = new Session(app, client);
  await s.pointer(10, 20, "down");
  // Whether the rejected event was a press or a release decides whether an open press remains, so the error names the
  // step and the location.
  await assert.rejects(s.pointer(10, 20, "up"), (error) => error.code === 1007 &&
    /^input\.pointer up of the left button at 10,20 in main: .*AppKit reports NSEvent\.pressedMouseButtons mask 0x1/.test(error.message));
  assert.deepEqual(open(s), [{ window: "main", x: 10, y: 20, button: "left" }]);
  // The clock gives the instant before and after the wait for host.buttons, so the waited time is the difference of the instants.
  const instants = [1000, 1234];
  const released = await s.releasePresses({ clock: () => instants.shift() });
  // A press that the cleanup ended remains as a diagnostic of the check, so the output of the window run shows that the
  // wait for the release ran.
  assert.deepEqual(released, ["released open press: left at 10,20 in main after host.buttons reported mask 0 (waited 234ms)"]);
  assert.deepEqual(instants, [], "the clock was read before and after the wait");
  assert.deepEqual(sent(server).map(({ method, phase }) => (method === "input.pointer" ? phase : method)),
    ["down", "up", "status.watch", "status.get", "status.unwatch", "up"]);
  assert.deepEqual(open(s), []);
  // A press of the same button after an ended press is delivered (it is not 1008).
  await s.pointer(10, 20, "down");
  await s.pointer(10, 20, "up");
});

test("a high-level click waits for an already-held button before pressing", async (t) => {
  const { server, client } = await play(t, "window-check-click-held-before");
  const s = new Session(app, client);
  await s.click(10, 20);
  assert.deepEqual(sent(server).filter((request) => request.method === "input.pointer").map(({ phase }) => phase), ["down", "up"]);
});

test("a high-level click waits for a button held between its press and release", async (t) => {
  const { server, client } = await play(t, "window-check-click-held-between");
  const s = new Session(app, client);
  await s.click(10, 20);
  assert.deepEqual(sent(server).filter((request) => request.method === "input.pointer").map(({ phase }) => phase), ["down", "up"]);
});

test("a release that is refused after the buttons are released reports the press that stayed open", async (t) => {
  const { client } = await play(t, "window-check-presses-release-refused-late");
  const s = new Session(app, client);
  await s.pointer(10, 20, "down");
  await assert.rejects(s.pointer(10, 20, "up"), /pressedMouseButtons/);
  assert.deepEqual(open(s), [{ window: "main", x: 10, y: 20, button: "left" }]);
  await assert.rejects(s.releasePresses(), /the synthetic left press at 10,20 in main stayed open: .*pressedMouseButtons/);
});

test("a press or release that the document received late still changes the open presses", async (t) => {
  const { client } = await play(t, "window-check-presses-late-document");
  const s = new Session(app, client);
  await assert.rejects(s.pointer(10, 20, "down"), /did not receive/);
  assert.deepEqual(open(s), [{ window: "main", x: 10, y: 20, button: "left" }]);
  await assert.rejects(s.pointer(10, 20, "up"), /did not receive/);
  assert.deepEqual(open(s), []);
});
