// 예제 애플리케이션 하나를 실행하고 기록된 프레임의 경로를 반환한다.
//
// 순서는 관측 부품이 수행한다. 창이 표시되고, 페이지 렌더링을 기다리고, 경계를
// 흔들고, 그동안 녹화하고, 종료한다.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 저장소 뿌리에서 본 각 앱의 실행 파일. */
export const APPS = {
  wailsv3: "examples/wailsv3/bin/wailsv3",
  tauriv2: "examples/tauriv2/src-tauri/target/debug/soksak-tauri",
};

/**
 * 애플리케이션을 실행해 경계를 흔들고 녹화한다. 프레임 폴더와 정리 함수를 반환한다.
 *
 * drive 는 관측 부품이 받는 형식과 같다: wait,x,y,dx,dy,ms,times.
 */
export async function shake(binary, drive, { timeout = 30_000 } = {}) {
  if (!existsSync(binary)) return null;
  const into = mkdtempSync(join(tmpdir(), "soksak-frames-"));
  const app = spawn(binary, ["--observe", "--drive", drive, "--capture", into]);

  let log = "";
  const done = new Promise((resolve, reject) => {
    const fail = setTimeout(() => reject(new Error(`${binary} 가 끝나지 않았다:\n${log}`)), timeout);
    const read = (chunk) => {
      log += chunk;
      // 녹화 종료가 기록되면 모든 프레임이 파일로 저장된 상태다.
      if (/프레임을 .* 적었다/.test(log)) {
        clearTimeout(fail);
        resolve();
      }
    };
    app.stdout.on("data", read);
    app.stderr.on("data", read);
    app.on("error", reject);
  });

  try {
    await done;
  } finally {
    app.kill();
  }
  return { into, log, clean: () => rmSync(into, { recursive: true, force: true }) };
}
