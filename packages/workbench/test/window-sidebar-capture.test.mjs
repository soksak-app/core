import assert from "node:assert/strict";
import test from "node:test";
import { keepWindowSidebarWidths } from "../window-sidebars.js";

test("space capture records a resized window sidebar even without another settle", () => {
  const records = { left: { width: 190 } };
  keepWindowSidebarWidths([{ id: "left", width: 230 }, { id: "main", width: 400 }], records);
  assert.deepEqual(records, { left: { width: 230 } });
});
