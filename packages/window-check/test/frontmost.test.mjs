import assert from "node:assert/strict";
import test from "node:test";
import { unlessCovered, windowsCoveringWhole } from "../frontmost.mjs";

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

test("the windows behind a window leave out the windows of the processes that the count excludes", async () => {
  const { behindIn } = await import("../frontmost.mjs");
  // 42 is checked; 11 and 12 are other applications of the same run, which open behind every window after 42 opened.
  const list = [{ pid: 10 }, { pid: 42 }, { pid: 11 }, { pid: 12 }, { pid: 13 }];
  assert.equal(behindIn(list, 42, [11, 12]), 1);
  assert.equal(behindIn(list, 42, [11, 12, 13]), 0);
});

test("windows that together cover a window are named although none covers it alone", () => {
  const frame = { x: 100, y: 100, width: 400, height: 300 };
  const left = { owner: "Editor", pid: 7, frame: { x: 0, y: 0, width: 300, height: 600 } };
  const right = { owner: "Mail", pid: 8, frame: { x: 300, y: 50, width: 400, height: 400 } };
  const own = { owner: "soksak", pid: 20, frame };
  assert.deepEqual(windowsCoveringWhole(20, frame, () => [left, right, own]), [left, right]);
});

test("windows in front of a window that leave a part of it uncovered cover nothing", () => {
  const frame = { x: 100, y: 100, width: 400, height: 300 };
  const left = { owner: "Editor", pid: 7, frame: { x: 0, y: 0, width: 300, height: 600 } };
  const right = { owner: "Mail", pid: 8, frame: { x: 301, y: 50, width: 400, height: 400 } };
  const behind = { owner: "Notes", pid: 9, frame: { x: 0, y: 0, width: 1000, height: 1000 } };
  assert.deepEqual(windowsCoveringWhole(20, frame, () => [left, right, { owner: "soksak", pid: 20, frame }, behind]), []);
});
