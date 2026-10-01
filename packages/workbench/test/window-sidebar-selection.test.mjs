import assert from "node:assert/strict";
import test from "node:test";
import { resolveSidebar } from "../sidebar-sets.js";
import { standingLink, windowSidebarCards } from "../window-sidebars.js";

test("fixed sidebar selection applies only the focused active plugin override", () => {
  const units = [{ id: "pane" }, { id: "other" }];
  const links = [{ place: "left", plugin: null, set: "general" }, { place: "window-left", plugin: "pane", set: "override" }];
  assert.deepEqual(standingLink("left", windowSidebarCards(units, links, "pane")), { place: "window-left", plugin: "pane" });
  assert.deepEqual(standingLink("left", windowSidebarCards(units, links, "other")), { place: "left", plugin: null });
  assert.throws(() => standingLink("left", windowSidebarCards(units, [], "pane")), /unknown window sidebar left/, "a side without a link has no fixed sidebar");
  assert.throws(() => standingLink("top", windowSidebarCards(units, links, "pane")), /unknown window sidebar top/);
});

test("a null link set is rejected instead of silently hiding the sidebar", () => {
  assert.throws(() => resolveSidebar([{ place: "left", plugin: null, set: null }], [], "left", null), /set that is gone/);
});
