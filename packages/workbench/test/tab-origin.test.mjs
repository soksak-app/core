// The origin of a tab: the recorded origin of a new tab, the origin loaded from the layout, the refusal of a view tab without a
// valid origin, and the stored form (docs/spec/projects.md, docs/spec/native-surfaces.md#view-surfaces).
import assert from "node:assert/strict";
import test from "node:test";
import { recordOrigin, releasedNonViewOrigin, restoreOrigin, reportDirectory, storedLayoutState, tabOrigin, viewRefusal } from "../tab-reports.js";
import { recordStoredOrigins } from "../stored-layout.js";

const isView = (plugin) => plugin === "view-plugin";

test("a new tab stores the origin its source tab recorded at that moment", () => {
  reportDirectory("origin-src", "/tmp/project");
  recordOrigin("origin-new", "origin-src");
  reportDirectory("origin-src", "/tmp/elsewhere");
  assert.deepEqual(tabOrigin("origin-new"), { directory: "/tmp/project" });
  recordOrigin("origin-none", null);
  assert.deepEqual(tabOrigin("origin-none"), { directory: null });
});

test("a tab with neither a recorded origin nor a loaded origin throws instead of reading a fallback", () => {
  assert.throws(() => tabOrigin("origin-unknown"), /tab origin-unknown has no origin/);
  assert.throws(() => storedLayoutState({ cards: [{ id: "c", data: { tabs: [{ id: "origin-unknown", plugin: "p" }] } }] }),
    /tab origin-unknown has no origin to store/);
});

test("a non-view tab without an origin member reads the released format-1 origin", () => {
  restoreOrigin({ id: "origin-legacy", plugin: "plain" }, isView("plain"));
  assert.deepEqual(releasedNonViewOrigin(), { directory: null });
  assert.deepEqual(tabOrigin("origin-legacy"), { directory: null });
  assert.equal(viewRefusal("origin-legacy"), null);
});

test("a view tab without an origin member is refused with the missing-origin text", () => {
  restoreOrigin({ id: "origin-view-absent", plugin: "view-plugin" }, true);
  assert.equal(viewRefusal("origin-view-absent"), 'surface "origin-view-absent": view start origin is missing');
  assert.throws(() => tabOrigin("origin-view-absent"), /has no origin/);
});

test("a view tab with an invalid origin is refused, and the stored value is kept verbatim", () => {
  restoreOrigin({ id: "origin-view-rel", plugin: "view-plugin", origin: { directory: "relative" } }, true);
  assert.equal(viewRefusal("origin-view-rel"),
    'surface "origin-view-rel": view start origin directory is not an absolute path');
  assert.deepEqual(storedLayoutState({ cards: [{ id: "c", data: { tabs: [{ id: "origin-view-rel", plugin: "view-plugin" }] } }] })
    .cards[0].data.tabs[0].origin, { directory: "relative" });
});

test("a view tab with a valid origin starts with it and is not refused", () => {
  restoreOrigin({ id: "origin-view-ok", plugin: "view-plugin", origin: { directory: "/a" } }, true);
  assert.equal(viewRefusal("origin-view-ok"), null);
  assert.deepEqual(tabOrigin("origin-view-ok"), { directory: "/a" });
});

test("a stored layout gets the origin of each tab, writes no member for an absent loaded origin, and drops tabs that left", () => {
  recordOrigin("origin-store", null);
  const state = storedLayoutState({ cards: [{ id: "c", data: { activeId: "origin-store", tabs: [{ id: "origin-store", plugin: "p" }] } },
    { id: "side", data: null }] });
  assert.deepEqual(state.cards[0].data.tabs[0], { id: "origin-store", plugin: "p", origin: { directory: null } });
  assert.equal(state.cards[1].data, null);
  restoreOrigin({ id: "origin-absent", plugin: "view-plugin" }, true);
  const absent = storedLayoutState({ cards: [{ id: "c", data: { tabs: [{ id: "origin-absent", plugin: "view-plugin" }] } }] });
  assert.equal(Object.hasOwn(absent.cards[0].data.tabs[0], "origin"), false);
});

test("the layout read refuses each view tab once, returns its text, and never throws", () => {
  const kept = { state: { cards: [
    { id: "a", data: { activeId: "t-view", tabs: [{ id: "t-view", plugin: "view-plugin" }] } },
    { id: "b", data: { activeId: "t-plain", tabs: [{ id: "t-plain", plugin: "plain" }] } },
  ] } };
  const refusals = recordStoredOrigins(kept, isView);
  assert.deepEqual(refusals, [{ tabId: "t-view", text: 'surface "t-view": view start origin is missing' }]);
  assert.equal(viewRefusal("t-view"), refusals[0].text);
  assert.equal(viewRefusal("t-plain"), null);
  assert.deepEqual(tabOrigin("t-plain"), { directory: null });
});
