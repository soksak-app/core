import assert from "node:assert/strict";
import test from "node:test";

import { declaredSidebarControlIndex, focusDeclaredSidebarControl } from "../declared-sidebar-control.mjs";

const address = { sidebar: "left", section: "files.tree", key: "files", path: ["folder", "note"], role: "label" };
const rect = (x) => ({ x, y: 20, width: 80, height: 20 });
const sidebars = [
  { sidebar: "left", sections: [{ id: "files.bookmarks", controls: 2 }, { id: "files.tree", controls: 3 }] },
  { sidebar: "right", sections: [{ id: "terminal.session", controls: 1 }] },
];

const session = ({ rectangles = [rect(1), rect(2), rect(3), rect(12), rect(4), rect(5)] } = {}) => {
  const calls = [];
  return {
    calls,
    async get(name) {
      assert.equal(name, "core.sidebars");
      return sidebars;
    },
    async request(name, params) {
      assert.equal(name, "dom.rect");
      calls.push(["rect", params]);
      return params.address ? rect(12) : rectangles[params.index];
    },
    async run(name, params) {
      calls.push(["run", name, params]);
      return null;
    },
    async until(name, predicate) {
      calls.push(["until", name]);
      assert.equal(name, "core.focus");
      assert.equal(predicate({ name: "core.sidebar.section.control", index: 2 }), false,
        "a different control was accepted as focused");
      const focused = { name: "core.sidebar.section.control", index: 3, surface: null };
      assert.equal(predicate(focused), true, "the exact declared control focus was not accepted");
      return focused;
    },
  };
};

test("a declared control address resolves uniquely within its section range", async () => {
  const s = session();
  assert.equal(await declaredSidebarControlIndex(s, address), 3);
  const indices = s.calls.filter(([kind]) => kind === "rect").map(([, params]) => params.index).filter(Number.isInteger);
  assert.deepEqual(indices, [2, 3, 4]);
  assert.equal(indices.includes(0), false, "the lookup inspected controls outside the declared section");
});

test("a declared sidebar control is focused before the consumer sends keyboard input", async () => {
  const s = session();
  const focused = await focusDeclaredSidebarControl(s, address);
  s.calls.push(["key", "Enter"]);
  assert.equal(focused.index, 3);
  assert.deepEqual(s.calls.filter(([kind]) => kind !== "rect").map((call) => call.slice(0, 2)), [
    ["run", "core.focus.set"],
    ["until", "core.focus"],
    ["key", "Enter"],
  ]);
  assert.deepEqual(s.calls.find(([kind, name]) => kind === "run" && name === "core.focus.set")[2],
    { name: "core.sidebar.section.control", index: 3 });
});

test("a declared control address rejects absent sections and ambiguous rectangles", async () => {
  const missing = session();
  await assert.rejects(declaredSidebarControlIndex(missing, { ...address, section: "files.missing" }),
    /no exposed controls for left\/files\.missing/);
  assert.equal(missing.calls.some(([kind]) => kind === "rect"), false, "a missing section requested a DOM rectangle");

  const ambiguous = session({ rectangles: [rect(1), rect(2), rect(12), rect(12), rect(4), rect(5)] });
  await assert.rejects(declaredSidebarControlIndex(ambiguous, address),
    /the declared control address maps to 2 exposed DOM indices/);
});
