import assert from "node:assert/strict";
import test from "node:test";

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
