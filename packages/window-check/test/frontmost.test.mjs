import assert from "node:assert/strict";
import test from "node:test";
import { unlessCovered } from "../frontmost.mjs";

test("a wait that fails while another window covers the window states the covering window", async () => {
  const timeout = new Error("no event line matched within 30000 ms");
  await assert.rejects(unlessCovered(async () => { throw timeout; }, async () => "Editor at {\"x\":0,\"y\":33,\"width\":1512,\"height\":892}"),
    (error) => {
      assert.match(error.message, /^the window is completely covered by Editor at \{"x":0,"y":33,"width":1512,"height":892\}/);
      assert.match(error.message, /Nothing was measured/);
      assert.equal(error.cause, timeout);
      return true;
    });
});

test("a wait that fails while no window covers the window fails with its own error", async () => {
  const timeout = new Error("no event line matched within 30000 ms");
  await assert.rejects(unlessCovered(async () => { throw timeout; }, async () => null), (error) => error === timeout);
});

test("a wait that succeeds returns its result without measuring the covering windows", async () => {
  let measured = false;
  assert.equal(await unlessCovered(async () => "line", async () => { measured = true; return null; }), "line");
  assert.equal(measured, false);
});

test("the place of a window counts the windows of the ordinary layer in front of the front window of its process", async () => {
  const { placeIn } = await import("../frontmost.mjs");
  const list = [{ owner: "Browser", pid: 10 }, { owner: "Browser", pid: 10 }, { owner: "soksak", pid: 42 }, { owner: "soksak", pid: 42 }];
  assert.equal(placeIn(list, 42), 2);
  assert.equal(placeIn(list, 10), 0);
  assert.throws(() => placeIn(list, 7), /process 7 has no window in the window list/);
});

test("the windows behind a window count the windows of other processes behind the front window of its process", async () => {
  const { behindIn } = await import("../frontmost.mjs");
  const list = [{ pid: 10 }, { pid: 42 }, { pid: 10 }, { pid: 42 }, { pid: 11 }];
  assert.equal(behindIn(list, 42), 2);
  assert.equal(behindIn(list, 11), 0);
  assert.throws(() => behindIn(list, 7), /process 7 has no window in the window list/);
});
