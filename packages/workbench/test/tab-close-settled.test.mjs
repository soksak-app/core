// core.tab.close waits for the drawing of the plane after the tab close finishes. A tab close releases the surface, removes the tab from the plane, and schedules a new layout.
// If the command does not wait for that close, the drawing wait of the command reads the slot and answers before the release, and the drawing wait of the next command that the test sends
// reads a slot that still has the released surface by name and fails with `surface … is not mounted` (F50).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";

test("core.tab.close answers after the tab close and its draw", { timeout: 5000 }, async (t) => {
  const markup = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const dom = new JSDOM(markup, { url: "http://localhost/" });
  dom.window.matchMedia = (query) => ({ media: query, matches: true,
    addEventListener: () => {}, removeEventListener: () => {} });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.CSS = dom.window.CSS;
  globalThis.PointerEvent = dom.window.PointerEvent;
  globalThis.MouseEvent = dom.window.MouseEvent;
  globalThis.addEventListener = dom.window.addEventListener.bind(dom.window);

  // The tab close stays in release until the test ends it. The order of the commands is recorded.
  const events = [];
  let finishClose;
  const actualPlane = await import("../plane.js");
  t.mock.module("../plane.js", { exports: { ...actualPlane,
    closeTabById: (tab) => {
      events.push(`close ${tab}`);
      return new Promise((resolve) => { finishClose = () => { events.push(`closed ${tab}`); resolve(); }; });
    },
  } });
  const { registry } = await import("../exposure.js");
  registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
  const { installCoreExposure } = await import("../core-exposure.js");
  try {
    await installCoreExposure({
      library: { state: () => null }, renames: { state: () => null }, chrome: () => null,
      drawn: async () => { events.push("settled"); },
    });
    let answered = false;
    const answer = registry.run("core.tab.close", { tab: "tab-a" }).then(() => { answered = true; });
    // Runs all pending microtasks. While the release has not finished, the command does not answer and does not start the drawing wait.
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events, ["close tab-a"], "the command waited for the draw before the tab close finished");
    assert.equal(answered, false, "the command answered before the tab close finished");
    finishClose();
    await answer;
    assert.deepEqual(events, ["close tab-a", "closed tab-a", "settled"]);
  } finally {
    dom.window.close();
  }
});
