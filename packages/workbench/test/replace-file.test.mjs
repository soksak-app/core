// 실행 파일 교체가 기존 파일을 덮어쓰지 않고 새 파일로 바꾸는지 검사한다.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { replaceFile } from "../replace-file.mjs";

test("a replaced file is a new file with the source content and mode", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "soksak-replace-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, "built");
  const target = join(dir, "staged");
  writeFileSync(source, "first", { mode: 0o755 });
  replaceFile(source, target);
  const before = statSync(target);
  writeFileSync(source, "second", { mode: 0o755 });
  replaceFile(source, target);
  const after = statSync(target);
  assert.equal(readFileSync(target, "utf8"), "second");
  assert.notEqual(after.ino, before.ino, "the staged file was overwritten in place");
  assert.equal(after.mode & 0o777, 0o755);
});
