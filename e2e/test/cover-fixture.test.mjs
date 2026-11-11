// A check covers its window with a new window of the same application once that window presented its first screen (F715-2):
// host.windows lists a window ready before the host puts it on the screen after its first screen.
import assert from "node:assert/strict";
import test from "node:test";
import * as fixtures from "../fixture.mjs";

const FRAME = { x: 300, y: 39, width: 1200, height: 760 };

/** A check window and a cover that goes on the screen with its first presented layout, and the calls of the two in order. */
function windows({ shows = true } = {}) {
  const calls = [];
  let presented = false;
  // The cover opens at the frame of a new window and takes the frame that the check gives it.
  const coverFrame = { x: 600, y: 300, width: 400, height: 300 };
  const session = (name, state) => ({
    app: { name: "mygo" }, window: name, client: { endpoint: { pid: 700 } },
    get: async (status) => {
      assert.equal(status, "host.window");
      return state();
    },
    run: async (command, params) => { calls.push({ window: name, command, params }); },
    presented: async () => {
      calls.push({ window: name, command: "host.window.presented" });
      presented = true;
    },
    until: async (status, predicate, message) => {
      calls.push({ window: name, command: `until ${status}` });
      const value = state();
      if (!predicate(value)) throw new Error(message);
      return value;
    },
  });
  // A window that is not on the screen reports occluded, as AppKit does for a window that does not show.
  const cover = session("project-window-1", () => ({ frame: { ...coverFrame }, occluded: !(shows && presented) }));
  const run = cover.run;
  cover.run = async (command, params) => {
    await run(command, params);
    if (command === "host.window.resize") Object.assign(coverFrame, { width: params.width, height: params.height });
    if (command === "host.window.move") Object.assign(coverFrame, { x: params.x, y: params.y });
  };
  const s = session("main", () => ({ frame: { ...FRAME }, occluded: false }));
  return { s, cover, calls };
}

test("a cover is placed over the check window and judged by its presented layout and its frame, not by its own occlusion", async () => {
  // Every check starts behind the windows of a person, so the cover itself may be occluded by them; its occlusion is no criterion
  // (docs/spec/hosts.md#launch-activation).
  assert.equal(typeof fixtures.coverCheckWindow, "function", "the fixture owns the covering of a check window");
  const { s, cover, calls } = windows({ shows: false });
  const covered = await fixtures.coverCheckWindow(s, cover);
  assert.deepEqual(covered, FRAME);
  assert.deepEqual(calls, [
    { window: "project-window-1", command: "host.window.resize", params: { width: 1400, height: 860 } },
    { window: "project-window-1", command: "host.window.move", params: { x: 200, y: -11 } },
    { window: "project-window-1", command: "host.window.presented" },
    { window: "project-window-1", command: "until host.window" },
  ]);
});

test("a cover whose frame does not hold the check window fails the check with the frames", async () => {
  const { s, cover } = windows();
  cover.run = async () => {};
  await assert.rejects(fixtures.coverCheckWindow(s, cover), /the covering window does not hold the frame of the check window/);
});

test("the fixture raises no window and parks no window of a check", () => {
  // A check starts behind the windows of a person and covers its window with its own window.
  assert.equal(fixtures.prepareOcclusionFixture, undefined);
  assert.equal(fixtures.uncoverFromCheckWindows, undefined);
});
