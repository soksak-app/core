// Checks that replacing an executable file switches to a new file without overwriting the existing file.
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { replaceFile } from "../replace-file.mjs";

test("a replaced file is a new file with the source content and mode", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "soksak-replace-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, "built");
  const fixture = (name) => fileURLToPath(new URL(`fixtures/replace-file/${name}`, import.meta.url));
  const target = join(dir, "staged");
  copyFileSync(fixture("first"), source);
  replaceFile(source, target);
  const before = statSync(target);
  copyFileSync(fixture("second"), source);
  replaceFile(source, target);
  const after = statSync(target);
  assert.equal(readFileSync(target, "utf8"), "second");
  assert.notEqual(after.ino, before.ino, "the staged file was overwritten in place");
  assert.equal(after.mode & 0o777, 0o755);
});
