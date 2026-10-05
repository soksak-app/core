// core 창 검사 실행의 시작. node:test 의 --test-global-setup 으로 첫 검사 파일보다 먼저 한 번 실행된다.
//
// 검사할 애플리케이션 실행 파일은 이 저장소의 build 출력이다. 그 폴더는 cargo 가 정하므로(CARGO_TARGET_DIR 를 따른다)
// `cargo metadata` 의 target_directory 에서 찾아 SOKSAK_BINARY_WAILSV3 와 SOKSAK_BINARY_TAURIV2 로 선언한다. 실행이 이미
// 선언한 경로는 그대로 둔다. 선언 뒤 harness 의 시작(@soksak/window-check/session.mjs)을 실행한다.
import { spawnSync } from "node:child_process";
import { join } from "node:path";

/** cargo 가 정한 build 출력 폴더. 찾지 못하면 그 까닭으로 실패한다. */
export function targetDirectory(run = (command, args) => spawnSync(command, args, { encoding: "utf8" })) {
  const result = run("cargo", ["metadata", "--format-version", "1", "--no-deps"]);
  if (result.error) throw new Error(`cargo metadata: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`cargo metadata exited with ${result.status}: ${String(result.stderr).trim()}`);
  const directory = JSON.parse(result.stdout).target_directory;
  if (typeof directory !== "string" || !directory) throw new Error("cargo metadata reported no target_directory");
  return directory;
}

/** 이 저장소의 debug build 에서 각 앱의 번들 안 실행 파일 경로. */
export function debugBinaries(target) {
  return Object.fromEntries(["wailsv3", "tauriv2"].map((name) => [
    `SOKSAK_BINARY_${name.toUpperCase()}`,
    join(target, "debug", `soksak-${name}.app`, "Contents", "MacOS", `soksak-${name}`),
  ]));
}

export async function globalSetup() {
  const declared = debugBinaries(targetDirectory());
  for (const [variable, path] of Object.entries(declared)) process.env[variable] ??= path;
  const { globalSetup: harness } = await import("@soksak/window-check/session.mjs");
  await harness();
}
