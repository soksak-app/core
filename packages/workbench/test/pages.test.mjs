import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PAGE_IMPORTS, pageImports } from "@soksak/plugin-api";

for (const page of ["index.html", "overlay.html"]) {
  test(`${page} declares the page import map`, () => {
    const html = readFileSync(new URL(`../${page}`, import.meta.url), "utf8");
    assert.deepEqual(pageImports(html), { ...PAGE_IMPORTS });
  });
}
