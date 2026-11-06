// Checks that the order name of a card does not depend on the ids of other kinds that a record names before it (F495).
import assert from "node:assert/strict";
import test from "node:test";
import { orderNames } from "../order-names.mjs";

test("the order name of an id counts only the earlier ids of its own kind", () => {
  const withProject = orderNames();
  withProject("open prj-a1 spc-b2");
  const withoutProject = orderNames();
  withoutProject("open spc-c3");
  assert.equal(withProject("tab-d4 tab-e5"), "tab-0 tab-1");
  assert.equal(withoutProject("tab-f6 tab-g7"), "tab-0 tab-1");
});

test("an id keeps its order name across texts", () => {
  const same = orderNames();
  assert.equal(same("tab-x1 spc-y2"), "tab-0 spc-0");
  assert.equal(same("spc-y2 tab-z3 tab-x1"), "spc-0 tab-1 tab-0");
});
