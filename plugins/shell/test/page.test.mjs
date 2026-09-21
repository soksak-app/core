import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { existsSync } from "node:fs";

test("shell module is an app-DOM entry", () => {
  const source = readFileSync(new URL("../ui/shell.js", import.meta.url), "utf8");
  assert.ok(existsSync(new URL("../ui/shell.js", import.meta.url)));
  assert.match(source, /export (?:async )?function mount/);
});
