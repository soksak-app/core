// 실행 중인 예제 앱에 연결해 상태를 초기화하고 입력·녹화 결과를 반환한다.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { frames, readFrame } from "./frame.mjs";
import { bounds } from "./surface.mjs";

export const APPS = {
  wailsv3: "examples/wailsv3/bin/wailsv3",
  tauriv2: "examples/tauriv2/src-tauri/target/debug/soksak-tauri",
};

const CONTROL = {
  wailsv3: 49732,
  tauriv2: 49733,
};

const OPENS = 20_000;

const reach = (port) =>
  new Promise((done) => {
    const conn = connect(port, "127.0.0.1");
    conn.once("connect", () => done(conn));
    conn.once("error", () => done(null));
  });

async function reachApp(binary, port) {
  const until = Date.now() + OPENS;
  for (;;) {
    const conn = await reach(port);
    if (conn) return conn;
    if (Date.now() > until) break;
    await new Promise((go) => setTimeout(go, 200));
  }
  throw new Error(
    `${binary} is not running, so nothing was measured. These checks drive an application ` +
      "that is already open and never open one themselves: a window that opens takes the " +
      "screen and the keyboard from whoever is using the machine. Start it once with " +
      `\`${binary} --observe\` and run them again; it answers on 127.0.0.1:${port} and ` +
      "stays open for every run after this one.",
  );
}

async function tell(binary, port, lines, done, timeout) {
  const conn = await reachApp(binary, port);
  let log = "";
  try {
    return await new Promise((resolve, reject) => {
      const fail = setTimeout(() => {
        const why = new Error(
          `${binary} did not finish ${lines.join(", ")} in ${timeout} ms:\n${log}`,
        );
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
      for (const line of lines) conn.write(`${line}\n`);
    });
  } finally {
    conn.destroy();
  }
}

const PORT = 49731;

const WAIT = 300_000;

const take = () =>
  new Promise((done, fail) => {
    const server = createServer();
    server.once("error", (why) => (why.code === "EADDRINUSE" ? done(null) : fail(why)));
    server.listen(PORT, "127.0.0.1", () => done(server));
  });

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

const portOf = (binary) =>
  CONTROL[Object.entries(APPS).find(([, at]) => at === binary)?.[0]];

export async function ask(binary, lines, done, { timeout = 30_000, from = true } = {}) {
  if (!existsSync(binary)) return null;
  if (from) await fresh(binary);
  return held(() => tell(binary, portOf(binary), [].concat(lines), done, timeout));
}

export async function nativeProbe(binary, request, from = false) {
  const log = await ask(binary, 'native ' + JSON.stringify({ ...request, ticket: "native-check" }),
    (text) => text.includes('"ticket":"native-check"'), { from });
  if (!log) return null;
  const line = log.split("\n").find((line) => line.includes('"ticket":"native-check"'));
  const reply = JSON.parse(line.slice(line.indexOf("observe: native ") + "observe: native ".length));
  if (reply.error !== null) throw new Error(reply.error);
  return reply.result;
}

async function fresh(binary) {
  const previous = await nativeProbe(binary, { op: "eval", match: "main", script: "performance.timeOrigin" });
  await held(() =>
    tell(binary, portOf(binary), ["reset"], (text) =>
      [...text.matchAll(/observe: ready ([\d.]+)/g)].some((match) => Number(match[1]) !== previous), 20_000),
  );
  // 초기 앱 문서와 테마가 준비된 뒤 실제 표시 완료를 확인한다.
  const until = Date.now() + OPENS;
  for (;;) {
    const state = await nativeProbe(binary, { op: "state" });
    const terminal = state.views.find(view => !view.hidden && view.url.includes("terminal.html"));
    if (terminal && await nativeProbe(binary, { op: "eval", match: terminal.url,
      script: `document.readyState === "complete" &&
        getComputedStyle(document.documentElement).getPropertyValue("--surface").trim() !== ""` })) break;
    if (Date.now() > until) throw new Error(`${binary}: the initial terminal document did not become ready`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  await nativeProbe(binary, { op: "presentation" });
}

async function held(work) {
  const lock = await hold();
  try {
    return await work();
  } finally {
    lock.close();
  }
}

export function budget(drive, { start = 5_000, slack = 4 } = {}) {
  const [wait, , , , , ms, times] = drive.split(",").map(Number);
  const steps = Math.max(1, Math.round(ms / 16));
  return start + (wait + times * 2 * steps * 16) * slack;
}

const MARGIN = 1.25;

export const clockHeld = (log = "") => {
  if (!/observe: shaking [xy]:/.test(log)) return false;
  const done = log.match(/observe: shaking done in (\d+)ms, asked (\d+)ms/);
  if (!done) return true;
  const took = Number(done[1]);
  const asked = Number(done[2]);
  return took > asked * MARGIN || took < asked / MARGIN;
};

export const nothingRecorded = (log = "") => /observe: wrote 0 frames/.test(log);

// 왕복 입력의 최종 좌표가 캡처에 기록될 때까지 기다린다.
async function recordedReturn(into) {
  const first = frames(into)[0];
  const initial = first && bounds(readFrame(first));
  if (!initial) throw new Error("the initial recording contains no terminal surface");
  const until = Date.now() + 10_000;
  let checked = first;
  while (Date.now() < until) {
    const last = frames(into).at(-1);
    if (last && last !== checked) {
      checked = last;
      const final = bounds(readFrame(last));
      if (final && Object.keys(initial).every((key) => Math.abs(final[key] - initial[key]) <= 1)) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("the recording did not contain the terminal's final return position within 10 seconds");
}

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

export async function shake(binary, drive, { before = [], after = [], from = true } = {}) {
  if (!existsSync(binary)) return null;
  const into = mkdtempSync(join(tmpdir(), "soksak-frames-"));
  const clean = () => rmSync(into, { recursive: true, force: true });
  const done = (text) => /observe: drag presented/.test(text) && /observe: shaking done/.test(text);
  let log = "";
  try {
    if (from) await fresh(binary);
    await held(async () => {
      try {
        log = await tell(binary, portOf(binary), [...before, `drag ${drive} ${into}`], done, budget(drive));
        await recordedReturn(into);
      } finally {
        log += await tell(binary, portOf(binary), ["stop"], (text) => /observe: wrote \d+ frames/.test(text), 10_000);
      }
    });
    if (clockHeld(log)) {
      const why = new Error(`the drag did not run at the requested rate:\n${log}`);
      why.log = log;
      throw why;
    }
  } catch (why) {
    why.log ??= log;
    why.message += `\nRecorded frames: ${into}`;
    throw why;
  } finally {
    for (const line of after) await ask(binary, line, () => true, { timeout: 5_000, from: false });
  }
  return { into, log, clean };
}
