import assert from "node:assert/strict";
import test from "node:test";

import { Session } from "../app.mjs";

test("a failed pointer-outside move retains its input and final geometry", async () => {
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
  const commands = [];
  const session = new Session({ name: "fixture" }, {});
  let windowReads = 0;
  session.get = async (name) => {
    assert.ok(["host.window", "host.screens"].includes(name));
    if (name === "host.screens") return [screen];
    windowReads++;
    return windowReads < 3 ? initial : final;
  };
  session.run = async (name, params) => {
    commands.push({ name, params });
  };
  session.until = async (name, predicate, message) => {
    assert.equal(name, "host.window");
    assert.equal(predicate(final), false);
    throw Object.assign(new Error(`fixture: ${message}; last value ${JSON.stringify(final)}`), {
      code: "ETIMEDOUT",
    });
  };

  await assert.rejects(session.keepPointerOutside(), (error) => {
    assert.match(error.message, /keepPointerOutside=/);
    const details = JSON.parse(error.message.split("keepPointerOutside=")[1]);
    assert.deepEqual(details, {
      initialPointer: initial.pointer,
      screenVisible: screen.visible,
      candidate: { x: 200, y: 0, width: 100, height: 80 },
      actual: { frame: final.frame, pointer: final.pointer },
    });
    return true;
  });
  assert.deepEqual(commands, [{ name: "host.window.move", params: { x: 200, y: 0 } }]);
});
