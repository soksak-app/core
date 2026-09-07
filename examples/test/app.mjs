// 예제 애플리케이션 하나를 실행하고 그 로그와 결과물을 반환한다.
//
// 순서는 관측 부품이 수행한다. 창이 표시되고, 페이지 렌더링을 기다리고, 경계를
// 흔들고, 그동안 녹화하고, 종료한다.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 저장소 뿌리에서 본 각 앱의 실행 파일. */
export const APPS = {
  wailsv3: "examples/wailsv3/bin/wailsv3",
  tauriv2: "examples/tauriv2/src-tauri/target/debug/soksak-tauri",
};

/**
 * 각 애플리케이션이 지시를 받는 포트. 관측 부품이 같은 숫자를 적는다.
 *
 * 애플리케이션은 검사보다 오래 산다. 검사는 떠 있는 것에 지시를 보내고, 떠 있지
 * 않으면 한 번 띄운다. 새 창은 사람이 보고 있는 화면 앞에 놓이므로, 창이 뜨는
 * 횟수를 검사 횟수에서 떼어 놓는다.
 */
const CONTROL = {
  wailsv3: 49732,
  tauriv2: 49733,
};

/** 띄운 애플리케이션이 통로를 열 때까지 기다리는 한도. */
const OPENS = 30_000;

/** 통로에 한 번 붙어 본다. 붙었으면 연결, 아니면 null. */
const reach = (port) =>
  new Promise((done) => {
    const conn = connect(port, "127.0.0.1");
    conn.once("connect", () => done(conn));
    conn.once("error", () => done(null));
  });

/**
 * 이 애플리케이션의 통로에 붙는다. 떠 있지 않으면 한 번 띄우고 기다린다.
 *
 * 띄운 것은 이 프로세스와 함께 죽지 않는다. 다음 검사가 같은 창에 지시를 보내므로,
 * 창은 한 번만 뜬다.
 */
async function reachApp(binary, port) {
  const first = await reach(port);
  if (first) return first;
  spawn(binary, ["--observe"], { detached: true, stdio: "ignore" }).unref();
  const until = Date.now() + OPENS;
  for (;;) {
    const conn = await reach(port);
    if (conn) return conn;
    if (Date.now() > until) {
      throw new Error(
        `${binary} did not open 127.0.0.1:${port} in ${OPENS} ms. Nothing was measured: ` +
          "the application was started and never answered.",
      );
    }
    await new Promise((go) => setTimeout(go, 200));
  }
}

/**
 * 떠 있는 애플리케이션에 지시 한 줄을 보내고 done(log) 가 참이 될 때까지 읽는다.
 *
 * 돌아오는 것은 그 애플리케이션의 로그다. 붙은 뒤의 줄만 오므로, 이 지시가 남긴
 * 것만 읽는다.
 */
async function tell(binary, port, line, done, timeout) {
  const conn = await reachApp(binary, port);
  let log = "";
  try {
    return await new Promise((resolve, reject) => {
      const fail = setTimeout(() => {
        const why = new Error(`${binary} did not finish ${line} in ${timeout} ms:\n${log}`);
        why.log = log;
        reject(why);
      }, timeout);
      conn.on("data", (chunk) => {
        log += chunk;
        if (!done(log)) return;
        clearTimeout(fail);
        resolve(log);
      });
      conn.on("error", (why) => {
        clearTimeout(fail);
        why.log = log;
        reject(why);
      });
      conn.on("close", () => {
        if (done(log)) return;
        clearTimeout(fail);
        const why = new Error(`${binary} closed the control port before it finished:\n${log}`);
        why.log = log;
        why.exited = true;
        reject(why);
      });
      conn.write(`${line}\n`);
    });
  } finally {
    conn.destroy();
  }
}

/**
 * 창을 모는 실행이 서는 자물쇠.
 *
 * 이 폴더에는 검사 파일이 셋이고 러너는 파일을 병렬로 실행한다. 그대로 두면 세
 * 애플리케이션이 동시에 창을 띄우고 경계를 흔들며, 각 실행은 남의 창이 섞인
 * 화면을 녹화해 자기 것으로 잰다. Makefile 의 --test-concurrency=1 은 이 폴더를
 * 직접 실행하면 없으므로, 자물쇠는 실행 방법과 무관한 자리인 여기에 둔다.
 *
 * 자물쇠는 파일이 아니라 열린 포트다. 파일 자물쇠는 주인이 죽으면 남고, 남은 것을
 * 걷어내는 데에 경쟁이 있다: 두 대기자가 같은 자물쇠를 함께 죽었다고 읽으면, 하나가
 * 새로 건 자물쇠를 다른 하나가 지우고 자기 것을 걸어 둘 다 잡았다고 여긴다. 포트는
 * 주인이 죽으면 커널이 거두므로 남지 않고, 걷어낼 일이 없으므로 그 경쟁도 없다.
 */
const PORT = 49731;

/** 자물쇠를 기다리는 한도. 이만큼이면 앞의 실행이 끝나지 않은 것이다. */
const WAIT = 300_000;

/** 포트를 한 번 잡아 본다. 잡았으면 서버, 이미 누가 쥐고 있으면 null. */
const take = () =>
  new Promise((done, fail) => {
    const server = createServer();
    server.once("error", (why) => (why.code === "EADDRINUSE" ? done(null) : fail(why)));
    server.listen(PORT, "127.0.0.1", () => done(server));
  });

/**
 * 자물쇠를 잡는다. 반환한 것을 닫으면 놓는다.
 *
 * 한도까지 잡지 못하면 실패한다. 그 실행은 결함을 찾은 것이 아니라 아무것도 재지
 * 못한 것이므로, 무엇이 없었는지가 아니라 왜 재지 못했는지를 말한다.
 */
async function hold() {
  const until = Date.now() + WAIT;
  for (;;) {
    const lock = await take();
    if (lock) return lock;
    if (Date.now() > until) {
      throw new Error(
        `nothing held the window lock free for ${WAIT} ms: 127.0.0.1:${PORT} stayed taken. ` +
          "Nothing was measured. Either a second copy of these tests is running, or an " +
          "unrelated program holds that port.",
      );
    }
    await new Promise((go) => setTimeout(go, 200));
  }
}

/**
 * 애플리케이션을 실행하고 done(log) 가 참이 될 때까지 기다린다.
 *
 * 기다림의 끝은 로그에 남는 사건이다. 시계로 기다리면 느린 기계에서 아직 일어나지
 * 않은 것을 검사하게 된다.
 */
export async function run(binary, args, done, { timeout = 30_000 } = {}) {
  if (!existsSync(binary)) return null;
  const lock = await hold();
  try {
    return await drive(binary, args, done, timeout);
  } finally {
    lock.close();
  }
}

/** 자물쇠를 쥔 채 애플리케이션 하나를 몬다. */
async function drive(binary, args, done, timeout) {
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
    await end(app);
  }
  return log;
}

/**
 * 자물쇠를 쥔 채 하나를 수행한다.
 *
 * 창을 모는 일은 한 번에 하나여야 한다. 애플리케이션을 띄우는 실행과 떠 있는
 * 것에 지시를 보내는 실행이 같은 자물쇠를 쓴다.
 */
async function held(work) {
  const lock = await hold();
  try {
    return await work();
  } finally {
    lock.close();
  }
}

/** 신호에 응하지 않는 애플리케이션을 거두기까지 기다리는 한도. */
const HARD = 5_000;

/**
 * 애플리케이션을 끝내고 사라질 때까지 기다린다.
 *
 * kill() 은 신호를 보내고 곧바로 돌아온다. 기다리지 않고 자물쇠를 놓으면 다음
 * 실행이 앞의 애플리케이션이 아직 살아 있는 동안 자기 창을 띄우고 녹화를
 * 시작한다. 같은 종류의 녹화가 둘이면 플랫폼이 먼저 것을 거두므로 그 실행은 한
 * 장도 받지 못하고, nothingRecorded 는 그 원인을 이 검사 밖에서 찾으라고 말한다.
 *
 * 신호에 응하지 않는 애플리케이션은 HARD 뒤에 SIGKILL 로 거둔다.
 */
function end(app) {
  if (app.pid === undefined || app.exitCode !== null || app.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((gone) => {
    const hard = setTimeout(() => {
      try {
        app.kill("SIGKILL");
      } catch {
        // 이미 사라졌다.
      }
    }, HARD);
    app.once("close", () => {
      clearTimeout(hard);
      gone();
    });
    app.kill();
  });
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
 * 끌기가 요청한 속도로 수행되지 않았는지.
 *
 * 걸음의 시각은 호스트가 준다. 호스트의 시계는 창이 어디에 있든 늦춰지지 않으므로,
 * 요청한 만큼 걸리는 것이 정상이고 두 호스트에서 1440ms 요청에 1441ms 와 1444ms 로
 * 측정된다. 그보다 크게 벗어났다면 걸음이 제때 전달되지 않은 것이다.
 *
 * 그때 이 실행은 결함을 찾은 것이 아니라 아무것도 재지 못한 것이다. 사람이 끄는
 * 속도에서만 드러나는 어긋남은 느린 끌기에서 드러나지 않으므로, 느린 끌기의 통과는
 * 통과가 아니다.
 */
const MARGIN = 1.25;

export const clockHeld = (log = "") => {
  if (!/observe: shaking [xy]:/.test(log)) return false;
  const done = log.match(/observe: shaking done in (\d+)ms, asked (\d+)ms/);
  if (!done) return true;
  return Number(done[1]) > Number(done[2]) * MARGIN;
};

/**
 * 녹화가 한 장도 오지 않았는지. 창이 그려지지 않아도 프레임은 idle 로 오고 그 수는
 * 따로 보고되므로, 한 장도 없다는 것은 스트림이 없었다는 뜻이지 결함이 아니다.
 *
 * 같은 종류의 녹화가 둘이면 플랫폼이 먼저 것을 거둔다. 시계가 묶인 실행과 같은
 * 부류다 — 그 실행은 아무것도 재지 못한 것이다.
 *
 * 그 둘째 녹화는 이 검사의 다른 실행이 아니다. 창을 몰기 전에 자물쇠를 잡으므로
 * run() 을 거치는 실행은 한 번에 하나다. 남는 것은 이 검사 밖에서 시작된 녹화다.
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
    console.error(`  the drag ran slower than asked; shaking ${drive} again`);
  }
  try {
    return await shake(binary, drive, options);
  } catch (why) {
    if (why.exited || !clockHeld(why.log)) throw why;
    throw new Error(
      "the drag ran slower than it was asked to, twice. The steps come from the host, whose " +
        "clock is not held wherever the window is, so this is not the window being behind " +
        "another one. Nothing was measured: an unrendered area shows itself at the speed a " +
        `person drags at, and a slow drag passing is not a pass.\n${why.log}`,
    );
  }
}

export async function shake(binary, drive, { zoom = false, ...options } = {}) {
  if (!existsSync(binary)) return null;
  const into = mkdtempSync(join(tmpdir(), "soksak-frames-"));
  const clean = () => rmSync(into, { recursive: true, force: true });
  // 녹화 종료가 기록되면 모든 프레임이 파일로 저장된 상태다.
  const done = (text) => /observe: wrote \d+ frames/.test(text);
  const timeout = budget(drive);
  const name = Object.entries(APPS).find(([, at]) => at === binary)?.[0];
  let log;
  try {
    log = zoom
      ? // --zoom 은 창을 최대화한 채로 시작해야 하므로 실행 인자다. 그 검사는
        // 자기 애플리케이션을 띄운다.
        await run(binary, ["--observe", "--zoom", "--drive", drive, "--capture", into], done, {
          timeout,
          ...options,
        })
      : await held(() => tell(binary, CONTROL[name], `drag ${drive} ${into}`, done, timeout));
  } catch (why) {
    // 끝나지 못한 실행도 그때까지의 프레임을 적어 두었다. 부르는 쪽은 반환값을
    // 받지 못하므로 그것을 지울 수단이 없다.
    clean();
    throw why;
  }
  return { into, log, clean };
}
