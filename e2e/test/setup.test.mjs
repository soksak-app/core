// core 창 검사는 cargo 가 정한 build 출력 폴더에서 앱 실행 파일을 찾아 harness 에 선언한다(F25.1).
import assert from "node:assert/strict";
import test from "node:test";
import { debugBinaries, targetDirectory } from "../setup.mjs";

test("the target directory is the one cargo metadata reports", () => {
  const calls = [];
  const directory = targetDirectory((command, args) => {
    calls.push([command, ...args]);
    return { status: 0, stdout: JSON.stringify({ target_directory: "/work/target" }), stderr: "" };
  });
  assert.equal(directory, "/work/target");
  assert.deepEqual(calls, [["cargo", "metadata", "--format-version", "1", "--no-deps"]]);
});

test("a failed cargo metadata names its exit and output", () => {
  assert.throws(() => targetDirectory(() => ({ status: 101, stdout: "", stderr: "could not find Cargo.toml\n" })),
    /^Error: cargo metadata exited with 101: could not find Cargo.toml$/);
});

test("each application's executable is the one inside its debug bundle", () => {
  assert.deepEqual(debugBinaries("/work/target"), {
    SOKSAK_BINARY_WAILSV3: "/work/target/debug/soksak-wailsv3.app/Contents/MacOS/soksak-wailsv3",
    SOKSAK_BINARY_TAURIV2: "/work/target/debug/soksak-tauriv2.app/Contents/MacOS/soksak-tauriv2",
  });
});
