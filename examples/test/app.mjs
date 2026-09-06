// 예제 애플리케이션 하나를 실행하고 그 로그와 결과물을 반환한다.
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
 * 애플리케이션을 실행하고 done(log) 가 참이 될 때까지 기다린다.
 *
 * 기다림의 끝은 로그에 남는 사건이다. 시계로 기다리면 느린 기계에서 아직 일어나지
 * 않은 것을 검사하게 된다.
 */
export async function run(binary, args, done, { timeout = 30_000 } = {}) {
  if (!existsSync(binary)) return null;
  const app = spawn(binary, args);

  let log = "";
  const waited = new Promise((resolve, reject) => {
    const fail = setTimeout(() => reject(new Error(`${binary} did not finish:\n${log}`)), timeout);
    const read = (chunk) => {
      log += chunk;
      if (done(log)) {
        clearTimeout(fail);
        resolve();
      }
    };
    app.stdout.on("data", read);
    app.stderr.on("data", read);
    app.on("error", reject);
  });

  try {
    await waited;
  } finally {
    app.kill();
  }
  return log;
}

/**
 * 애플리케이션을 실행해 경계를 흔들고 녹화한다. 프레임 폴더와 정리 함수를 반환한다.
 *
 * drive 는 관측 부품이 받는 형식과 같다: wait,x,y,dx,dy,ms,times. zoom 은 끌기 전에
 * 창을 최대화한다.
 */
export async function shake(binary, drive, { zoom = false, ...options } = {}) {
  if (!existsSync(binary)) return null;
  const into = mkdtempSync(join(tmpdir(), "soksak-frames-"));
  const args = ["--observe", "--drive", drive, "--capture", into];
  if (zoom) args.push("--zoom");
  // 녹화 종료가 기록되면 모든 프레임이 파일로 저장된 상태다.
  const log = await run(
    binary,
    args,
    (text) => /observe: wrote \d+ frames/.test(text),
    options,
  );
  return { into, log, clean: () => rmSync(into, { recursive: true, force: true }) };
}
