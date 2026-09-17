import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PAGE_IMPORTS, pageImports } from "@soksak/plugin-api";

test("shell.html declares the page import map", () => {
  const html = readFileSync(new URL("../ui/shell.html", import.meta.url), "utf8");
  assert.deepEqual(pageImports(html), { ...PAGE_IMPORTS });
});
