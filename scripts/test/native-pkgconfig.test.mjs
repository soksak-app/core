// native/darwin 이 생성하는 pkg-config 파일이 작업 공간을 옮긴 뒤 다시 빌드하면 현재 위치의 절대 경로를
// 가리키고, 내용이 같으면 파일을 다시 쓰지 않는지 검사한다.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const makefile = fileURLToPath(new URL("../../native/darwin/Makefile", import.meta.url));

test("generated pkg-config file follows a relocated workspace", { timeout: 10000 }, (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "soksak-pkgconfig-")));
  t.after(() => rmSync(dir, { recursive: true }));
  const before = join(dir, "before/native/darwin");
  mkdirSync(join(before, "src"), { recursive: true });
  copyFileSync(makefile, join(before, "Makefile"));
  const generate = (dir) => execFileSync("make", ["-C", dir, join(dir, "build/soksak-darwin.pc")], { encoding: "utf8" });
  generate(before);

  renameSync(join(dir, "before"), join(dir, "after"));
  const after = join(dir, "after/native/darwin");
  const pc = join(after, "build/soksak-darwin.pc");
  generate(after);
  const written = statSync(pc).mtimeMs;
  const flags = execFileSync("pkg-config", ["--cflags", "--libs", "soksak-darwin"], {
    encoding: "utf8",
    env: { ...process.env, PKG_CONFIG_PATH: join(after, "build") },
  });
  const paths = (option) => flags.trim().split(/\s+/).filter((flag) => flag.startsWith(option)).map((flag) => flag.slice(2));
  assert.deepEqual(paths("-I"), [join(after, "src")], flags);
  assert.deepEqual(paths("-L"), [join(after, "build")], flags);
  assert.doesNotMatch(readFileSync(pc, "utf8"), /pcfiledir/);

  generate(after);
  assert.equal(statSync(pc).mtimeMs, written, "an unchanged pkg-config file was rewritten");
});
