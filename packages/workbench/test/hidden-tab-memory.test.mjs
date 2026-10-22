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
