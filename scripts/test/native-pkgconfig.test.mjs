// native/darwin 이 생성하는 pkg-config 파일이 작업 공간을 옮긴 뒤에도 현재 위치를 가리키는지 검사한다.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const makefile = fileURLToPath(new URL("../../native/darwin/Makefile", import.meta.url));

test("generated pkg-config file follows a relocated workspace", { timeout: 10000 }, (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "soksak-pkgconfig-")));
  t.after(() => rmSync(dir, { recursive: true }));
  const before = join(dir, "before/native/darwin");
  mkdirSync(join(before, "src"), { recursive: true });
  copyFileSync(makefile, join(before, "Makefile"));
  execFileSync("make", ["-C", before, join(before, "build/soksak-darwin.pc")], { encoding: "utf8" });

  renameSync(join(dir, "before"), join(dir, "after"));
  const after = join(dir, "after/native/darwin");
  const flags = execFileSync("pkg-config", ["--cflags", "--libs", "soksak-darwin"], {
    encoding: "utf8",
    env: { ...process.env, PKG_CONFIG_PATH: join(after, "build") },
  });
  // .pc 는 자기 디렉터리에 대한 상대 경로를 쓰므로 경로를 정규화해 비교한다.
  const paths = (option) => flags.trim().split(/\s+/).filter((flag) => flag.startsWith(option)).map((flag) => resolve(flag.slice(2)));
  assert.deepEqual(paths("-I"), [join(after, "src")], flags);
  assert.deepEqual(paths("-L"), [join(after, "build")], flags);
});
