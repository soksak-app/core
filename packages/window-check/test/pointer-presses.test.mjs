import assert from "node:assert/strict";
import test from "node:test";

import { Session } from "../app.mjs";

/**
 * A connection that records requests and fails the input with the code that fail returns. host.buttons is the buttons
 * value, which press changes and reports to the watchers. The watch ends only by notification and uses no time limit.
 */
function fakeClient(fail = () => null) {
  const requests = [];
  const watches = new Set();
  const messages = {
    1005: "the document did not receive the input within 2000 ms",
    1007: "AppKit reports NSEvent.pressedMouseButtons mask 0x1 while com.apple.finder (pid 667) is frontmost",
  };
  const client = {
    requests,
    buttons: { mask: 0 },
    request: async (method, params) => {
      requests.push({ method, ...params });
      const code = method === "input.pointer" ? fail(params, client.buttons) : null;
      if (code !== null) throw Object.assign(new Error(messages[code]), { code });
      return null;
    },
    watch: (window, name, predicate) => new Promise((resolve, reject) => {
      if (name !== "host.buttons") {
        reject(new Error(`the fake watches only host.buttons, not ${name}`));
        return;
      }
      requests.push({ method: "status.watch", window, name });
      const watch = { predicate, resolve };
      if (predicate(client.buttons)) resolve(client.buttons);
      else watches.add(watch);
    }),
    /** Reports that a person pressed or released a button and host.buttons changed. */
    press(mask) {
      client.buttons = { mask };
      for (const watch of [...watches]) {
        if (!watch.predicate(client.buttons)) continue;
        watches.delete(watch);
        watch.resolve(client.buttons);
      }
    },
  };
  return client;
}

/** Runs all continuations of waiting promises. It does not wait for time. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** A host that rejects press and release while AppKit reports a button. */
const heldRefuses = (params, buttons) => ((params.phase === "down" || params.phase === "up") && buttons.mask !== 0 ? 1007 : null);

const app = { name: "fixture" };
const open = (s) => [...(s.presses?.values() ?? [])];

test("a check session releases every press it left open", async () => {
  const client = fakeClient();
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
  assert.deepEqual(client.requests.filter((request) => request.method === "input.pointer").slice(-2), [
    { method: "input.pointer", window: "main", x: 10, y: 20, phase: "up", button: "left" },
    { method: "input.pointer", window: "second", x: 30, y: 40, phase: "up", button: "right" },
  ]);
});

test("a refused release keeps the press open until the held button is released", async (t) => {
  // Stops the time functions so that a time limit cannot create progress. The cleanup progresses only by the
  // notification of host.buttons.
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const client = fakeClient(heldRefuses);
  const s = new Session(app, client);
  await s.pointer(10, 20, "down");
  client.press(0x1);
  // Whether the rejected event was a press or a release decides whether an open press remains, so the error names the
  // step and the location.
  await assert.rejects(s.pointer(10, 20, "up"), (error) => error.code === 1007 &&
    /^input\.pointer up of the left button at 10,20 in main: AppKit reports NSEvent\.pressedMouseButtons mask 0x1/.test(error.message));
  assert.deepEqual(open(s), [{ window: "main", x: 10, y: 20, button: "left" }]);
  const sent = client.requests.length;
  let ended = false;
  let released;
  const release = s.releasePresses().then((lines) => { ended = true; released = lines; });
  await settle();
  assert.equal(ended, false, "the cleanup ended while the button was held");
  assert.deepEqual(client.requests.slice(sent), [{ method: "status.watch", window: "main", name: "host.buttons" }],
    "the cleanup sent a release while host.buttons reported a held button");
  client.press(0);
  await release;
  // A press that the cleanup ended remains as a diagnostic of the check, so the output of the window run shows that the
  // wait for the release ran.
  assert.equal(released.length, 1);
  assert.match(released[0], /^released open press: left at 10,20 in main after host\.buttons reported mask 0 \(waited \d+ms\)$/);
  assert.deepEqual(client.requests.slice(sent), [
    { method: "status.watch", window: "main", name: "host.buttons" },
    { method: "input.pointer", window: "main", x: 10, y: 20, phase: "up", button: "left" },
  ]);
  assert.deepEqual(open(s), []);
  // A press of the same button after an ended press is delivered (it is not 1008).
  await s.pointer(10, 20, "down");
  await s.pointer(10, 20, "up");
});

test("a release that is refused after the buttons are released reports the press that stayed open", async () => {
  const client = fakeClient((params) => (params.phase === "up" ? 1007 : null));
  const s = new Session(app, client);
  await s.pointer(10, 20, "down");
  await assert.rejects(s.pointer(10, 20, "up"), /pressedMouseButtons/);
  assert.deepEqual(open(s), [{ window: "main", x: 10, y: 20, button: "left" }]);
  await assert.rejects(s.releasePresses(), /the synthetic left press at 10,20 in main stayed open: .*pressedMouseButtons/);
});

test("a press or release that the document received late still changes the open presses", async () => {
  const client = fakeClient(() => 1005);
  const s = new Session(app, client);
  await assert.rejects(s.pointer(10, 20, "down"), /did not receive/);
  assert.deepEqual(open(s), [{ window: "main", x: 10, y: 20, button: "left" }]);
  await assert.rejects(s.pointer(10, 20, "up"), /did not receive/);
  assert.deepEqual(open(s), []);
});
