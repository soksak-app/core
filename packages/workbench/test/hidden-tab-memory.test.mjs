import assert from "node:assert/strict";
import test from "node:test";
import { measureKind } from "../benchmark/hidden-tab-memory.mjs";

// A small surface of the scrollback kind: a grid of 10 rows of one text node each.
const SMALL = `export function mount(root, context) {
  const grid = document.createElement("div");
  for (let r = 0; r < 10; r++) { const row = document.createElement("div"); row.textContent = "row " + r; grid.append(row); }
  root.append(grid);
  context.tab.state.write({ rows: 10 });
  return { dispose() { root.replaceChildren(); } };
}`;

test("the entry of a kind has the declared fields and an unload returns the nodes of every tab", async () => {
  const entry = await measureKind({ kind: "scrollback", tabs: 3, source: SMALL, collect: () => {} });
  assert.deepEqual(Object.keys(entry), ["kind", "tabs", "before", "mounted", "unloaded", "mountedPerTab", "returnedPerTab", "storedStateBytes"]);
  for (const phase of ["before", "mounted", "unloaded"]) assert.deepEqual(Object.keys(entry[phase]), ["heapBytes", "domNodes"]);
  // Per tab: the slot, the surface host, its shadow root, the grid, 10 rows and their 10 text nodes.
  assert.equal(entry.mountedPerTab.domNodes, entry.returnedPerTab.domNodes);
  assert.equal(entry.mountedPerTab.domNodes, 24);
  assert.equal(entry.unloaded.domNodes, entry.before.domNodes);
  assert.equal(entry.storedStateBytes, JSON.stringify({ format: 1, value: { rows: 10 } }).length);
  await assert.rejects(measureKind({ kind: "other", tabs: 1, collect: () => {} }), /unknown fixture kind: other/);
});
