// A check covers its window with a new window of the same application only after that window shows (F715-2): host.windows lists a
// window ready before the host puts it on the screen after its first screen.
import assert from "node:assert/strict";
import test from "node:test";
import * as fixtures from "../fixture.mjs";

const FRAME = { x: 300, y: 39, width: 1200, height: 760 };

/** A check window and a cover that goes on the screen with its first presented layout, and the calls of the two in order. */
function windows({ shows = true } = {}) {
  const calls = [];
  let presented = false;
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
  const cover = session("project-window-1", () => ({ frame: { x: 200, y: -11, width: 1400, height: 860 }, occluded: !(shows && presented) }));
  const s = session("main", () => ({ frame: { ...FRAME }, occluded: false }));
  return { s, cover, calls };
}

test("a cover is placed over the check window and judged once its layout presented and it shows", async () => {
  assert.equal(typeof fixtures.coverCheckWindow, "function", "the fixture owns the covering of a check window");
  const { s, cover, calls } = windows();
  const covered = await fixtures.coverCheckWindow(s, cover);
  assert.deepEqual(covered, FRAME);
  assert.deepEqual(calls, [
    { window: "project-window-1", command: "host.window.resize", params: { width: 1400, height: 860 } },
    { window: "project-window-1", command: "host.window.move", params: { x: 200, y: -11 } },
    { window: "project-window-1", command: "host.window.presented" },
    { window: "project-window-1", command: "until host.window" },
  ]);
});

test("a cover that does not show fails the check with the cover as its reason", async () => {
  const { s, cover } = windows({ shows: false });
  await assert.rejects(fixtures.coverCheckWindow(s, cover), /the covering window did not show on the screen/);
});
