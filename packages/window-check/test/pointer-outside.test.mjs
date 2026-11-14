import assert from "node:assert/strict";
import test from "node:test";
import { Session } from "../app.mjs";
import { playSession } from "../fixtures/endpoint-player.mjs";

test("a failed pointer-outside move retains its input and final geometry", { timeout: 5000 }, async (t) => {
  const initial = {
    pointer: { x: 50, y: 40 },
    frame: { x: 0, y: 0, width: 100, height: 80 },
    content: { width: 100, height: 80 },
  };
  const screen = {
    x: 0,
    y: 0,
    width: 300,
    height: 200,
    visible: { x: 0, y: 0, width: 300, height: 200 },
  };
  const final = {
    ...initial,
    pointer: { x: 70, y: 50 },
  };
  // The host moves the window and reports it where it was, with the pointer inside it, and ends the watch of host.window because
  // its window closed; the connection stays open, so the final geometry can be read.
  const { session } = await playSession(t, Session, "window-check-pointer-outside-stays", "fixture");
  await assert.rejects(session.keepPointerOutside(), (error) => {
    assert.match(error.message, /keepPointerOutside=/);
    assert.match(error.message, /^fixture: the window did not move away from the pointer \(status host\.window ended: the window closed\); /);
    const details = JSON.parse(error.message.split("keepPointerOutside=")[1]);
    assert.deepEqual(details, {
      initialPointer: initial.pointer,
      screenVisible: screen.visible,
      candidate: { x: 200, y: 0, width: 100, height: 80 },
      actual: { frame: final.frame, pointer: final.pointer },
    });
    return true;
  });
});
