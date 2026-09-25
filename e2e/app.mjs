// 실행 중인 예제 앱의 로컬 엔드포인트에 연결해 상태를 준비하고 끌기를 기록한다.
//
// 검사는 앱을 실행하지 않는다. 앱은 `--config-dir <tmpdir>/soksak-check-<app>` 로 실행되어
// 있어야 하고, 하네스는 그 폴더의 endpoint.json 으로 연결한다. 명세는 docs/spec/endpoint.md 와
// docs/spec/exposure.md 에 있다.
import { closeSync, existsSync, openSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, EndpointError } from "@soksak/client";
import { activateApp, frontmostApp } from "./frontmost.mjs";
import { readPasteboard, writePasteboard } from "./pasteboard.mjs";

// 검사하는 애플리케이션 실행 파일. 작업 디렉터리와 무관하게 이 파일 위치를 기준으로 찾는다.
const built = (name) => fileURLToPath(new URL(`../target/debug/${name}`, import.meta.url));

/** 검사 대상 앱. 실행 파일과 설정 폴더. */
const appNames = process.env.SOKSAK_APP ? [process.env.SOKSAK_APP] : ["wailsv3", "tauriv2"];
if (!appNames.every((name) => ["wailsv3", "tauriv2"].includes(name))) {
  throw new Error(`unknown SOKSAK_APP: ${process.env.SOKSAK_APP}`);
}

export const APPS = Object.fromEntries(appNames.map((name) => [name, {
  name,
  binary: built(`soksak-${name}`),
  configDir: join(tmpdir(), `soksak-check-${name}`),
}]));

/** 실행 중인 엔드포인트가 현재 빌드보다 오래되지 않았는지 검증한다. */
export function assertEndpointUsesCurrentBuild(endpoint, resolvedBinary, binaryMtimeMs) {
  if (endpoint.executable !== resolvedBinary) {
    throw new Error(`process ${endpoint.pid} runs ${endpoint.executable}, not ${resolvedBinary}; restart the application from this checkout`);
  }
  const startedMs = Date.parse(endpoint.started);
  if (!Number.isFinite(startedMs)) {
    throw new Error(`process ${endpoint.pid} has invalid endpoint start time ${endpoint.started}`);
  }
  if (!Number.isFinite(binaryMtimeMs)) {
    throw new Error(`current build has invalid modification time ${binaryMtimeMs}`);
  }
  if (binaryMtimeMs > startedMs + 1000) {
    throw new Error(
      `process ${endpoint.pid} started at ${endpoint.started} before the current build ` +
      `mtime ${new Date(binaryMtimeMs).toISOString()}; restart the application from this checkout`,
    );
  }
}

/** 한 요청의 기본 대기 시간. 호스트의 문서 응답 시간보다 길다. */
const REQUEST = 20_000;

/**
 * 검사 파일 사이의 순차 실행 잠금. 두 번째 검사 실행은 기다리지 않고 실패한다. 잠금 파일에는
 * 소유 프로세스 번호를 적고, 그 프로세스가 없으면 남은 잠금으로 보고 교체한다.
 */
const LOCK = join(tmpdir(), "soksak-check.lock");

function running(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

let locked = false;
const sessionTails = new Map();

/** 같은 앱 창을 조작하는 Node 테스트의 중복 세션을 즉시 거부한다. */
export async function acquireWindowCheckSlot(appName) {
  if (sessionTails.has(appName)) {
    throw new Error(
      `an application window check is already active for ${appName}; ` +
      "run the e2e package with its declared --test-concurrency=1 entry point",
    );
  }
  const current = {};
  sessionTails.set(appName, current);
  let released = false;
  return () => {
    if (released) throw new Error(`window check slot for ${appName} was released twice`);
    released = true;
    if (sessionTails.get(appName) === current) sessionTails.delete(appName);
  };
}

function lock() {
  if (locked) return;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(LOCK, "wx");
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      locked = true;
      process.once("exit", () => {
        try {
          if (readFileSync(LOCK, "utf8") === String(process.pid)) unlinkSync(LOCK);
        } catch {
          // 다른 실행이 이미 교체했다.
        }
      });
      return;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const owner = Number(readFileSync(LOCK, "utf8"));
      if (owner === process.pid) {
        locked = true;
        return;
      }
      if (Number.isInteger(owner) && owner > 0 && running(owner)) {
        throw new Error(`window checks are already running in process ${owner} (${LOCK}); nothing was measured`);
      }
      unlinkSync(LOCK);
    }
  }
  throw new Error(`could not take the window check lock ${LOCK}`);
}

/**
 * 앱 하나에 연결한다. 실행 파일이 없으면 null 을 반환하고 검사는 건너뛴다. 연결은 검사가
 * 끝나면 닫힌다.
 *
 * endpoint.json 의 프로세스가 이 저장소의 실행 파일인지 확인한다. 다른 체크아웃이나 이전
 * 빌드의 앱을 검사하지 않기 위해서다.
 */
export async function open(t, app) {
  if (!existsSync(app.binary)) return null;
  lock();
  const releaseSlot = await acquireWindowCheckSlot(app.name);
  let client;
  try {
    client = await connect({ configDir: app.configDir });
  } catch (error) {
    releaseSlot();
    throw new Error(
      `${app.name} is not running, so nothing was measured (${error.message}). These checks drive an ` +
        "application that is already open and never open one themselves: a window that opens takes " +
        `the screen and the keyboard from whoever is using the machine. Start it once with ` +
        `\`${app.binary} --config-dir "${app.configDir}"\` and run them again.`,
    );
  }
  const session = new Session(app, client);
  // 검사는 사용자의 페이스트보드를 쓸 수 있다. 모든 항목 형식을 저장하고, 다른 정리가 모두 끝난 뒤 되돌려
  // 확인한다. 정리는 등록의 역순으로 실행하므로 이 정리가 마지막이다.
  const pasteboard = readPasteboard();
  // 전체 화면 전환이나 새 프로젝트 창은 애플리케이션을 활성화한다. 검사가 활성화했으면 끝날 때 앞서 활성이던
  // 애플리케이션을 되돌린다. 다음 검사의 합성 끌기는 비활성 애플리케이션을 전제한다.
  const previous = frontmostApp();
  if (previous !== null && previous !== client.endpoint.pid) {
    session.cleanup(async () => {
      if (frontmostApp() !== client.endpoint.pid) return;
      activateApp(previous);
      await session.until("host.window", (w) => w.active === false, "the application stayed active after the check");
    });
  }
  session.cleanup(() => {
    writePasteboard(pasteboard.items);
    const after = readPasteboard().items;
    if (JSON.stringify(after) !== JSON.stringify(pasteboard.items)) {
      throw new Error(`${app.name}: the pasteboard after the check differs from before it: ` +
        `${after.map((item) => Object.keys(item).join("+")).join(", ")} instead of ` +
        `${pasteboard.items.map((item) => Object.keys(item).join("+")).join(", ")}`);
    }
  });
  // 검사의 정리는 연결을 닫기 전에 실행한다. node:test 는 after 훅을 등록 순서로 실행한다.
  // 정리 하나가 실패해도(앱이 응답하지 않는 경우 등) 나머지 정리는 실행하고, 실패는 모아서 알린다.
  t.after(async () => {
    const failures = [];
    try {
      for (const clean of session.cleanups.reverse()) {
        try {
          await clean();
        } catch (error) {
          failures.push(error);
        }
      }
    } finally {
      client.close();
      releaseSlot();
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, `${failures.length} cleanup steps failed`);
  });
  const { endpoint } = client;
  if (endpoint.application !== app.name) {
    throw new Error(`${app.configDir}/endpoint.json belongs to ${endpoint.application}, not ${app.name}`);
  }
  assertEndpointUsesCurrentBuild(endpoint, realpathSync(app.binary), statSync(app.binary).mtimeMs);
  return session;
}

/** 한 앱과의 연결. 요청은 창 하나를 대상으로 한다. */
export class Session {
  constructor(app, client) {
    this.app = app;
    this.client = client;
    this.window = "main";
    this.cleanups = [];
  }

  /** 연결을 닫기 전에 실행할 정리. 등록의 역순으로 실행한다. */
  cleanup(fn) {
    this.cleanups.push(fn);
  }

  /**
   * 이 창을 일반 닫기 동작으로 닫는다. 닫히는 창의 문서가 요청에 답하기 전에 사라지면 1003 이며,
   * 그것도 닫힌 것이다.
   */
  async close() {
    const code = await failure(this.run("host.window.close"));
    if (code !== null && code !== 1003) throw new Error(`${this.app.name}: closing ${this.window} failed with ${code}`);
  }

  /** 다른 창을 대상으로 하는 세션. 같은 연결을 쓴다. */
  on(window) {
    const other = new Session(this.app, this.client);
    other.cleanups = this.cleanups;
    other.window = window;
    return other;
  }

  request(method, params = {}, { timeout = REQUEST } = {}) {
    const what = `${this.app.name} ${method} ${params.name ?? ""}`.trimEnd();
    // 실패한 요청의 이름을 오류에 남긴다. code 는 그대로 둔다.
    const answer = this.client.request(method, { window: this.window, ...params }).catch((error) => {
      if (error instanceof EndpointError) error.message = `${what}: ${error.message}`;
      throw error;
    });
    return within(answer, timeout, what);
  }

  get(name, surface) {
    return this.request("status.get", surface === undefined ? { name } : { name, surface });
  }

  run(name, params = {}, surface, options = {}) {
    return this.request("command.run", surface === undefined ? { name, params } : { name, params, surface }, options);
  }

  rect(name, index, surface) {
    return this.request("dom.rect", compact({ name, index, surface }));
  }

  act(name, action, { index, value, event, surface } = {}) {
    return this.request("dom.act", compact({ name, action, index, value, event, surface }));
  }

  pointer(x, y, phase, options = {}) {
    return this.request("input.pointer", { x, y, phase, ...options });
  }

  key(key, phase, options = {}) {
    return this.request("input.key", { key, phase, ...options });
  }

  /** 누르고 떼는 네이티브 클릭. */
  async click(x, y) {
    await this.pointer(x, y, "down");
    await this.pointer(x, y, "up");
  }

  /**
   * 활성화 등급 검사에서 시스템 포인터가 창 밖에 있도록 창을 포인터의 왼쪽이나 오른쪽으로 옮긴다. 활성
   * 애플리케이션의 키 창은 포인터 위치를 이동으로 받으므로, 창 안의 포인터는 합성 누름과 뗌 사이에 이동으로
   * 끼어든다. 창이 어느 쪽에도 들어가지 않으면 창 폭을 넓은 쪽에 맞게 줄인다.
   */
  async keepPointerOutside() {
    const window = await this.get("host.window");
    const { pointer } = window;
    const inside = (rect) => pointer.x >= rect.x && pointer.x < rect.x + rect.width &&
      pointer.y >= rect.y && pointer.y < rect.y + rect.height;
    if (!inside(window.frame)) return;
    const screen = (await this.get("host.screens")).find((item) => inside(item));
    if (!screen) throw new Error(`${this.app.name}: the pointer ${JSON.stringify(pointer)} is on no screen`);
    const area = screen.visible;
    const left = Math.floor(pointer.x - area.x);
    const right = Math.floor(area.x + area.width - pointer.x) - 1;
    const width = Math.min(window.frame.width, Math.max(left, right));
    if (width < window.frame.width) {
      await this.run("host.window.resize", { width, height: window.content.height });
      await this.until("host.window", (value) => value.frame.width === width,
        `the window did not narrow to ${width} points beside the pointer`);
    }
    const frame = (await this.get("host.window")).frame;
    const x = left >= frame.width ? area.x : area.x + area.width - frame.width;
    await this.run("host.window.move", { x, y: frame.y });
    await this.until("host.window", (value) => value.frame.x === x && !(value.pointer.x >= value.frame.x &&
      value.pointer.x < value.frame.x + value.frame.width && value.pointer.y >= value.frame.y &&
      value.pointer.y < value.frame.y + value.frame.height), "the window did not move away from the pointer");
  }

  /**
   * 키보드 입력 소스를 고르고 검사가 끝나면 이전 입력 소스로 되돌린다. 네이티브 키의 문자는 현재 입력
   * 소스가 정하므로, 영문을 입력하는 검사는 영문 자판을 먼저 고른다. 입력 소스 선택은 창을 활성화하지 않는다.
   */
  async selectInputSource(id) {
    const original = (await this.request("diagnostics.input.source")).current;
    this.cleanup(() => this.request("diagnostics.input.source", { select: original }));
    const selected = await this.request("diagnostics.input.source", { select: id });
    if (selected.current !== id) throw new Error(`${this.app.name}: input source ${id} was not selected (current ${selected.current})`);
  }

  /** 누르고 떼는 네이티브 키. */
  async press(key, options = {}) {
    await this.key(key, "down", options);
    await this.key(key, "up", options);
  }

  /** status 가 predicate 를 만족할 때까지 알림으로 기다린다. */
  until(name, predicate, message, { surface, timeout = REQUEST } = {}) {
    return this.client.watch(this.window, name, predicate, { surface, timeout }).catch((error) => {
      if (error.code === "ETIMEDOUT") error.message = `${this.app.name}: ${message} (${error.message})`;
      throw error;
    });
  }

  /**
   * status 의 모든 변경을 모은다. 감시를 시작할 때의 값도 포함한다. stop() 은 감시를 끝내고
   * 모은 값을 반환한다.
   */
  async collect(name) {
    const values = [];
    const off = this.client.on("status.changed", (params) => {
      if (params?.window === this.window && params?.name === name && params?.surface === undefined) {
        values.push(params.value);
      }
    });
    await this.request("status.watch", { name });
    values.push(await this.get(name));
    return {
      values,
      stop: async () => {
        await this.request("status.unwatch", { name });
        off();
        return values;
      },
    };
  }

  /** 메인 페이지와 보이는 앱 문서가 현재 배치를 표시할 때까지 기다린다. 결과는 그 화면의 표시 시각 { displayed } 다. */
  presented() {
    return this.run("host.window.presented");
  }

  /** host.windows 에서 창 수가 count 이고 모든 창의 페이지가 준비될 때까지 기다린다. */
  windows(count, message) {
    return this.until("host.windows", (list) => list.length === count && list.every((w) => w.ready), message);
  }

  /** 보이는 표면. plugin 이 주어지면 그 플러그인의 표면만. core.surfaces 의 항목이다. */
  async surfaces(plugin) {
    const all = await this.get("core.surfaces");
    return all.filter((surface) => surface.visible && (plugin === undefined || surface.plugin === plugin));
  }

  /** 페이지가 보고하는 전사 줄을 모은다. stop() 은 전사를 끄고 모은 줄을 반환한다. */
  async transcript() {
    const lines = [];
    const off = this.client.on("diagnostics.log", (params) => {
      if (params?.window === this.window) lines.push(params.line);
    });
    await this.request("diagnostics.transcript", { on: true });
    return {
      lines,
      /** 줄이 predicate 를 만족할 때까지 기다린다. */
      until: (predicate, message, timeout = REQUEST) => new Promise((resolve, reject) => {
        const check = () => {
          if (predicate(lines)) {
            clearTimeout(timer);
            offCheck();
            resolve(lines);
          }
        };
        const offCheck = this.client.on("diagnostics.log", () => queueMicrotask(check));
        const timer = setTimeout(() => {
          offCheck();
          reject(new Error(`${this.app.name}: ${message} within ${timeout} ms:\n${lines.join("\n")}`));
        }, timeout);
        check();
      }),
      stop: async () => {
        off();
        await this.request("diagnostics.transcript", { on: false });
        return lines;
      },
    };
  }
}

function compact(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

export function within(promise, ms, what) {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not answer within ${ms} ms`)), ms);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

/** 요청이 실패하면 EndpointError 의 code 를 반환하고, 성공하면 null 을 반환한다. */
export async function failure(promise) {
  try {
    await promise;
    return null;
  } catch (error) {
    if (error instanceof EndpointError) return error.code;
    throw error;
  }
}

/** 두 호스트가 새 창에 쓰는 콘텐츠 크기. 검사는 이 크기에서 시작한다. */
const START = { width: 1200, height: 760 };

/**
 * 창을 검사 시작 상태로 만든다. 다른 창을 닫고, 창 크기를 시작 크기로 되돌리고, 테스트 프로젝트를 새 배치로 열고 메인 문서를 다시 읽은 뒤,
 * 첫 셸 문서가 테마를 적용할 때까지 기다리고 표시 완료를 확인한다.
 */

/** 창 검사 터미널의 셸. 로그인 셸의 프로필에 따라 달라지는 프롬프트를 피한다. */
const CHECK_SHELL = fileURLToPath(new URL("./check-shell", import.meta.url));
export async function fresh(s) {
  for (const window of await s.get("host.windows")) {
    if (window.window !== s.window) await s.on(window.window).close();
  }
  await s.windows(1, "extra windows did not close");
  await s.run("host.window.maximize", { on: false });
  await s.run("host.window.resize", START);
  await s.until("host.window", (w) => w.content.width === START.width && w.content.height === START.height,
    "the window did not return to its start size");
  // 픽스처 교체 중의 표시 실패를 다음 문서의 정상 상태로 덮어 통과시키지 않는다.
  const verification = await s.collect("core.verify");
  const presentationErrors = [];
  const offErrors = s.client.on("diagnostics.log", (params) => {
    if (params?.window === s.window && /^host (syncSurfaces|presentSurfaces) failed:/.test(params.line)) {
      presentationErrors.push(params.line);
    }
  });
  const initial = verification.values.length;
  let records;
  try {
    // 창 검사의 터미널은 사용자의 로그인 셸과 무관하게 검사용 셸(check-shell)로 시작한다.
    await s.request("diagnostics.fixture", { settings: { "terminal.shell": CHECK_SHELL } });
    await s.presented();
    if (presentationErrors.length) {
      throw new Error(`test preparation reported presentation errors before reload: ${JSON.stringify(presentationErrors)}; ` +
        `native state: ${JSON.stringify(await s.get("host.window"))}`);
    }
    const before = (await s.get("core.window.document")).timeOrigin;
    await s.run("host.window.reload");
    await s.until("core.window.document", (doc) => doc.timeOrigin !== before && doc.readyState === "complete",
      "the main document did not reload");
  } finally {
    offErrors();
    records = await verification.stop();
  }
  const failed = records.slice(initial).flatMap((value) => value?.rows ?? [])
    .filter((row) => row.name === "Surface presentation" && !row.ok);
  if (failed.length) throw new Error(`test preparation reported presentation errors: ${JSON.stringify(failed)}`);
  if (presentationErrors.length) throw new Error(`test preparation reported presentation errors: ${JSON.stringify(presentationErrors)}`);
  const [shell] = await shellReady(s);
  await s.presented();
  try {
    await s.get("shell.output", shell.surface);
  } catch (error) {
    throw new Error(`shell readiness returned stale surface ${shell.surface}: ${error.message}; ` +
      `current surfaces: ${JSON.stringify(await s.get("core.surfaces"))}`);
  }
  return shell;
}

/** 보이는 셸 표면들이 등록되고 테마를 적용할 때까지 기다린 뒤 그 표면들을 반환한다. */
export async function shellReady(s) {
  await s.until("core.surfaces",
    (all) => all.some((x) => x.visible && x.plugin === "shell" &&
      x.exposes.includes("status core.surface.document") &&
      x.exposes.includes("status shell.output") &&
      x.exposes.includes("dom shell.input")),
    "no visible shell surface registered its document, output, and input");
  // The notification that satisfies the predicate can describe the surface
  // immediately before a reload replaces it. Read the current registry before
  // returning an id; never continue with a stale surface id.
  const active = new Set((await s.get("core.grid")).cards
    .map((card) => card.active)
    .filter(Boolean));
  const shells = (await s.surfaces("shell")).filter((x) => active.has(x.surface) &&
    x.exposes.includes("status core.surface.document") &&
    x.exposes.includes("status shell.output") &&
    x.exposes.includes("dom shell.input"));
  for (const shell of shells) {
    await s.until("core.surface.document", (doc) => doc !== null && doc.readyState === "complete" && doc.themed,
      `shell ${shell.surface} did not apply its theme`, { surface: shell.surface });
  }
  return shells;
}

/**
 * 경계 끌기를 호스트 시각으로 실행한다. capture 이면 창을 기록하고 프레임 폴더를 반환한다.
 * 기록은 검사가 끝나면 통과 여부와 무관하게 remove() 로 지운다.
 *
 * 끌기가 요청한 속도로 실행되지 않으면(한 번 재시도 후) 실패한다. 느린 끌기의 통과는 통과가 아니다.
 */
export async function drag(t, s, plan, { capture = false } = {}) {
  let result = await dragOnce(t, s, plan, capture);
  if (paced(result)) return result;
  t.diagnostic(`the drag took ${result.took}ms for ${result.asked}ms; dragging again`);
  result = await dragOnce(t, s, plan, capture);
  if (!paced(result)) {
    throw new Error(
      `the drag ran slower than it was asked to, twice (${result.took}ms for ${result.asked}ms). The steps come ` +
        "from the host, whose clock is not held wherever the window is. Nothing was measured: an unrendered area " +
        "shows itself at the speed a person drags at, and a slow drag passing is not a pass.",
    );
  }
  return result;
}

const MARGIN = 1.25;

/** 녹화 프레임 사이 표시 간격의 허용 한도(ms). 끌기 동안 화면은 프레임마다 바뀐다. */
const GAP = 100;

const paced = ({ took, asked }) => took <= asked * MARGIN && took >= asked / MARGIN;

async function dragOnce(t, s, plan, capture) {
  // 활성 창은 배치가 바뀔 때 AppKit 의 커서 갱신을 받고, 창은 실제 포인터 위치를 페이지에 이동으로 넘긴다.
  // 버튼 없이 합성한 진단 끌기는 그 이동과 섞이므로 비활성 애플리케이션에서만 잰다.
  if ((await s.get("host.window")).active) {
    throw new Error(`${s.app.name} is the active application, so the window's cursor updates pass the physical ` +
      "pointer location to the page during the synthetic drag. Nothing was measured: make another application " +
      "active and run the check again.");
  }
  const ms = Math.max(1, Math.round(plan.ms / 16)) * 16 * 2 * plan.times;
  const result = await s.request("diagnostics.drag", { ...plan, capture }, { timeout: REQUEST + ms * 4 });
  if (!capture) return result;
  if (!process.env.SOKSAK_KEEP_FAILURE_CAPTURE) {
    t.after(() => rmSync(result.frames, { recursive: true, force: true }));
  }
  // 끌기의 마지막 화면이 표시되는 시각까지 녹화한다.
  const { displayed } = await s.presented();
  const stopped = await s.request("diagnostics.capture.stop", { after: displayed });
  if (stopped.limited) {
    throw new Error("the recording reached its finite frame limit before the gesture completed");
  }
  // 녹화가 한 번에 이만큼 넘게 끊겼다면 그 사이 화면은 기록되지 않았다. 측정되지 않은 구간은 통과가 아니다.
  if (stopped.longestGap > GAP) {
    throw new Error(`the recording has a ${stopped.longestGap.toFixed(0)}ms gap between frames; ` +
      `frames longer than ${GAP}ms apart were not recorded, so this run did not measure the whole gesture`);
  }
  return { ...result, displayed, count: stopped.count, longestGap: stopped.longestGap, frameDir: stopped.frames };
}
