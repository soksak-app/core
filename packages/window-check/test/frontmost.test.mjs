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
