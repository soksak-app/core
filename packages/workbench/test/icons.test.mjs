import assert from "node:assert/strict";
import test from "node:test";
import { icon } from "../icons.js";

test("the icons offered to plugin pages are 24-unit stroke drawings", () => {
  for (const name of ["chevron-down", "chevron-left", "chevron-right", "rotate-cw"]) {
    assert.match(icon(name), /^<svg viewBox="0 0 24 24" aria-hidden="true"><path d="[^"]+"\/>/);
  }
  assert.throws(() => icon("missing"), /unknown icon: missing/);
});
