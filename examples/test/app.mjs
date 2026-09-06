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
    const fail = setTimeout(() => {
      // 로그를 오류에 실어 보낸다. 예산이 끝난 이유는 로그의 마지막 줄에 있고,
      // 문자열로만 넘기면 부르는 쪽이 그것을 다시 읽어야 한다.
      const why = new Error(`${binary} did not finish in ${timeout} ms:\n${log}`);
      why.log = log;
      reject(why);
    }, timeout);
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
    app.on("close", (code, signal) => {
      if (done(log)) return;
      clearTimeout(fail);
      const why = new Error(`${binary} exited with ${signal ?? code} before it finished:\n${log}`);
      why.log = log;
      why.exited = true;
      reject(why);
    });
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
/**
 * 이 끌기가 요구하는 시계.
 *
 * `wait` 뒤에 `times` 왕복이 오고, 한 왕복은 두 번의 쓸기, 한 걸음은 화면 갱신
 * 간격이다. 고정된 숫자를 두면 더 긴 끌기가 소리 없이 그 안에 들어앉는다.
 */
export function budget(drive, { start = 5_000, slack = 4 } = {}) {
  const [wait, , , , , ms, times] = drive.split(",").map(Number);
  const steps = Math.max(1, Math.round(ms / 16));
  return start + (wait + times * 2 * steps * 16) * slack;
}

/**
 * 끌기가 시작되고 끝나지 않았는지. 페이지의 시계가 묶였다는 뜻이다.
 *
 * observe.js 의 쓸기는 조건이 아니라 시계로 도는 고리이므로, 시작한 끌기는 언제나
 * 끝난다. 끝나지 않았다면 그 시계가 돌지 않은 것이고, 그때 이 실행은 아무것도
 * 재지 못한 것이지 결함을 찾은 것이 아니다.
 */
export const clockHeld = (log = "") =>
  /observe: shaking [xy]:/.test(log) && !/observe: shaking done/.test(log);

/**
 * 녹화가 한 장도 오지 않았는지. 창이 그려지지 않아도 프레임은 idle 로 오고 그 수는
 * 따로 보고되므로, 한 장도 없다는 것은 스트림이 없었다는 뜻이지 결함이 아니다.
 *
 * 같은 종류의 녹화가 둘이면 플랫폼이 먼저 것을 거둔다. 시계가 묶인 실행과 같은
 * 부류다 — 그 실행은 아무것도 재지 못한 것이다.
 */
export const nothingRecorded = (log = "") => /observe: wrote 0 frames/.test(log);

/**
 * 끌기를 한 번 다시 시도한다. 시계가 묶인 실행은 결함을 찾은 것이 아니라 아무것도
 * 재지 못한 것이므로, 그것만 다시 몰고 그 밖의 실패는 그대로 올린다.
 */
export async function shakeTwice(binary, drive, options) {
  try {
    return await shake(binary, drive, options);
  } catch (why) {
    if (why.exited || !clockHeld(why.log)) throw why;
    console.error(`  the page's clock was held; shaking ${drive} again`);
  }
  try {
    return await shake(binary, drive, options);
  } catch (why) {
    if (why.exited || !clockHeld(why.log)) throw why;
    throw new Error(
      "the page's clock was held to a crawl twice: a step of 16 ms took about 900 ms, so " +
        "the drag cannot finish inside any budget. Nothing was measured — run this on a " +
        `machine that is not otherwise busy.\n${why.log}`,
    );
  }
}

export async function shake(binary, drive, { zoom = false, ...options } = {}) {
  if (!existsSync(binary)) return null;
  const into = mkdtempSync(join(tmpdir(), "soksak-frames-"));
  const args = ["--observe", "--drive", drive, "--capture", into];
  if (zoom) args.push("--zoom");
  const clean = () => rmSync(into, { recursive: true, force: true });
  let log;
  try {
    // 녹화 종료가 기록되면 모든 프레임이 파일로 저장된 상태다.
    log = await run(
      binary,
      args,
      (text) => /observe: wrote \d+ frames/.test(text),
      { timeout: budget(drive), ...options },
    );
  } catch (why) {
    // 끝나지 못한 실행도 그때까지의 프레임을 적어 두었다. 부르는 쪽은 반환값을
    // 받지 못하므로 그것을 지울 수단이 없다.
    clean();
    throw why;
  }
  return { into, log, clean };
}
