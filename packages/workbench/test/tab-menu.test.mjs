import assert from "node:assert/strict";
import test from "node:test";

import { tabMenuItems } from "../tab-menu.js";

// The tab context menu (docs/spec/exposure.md#tab-memory): the keep item runs core.tab.keep with the toggled mark and shows the
// current mark, and a tab that can never be unloaded has no keep item.
test("the keep item toggles the mark kept and shows the current mark", () => {
  assert.deepEqual(tabMenuItems("t1", ["shown"]), [{ key: "keep", expose: "core.tab.menu-keep", name: "메모리에 유지", mark: "",
    svg: "", active: false, command: "core.tab.keep", params: { tab: "t1", keep: true } }]);
  const [kept] = tabMenuItems("t1", ["recent", "kept"]);
  assert.equal(kept.active, true);
  assert.deepEqual(kept.params, { tab: "t1", keep: false });
});

test("a tab that can never be unloaded has no keep item", () => {
  assert.deepEqual(tabMenuItems("t1", ["shown", "undeclared"]), []);
  assert.deepEqual(tabMenuItems("t1", ["background"]), []);
});
