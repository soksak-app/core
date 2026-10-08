// The debug view lists the newest file first (docs/spec/debug.md).
import assert from "node:assert/strict";
import test from "node:test";

import { newestFirst } from "../debug-order.js";

test("the files are listed newest first, and files of the same time by path", () => {
  const entries = [
    { path: "logs/a.log", size: 1, modified: 100 },
    { path: "logs/c.log", size: 1, modified: 300 },
    { path: "logs/b.log", size: 1, modified: 300 },
    { path: "logs/d.log", size: 1, modified: 200 },
  ];
  assert.deepEqual(newestFirst(entries).map((entry) => entry.path), ["logs/b.log", "logs/c.log", "logs/d.log", "logs/a.log"]);
  assert.deepEqual(entries.map((entry) => entry.path), ["logs/a.log", "logs/c.log", "logs/b.log", "logs/d.log"], "the argument changed");
});
