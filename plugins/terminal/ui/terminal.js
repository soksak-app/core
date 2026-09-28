import { shellQuotePath } from "@soksak/plugin-api";

// 터미널 표면의 부팅과 동작을 처리한다.
//
// startTerminal 함수는 인자로 받은 의존성을 사용하므로 브라우저와 Node 환경에서 모두 부를 수 있다.

/**
 * 입력 텍스트를 base64로 인코딩한다.
 */
function encodeBytes(text, encoder) {
  const bytes = encoder.encode(text);
  return btoa(String.fromCharCode(...bytes));
}

function fileURLPath(value) {
  if (typeof value !== "string") throw new Error("clipboard file URL is not a string");
  let url;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error(`clipboard file URL is invalid: ${error.message}`);
  }
  if (url.protocol !== "file:" || (url.hostname && url.hostname !== "localhost")) {
    throw new Error(`clipboard file URL is not local: ${value}`);
  }
  let path;
  try {
    path = decodeURIComponent(url.pathname);
  } catch (error) {
    throw new Error(`clipboard file URL path is invalid: ${error.message}`);
  }
  if (!path.startsWith("/") || path.length === 1) throw new Error("clipboard file URL path is empty");
  return path;
}

/**
 * 키 이벤트를 sidecar 메시지 형식으로 변환한다.
 * 평문과 특수 키 모두에 사용한다.
 */
function keyToMessage(keyName, text = "", modifiers = {}) {
  const message = {
    operation: "input",
    keys: [{
      key: keyName,
      text,
      shift: modifiers.shift,
      alt: modifiers.alt,
      ctrl: modifiers.ctrl,
    }],
  };
  return message;
}

/**
 * 텍스트 입력을 base64로 인코딩하여 사이드카로 전송한다.
 */
function sendInput(text, terminal, id, encoder) {
  const base64 = encodeBytes(text, encoder);
  return terminal.send(id, { operation: "input", bytes: base64 });
}

const CURSOR_SHAPES = new Set(["block", "underline", "beam"]);
const CURSOR_BLINK_MODES = new Set(["Never", "Off", "On", "Always"]);
const CURSOR_UNFOCUSED = new Set(["hollow", "solid", "underline", "beam", "unchanged"]);
const PROGRAM_CLIPBOARD_POLICIES = new Set(["deny", "allow"]);
const NOTIFICATION_POLICIES = new Set(["tab", "system"]);
const DEFAULT_CURSOR = Object.freeze({
  row: 0, col: 0, shape: "block", visible: true, blinking: false, focused: false,
  blink: "Off", interval: 750, idleTimeout: 5000, unfocused: "hollow", hollow: false,
  blinkVisible: true, drawn: Object.freeze({ shape: "block", blinking: false }),
});

// terminal.session.rejected 에 남기는 거부한 시퀀스의 수.
const REJECTED_KEPT = 8;

// 사이드카가 화면에 그린 커서 모양. 프로그램의 요청과 초점 규칙이 적용된 값이다.
const DRAWN_SHAPES = { Block: "block", Underline: "underline", Beam: "beam", HollowBlock: "hollowBlock", Hidden: "hidden" };

function normalizeRange(range) {
  if (range === null || range === undefined) return null;
  if (!range || typeof range !== "object" || Array.isArray(range) ||
      !Number.isInteger(range.location) || !Number.isInteger(range.length) ||
      range.location < 0 || range.length < 0) {
    throw new Error("IME range must contain nonnegative integer location and length");
  }
  return { location: range.location, length: range.length };
}

// 커서 상태를 검사한다. 값은 이전 상태에 사이드카가 알린 필드를 덮은 전체 상태이므로 모든 필드가 있어야 한다.
function normalizeCursor(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("cursor must be an object");
  }
  const cursor = value;
  const shapes = { block: "block", Block: "block", underline: "underline", Underline: "underline", beam: "beam", Beam: "beam", HollowBlock: "block", Hidden: "block" };
  if (typeof cursor.shape !== "string" || !Object.hasOwn(shapes, cursor.shape)) {
    throw new Error(`cursor.shape is invalid: ${String(cursor.shape)}`);
  }
  if (!CURSOR_BLINK_MODES.has(cursor.blink)) throw new Error(`cursor.blink is invalid: ${String(cursor.blink)}`);
  const integer = (field) => {
    if (!Number.isInteger(cursor[field]) || cursor[field] < 0) throw new Error(`cursor.${field} is invalid`);
    return cursor[field];
  };
  const number = (field) => {
    if (typeof cursor[field] !== "number" || !Number.isFinite(cursor[field]) || cursor[field] < 0) {
      throw new Error(`cursor.${field} is invalid`);
    }
    return cursor[field];
  };
  const boolean = (field) => {
    if (typeof cursor[field] !== "boolean") throw new Error(`cursor.${field} is invalid`);
    return cursor[field];
  };
  if (!CURSOR_UNFOCUSED.has(cursor.unfocused)) throw new Error(`cursor.unfocused is invalid: ${String(cursor.unfocused)}`);
  if (!cursor.drawn || typeof cursor.drawn !== "object") throw new Error("cursor.drawn is invalid");
  return {
    row: integer("row"),
    col: integer("col"),
    shape: shapes[cursor.shape],
    visible: boolean("visible"),
    blinking: boolean("blinking"),
    focused: boolean("focused"),
    blink: cursor.blink,
    interval: number("interval"),
    idleTimeout: number("idleTimeout"),
    unfocused: cursor.unfocused,
    hollow: boolean("hollow"),
    blinkVisible: boolean("blinkVisible"),
    drawn: cursor.drawn,
  };
}

// 커서 정책을 검사한다. 설정과 사이드카의 cursor 답은 다섯 필드를 모두 담는다.
function normalizeCursorPolicy(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("cursor policy must be an object");
  const { shape, blink, unfocused } = value;
  if (!CURSOR_SHAPES.has(shape)) throw new Error(`cursor policy shape is invalid: ${String(shape)}`);
  if (!CURSOR_BLINK_MODES.has(blink)) throw new Error(`cursor policy blink is invalid: ${String(blink)}`);
  if (!CURSOR_UNFOCUSED.has(unfocused)) throw new Error(`cursor policy unfocused is invalid: ${String(unfocused)}`);
  const integer = (name, minimum) => {
    if (!Number.isInteger(value[name]) || value[name] < minimum) throw new Error(`cursor policy ${name} is invalid`);
    return value[name];
  };
  return {
    shape,
    blink,
    interval: integer("interval", 1),
    idleTimeout: integer("idleTimeout", 0),
    unfocused,
  };
}

/**
 * 터미널 표면을 초기화하고 사이드카와 연결한다.
 *
 * @param {Object} options - 의존성 객체
 * @param {Element} options.view - 터미널 표시 영역
 * @param {Function} options.attachImage - 이미지 영역 붙이기 함수
 * @param {Object} options.sidecar - 사이드카 포트
 * @param {Object} options.expose - 공개 항목 등록 함수 모음
 * @param {Object} options.window - window 객체 (기본값: 글로벌 window)
 * @returns {Promise<void>}
 */
export async function startTerminal({ id, view, attachImage, sidecar, expose, theme,
  settings, clipboard, scrollbar = null, reportSurfaceError = () => {}, diagnostics = null,
  // 탭 알림(docs/spec/plugins.md#tab-reports)과 이 탭을 만든 카드의 작업 디렉터리.
  tab = { title() {}, directory() {}, notify() {} }, origin = { directory: null },
  // 표면 창의 프로젝트. 없으면 null 이다.
  project = null,
  // 링크 열기(docs/spec/plugins.md#opening-links).
  links = null,
  // 이 표면의 실제 글자 배율(docs/spec/text-size.md). 출처가 없으면 배율은 1 이다.
  textSize = { read: () => 1, on: () => () => {} },
  window: globalWindow = globalThis.window }) {
  // 브라우저 환경에서 필요한 객체들
  const window = globalWindow;
  const TextEncoder = globalWindow.TextEncoder;

  if (!id) {
    throw new Error("startTerminal requires explicit surface id");
  }
  const encoder = new TextEncoder();

  // 공개 status 마다 값이 바뀔 때 호출할 함수
  const watchers = { session: new Set(), screen: new Set(), compose: new Set(), cursor: new Set() };
  const changed = (name) => {
    for (const fn of watchers[name]) fn(read[name]());
  };
  const watch = (name) => (fn) => {
    watchers[name].add(fn);
    return () => watchers[name].delete(fn);
  };

  // 확인 응답만 있고 따로 처리할 결과가 없는 사이드카 연산.
  const ACKNOWLEDGED = new Set(["selection.start", "selection.update", "paste"]);
  // 현재 세션 상태
  let session = {
    sessionId: "", cols: 80, rows: 24, cellWidth: 8, cellHeight: 16, unsupported: [],
    inlineImages: [],
    // 사이드카가 답한 선택 해제의 수. 해제의 결과(복사 또는 빈 선택)가 도착했음을 알린다.
    selectionReleases: 0,
    mouse: { phase: null, x: null, y: null, pressed: false, shift: false, alt: false, ctrl: false,
      reported: false, written: false, modes: { click: false, drag: false, motion: false }, bytes: null, error: null },
    // 왼쪽 버튼을 누른 선택 제스처가 진행 중인지.
    selecting: false,
    // 뷰포트가 가장 새 출력보다 위에 있는 줄 수와 보관된 기록 줄 수.
    scrollback: { offset: 0, history: 0 },
    // 포인터 아래 칸의 OSC 8 링크 URI. 없으면 null.
    link: null,
    // OSC 22 로 프로그램이 정한 포인터 모양(CSS cursor 값). 링크 칸 위에서는 손 모양이 우선한다.
    pointer: "default",
    // 엔진이 거부한 프로그램 출력 시퀀스의 최근 이유. 프로그램의 출력이므로 터미널 오류가 아니다.
    rejected: [],
    vendor: { directory: null, hyperlink: null, notification: null, shell: null },
    compose: { text: "", selectedRange: null, replacementRange: null, attributed: false },
    theme: "dark",
  };
  let screen = [];
  let compose = session.compose;
  // 네이티브 입력 callback 과 터미널 입력 작업을 받는 함수. 진단 빌드의 진단 모듈만 등록한다.
  const inputObservers = new Set();
  const notifyInput = (entry) => {
    for (const fn of inputObservers) fn(entry);
  };
  let cursor = { ...DEFAULT_CURSOR };
  if (!settings || typeof settings.read !== "function") throw new Error("terminal settings reader is required");
  const initialSettings = settings.read();
  let programClipboardPolicy = initialSettings["clipboard.program"];
  if (!PROGRAM_CLIPBOARD_POLICIES.has(programClipboardPolicy)) {
    throw new Error(`clipboard.program setting is invalid: ${String(programClipboardPolicy)}`);
  }
  let notificationPolicy = initialSettings.notifications;
  if (!NOTIFICATION_POLICIES.has(notificationPolicy)) {
    throw new Error(`notifications setting is invalid: ${String(notificationPolicy)}`);
  }
  settings.on((next) => {
    if (!NOTIFICATION_POLICIES.has(next.notifications)) {
      throw new Error(`notifications setting is invalid: ${String(next.notifications)}`);
    }
    notificationPolicy = next.notifications;
  });

  const read = {
    // 세션 상태
    session: () => session,
    screen: () => screen,
    compose: () => compose,
    cursor: () => cursor,
  };

  // 터미널 사이드카가 이 표면의 VT 세션을 실행한다
  const terminal = sidecar;

  // 이미지 영역 생성 및 사이드카 메시지 핸들링
  let region = null;
  region = attachImage(view, "view");
  if (!region) throw new Error("Failed to attach image region");
  const onRegion = (type, handler) => region.on(type, handler);

  const updateCompose = async (event) => {
    if (!event || typeof event !== "object" || Array.isArray(event) || typeof event.text !== "string") {
      throw new Error("terminal.compose.update requires a text string");
    }
    if (event.attributed !== undefined && typeof event.attributed !== "boolean") {
      throw new Error("IME attributed must be a boolean");
    }
    const nextCompose = {
      text: event.text,
      selectedRange: normalizeRange(event.selectedRange),
      replacementRange: normalizeRange(event.replacementRange),
      attributed: event.attributed === true,
    };
    compose = nextCompose;
    session = { ...session, compose };
    changed("session");
    changed("compose");
    try {
      await enqueueInput({ type: "compose", ...compose });
    } catch (error) {
      reportInputError(error);
      throw error;
    }
    return null;
  };

  // 세션이 생겼는지 추적한다. 래스터 크기는 페이지가 아니라 호스트 configure가 정한다.
  let sessionOpen = false;
  let nativeFocused = false;
  const focusWaiters = new Set();

  let inputChain = Promise.resolve();
  const inputQueue = [];
  const MAX_QUEUE_SIZE = 1024;

  // 세션 오류. 출처마다 마지막 메시지를 두며 session.error 는 가장 최근에 남은 오류다. 스냅샷
  // 출처(state, session, theme, screen, trace)의 오류는 같은 종류의 다음 유효한 이벤트가 해소하고,
  // 다른 출처의 오류는 표면이 닫힐 때까지 남는다. 관련 없는 이벤트는 오류를 지우지 않는다.
  const errors = new Map();
  const setError = (source, message) => {
    console.error(message);
    errors.delete(source);
    errors.set(source, message);
    session = { ...session, error: message };
    changed("session");
  };
  // 반환값은 session 을 바꿨는지다. 호출자가 changed("session") 을 알린다.
  const resolveError = (source) => {
    if (!errors.delete(source)) return false;
    session = { ...session, error: [...errors.values()].at(-1) };
    return true;
  };
  const reportInputError = (error, source = "input") => {
    const message = error instanceof Error ? error.message : String(error);
    setError(source, `terminal input failed: ${message}`);
  };

  // 프로그램이 정한 마지막 제목(OSC 0/2). 설정 title 이 program 이면 탭에 보이고, name 이면 지운다.
  // 탭이 거부한 제목은 세션 오류이며 다음에 받아들여진 제목이 그 오류를 해소한다.
  let programTitle = null;
  const applyTitle = () => {
    const shown = settings.read().title === "program" ? programTitle : null;
    try {
      tab.title(shown);
      if (resolveError("title")) changed("session");
    } catch (error) {
      setError("title", `terminal title failed: ${error.message}`);
      reportSurfaceError(error);
    }
  };

  // 터미널은 카드의 색을 쓴다. 배경은 --card, 글자와 커서는 --fg, 선택 배경은 강조 레일 --rail 이다
  // (docs/spec/terminal-runtime.md). 색의 검사는 사이드카가 한다.
  const setTheme = async (mode, tokens = {}) => {
    if (mode !== "dark" && mode !== "light") throw new Error(`terminal theme mode is invalid: ${String(mode)}`);
    await terminal.send(id, { operation: "theme", mode, background: tokens["--card"],
      foreground: tokens["--fg"], cursor: tokens["--fg"], selection: tokens["--rail"] });
  };
  // terminal.cursor 는 사이드카가 정책을 적용하고 다시 그린 뒤 보내는 cursor 응답으로 바뀐다.
  const setCursorPolicy = async (value) => {
    const policy = normalizeCursorPolicy(value);
    await terminal.send(id, { operation: "cursor", ...policy });
    return policy;
  };
  // 터미널 글꼴 family 우선순위 목록(`;` 로 구분)을 사이드카에 보낸다. 사이드카는 설치된 첫 family 를
  // 적용하고 font 확인 이벤트로 그 family 를 알린다.
  // 글꼴 크기는 13포인트에 이 표면의 글자 배율을 곱한 값이다. family 나 크기가 바뀌면 둘을 함께 보낸다.
  const BASE_FONT_SIZE = 13;
  let fontFamily = null;
  let textFactor = textSize.read();
  let requested = null;
  const sendFont = async () => {
    if (fontFamily === null) return;
    const size = BASE_FONT_SIZE * textFactor;
    if (requested?.family === fontFamily && requested?.size === size) return;
    requested = { family: fontFamily, size };
    await terminal.send(id, { operation: "font", family: fontFamily, size });
  };
  const setFont = async (family) => {
    if (typeof family !== "string" || family.length === 0) throw new Error("font.family setting is invalid");
    fontFamily = family;
    await sendFont();
  };
  const setTextSize = async (factor) => {
    if (!Number.isFinite(factor) || factor <= 0) throw new Error(`text size factor is invalid: ${String(factor)}`);
    textFactor = factor;
    await sendFont();
  };
  const sendPaste = async (text) => {
    if (typeof text !== "string" || text.length === 0) throw new Error("terminal paste text is empty");
    await terminal.send(id, { operation: "paste", text });
    return null;
  };
  const dropFileURLs = (value) => {
    if (!Array.isArray(value) || value.length === 0) throw new Error("terminal file drop has no file URLs");
    return value.map((url) => shellQuotePath(fileURLPath(url))).join(" ");
  };
  const dropFiles = async ({ urls } = {}) => sendPaste(dropFileURLs(urls));
  const pasteText = async () => {
    if (!clipboard || typeof clipboard.read !== "function") {
      throw new Error("terminal.paste requires a clipboard capability");
    }
    const text = await clipboard.read("text");
    if (text !== null) {
      if (typeof text !== "string") throw new Error("text clipboard returned a non-text value");
      return sendPaste(text);
    }
    const urls = await clipboard.read("fileURLs");
    if (urls !== null) {
      if (!Array.isArray(urls) || urls.length === 0) throw new Error("file clipboard is empty");
      return sendPaste(urls.map((url) => shellQuotePath(fileURLPath(url))).join(" "));
    }
    const png = await clipboard.read("png");
    if (png !== null) {
      if (!clipboard || typeof clipboard.persistPNG !== "function") {
        throw new Error("PNG clipboard persistence is unavailable");
      }
      const persisted = await clipboard.persistPNG(png);
      if (!persisted || typeof persisted.shellQuotedPath !== "string" || persisted.shellQuotedPath.length === 0) {
        throw new Error("PNG clipboard persistence returned no shell path");
      }
      return sendPaste(persisted.shellQuotedPath);
    }
    throw new Error("clipboard has no text, file, or PNG payload");
  };
  const rejectClipboardQuery = async (requestId, reason) => {
    if (!Number.isInteger(requestId) || requestId < 0) throw new Error("clipboard query requestId is invalid");
    await terminal.send(id, { operation: "clipboard.reject", requestId, reason });
  };
  const handleClipboardStore = async (body) => {
    if (programClipboardPolicy !== "allow") throw new Error("program clipboard store denied by policy");
    if (body.selection !== "clipboard") throw new Error(`unsupported program clipboard target: ${String(body.selection)}`);
    if (typeof body.text !== "string") throw new Error("program clipboard store requires text");
    if (!clipboard || typeof clipboard.writeText !== "function") throw new Error("program clipboard store requires a clipboard capability");
    await clipboard.writeText(body.text);
  };
  const handleClipboardQuery = async (body) => {
    if (!Number.isInteger(body.requestId) || body.requestId < 0) throw new Error("clipboard query requestId is invalid");
    if (programClipboardPolicy !== "allow") {
      await rejectClipboardQuery(body.requestId, "program clipboard query denied by policy");
      return;
    }
    if (body.selection !== "clipboard") {
      await rejectClipboardQuery(body.requestId, `unsupported program clipboard target: ${String(body.selection)}`);
      return;
    }
    if (!clipboard || typeof clipboard.read !== "function") {
      await rejectClipboardQuery(body.requestId, "program clipboard query requires a clipboard capability");
      return;
    }
    const text = await clipboard.read("text");
    if (text === null) {
      await rejectClipboardQuery(body.requestId, "text clipboard is empty");
      return;
    }
    if (typeof text !== "string") {
      await rejectClipboardQuery(body.requestId, "program clipboard query returned a non-text value");
      return;
    }
    await terminal.send(id, { operation: "clipboard.resolve", requestId: body.requestId, text });
  };
  const releasedSelection = () => {
    session = { ...session, selectionReleases: session.selectionReleases + 1 };
    changed("session");
  };
  const handleSelectionCopy = async (body) => {
    if (body.userInitiated !== true) throw new Error("selection.copy requires userInitiated true");
    if (typeof body.text !== "string" || body.text.length === 0) throw new Error("selection.copy requires non-empty text");
    if (!clipboard || typeof clipboard.writeText !== "function") throw new Error("selection.copy requires a clipboard capability");
    await clipboard.writeText(body.text);
  };

  const observeInput = (promise) => promise.then(undefined, (error) => {
    reportInputError(error);
  });
  const recoverInputTail = () => undefined;

  const sendEntry = async (entry) => {
    if (entry.type === "insert") {
      await sendInput(entry.text, terminal, id, encoder);
    } else if (entry.type === "key") {
      await terminal.send(id, keyToMessage(entry.key, entry.text, {
        shift: entry.shift, alt: entry.alt, ctrl: entry.ctrl,
      }));
    } else if (entry.type === "compose") {
      await terminal.send(id, { operation: "input", compose: {
        text: entry.text,
        selectedRange: entry.selectedRange,
        replacementRange: entry.replacementRange,
        attributed: entry.attributed === true,
      }});
    } else if (entry.type === "command") {
      await terminal.send(id, { operation: "input", command: { selector: entry.selector } });
    } else if (entry.type === "focus") {
      await terminal.send(id, { operation: "input", focus: { focused: entry.focused } });
    } else {
      throw new Error(`unknown terminal input type: ${entry.type}`);
    }
  };

  const scheduleInput = (entry) => {
    const request = inputChain.then(() => sendEntry(entry));
    // The recovered tail only permits the next request to run. The original
    // request remains rejected for its caller; native callbacks observe that
    // rejection through observeInput and publish the error in session status.
    inputChain = request.catch(recoverInputTail);
    return request;
  };

  // 사이드카가 보낸 커서 값을 status 에 반영하고 입력기 caret 을 그 칸에 둔다.
  // value 는 사이드카 원본, fields 는 반영할 값이다. 잘못된 값은 오류로 알린다.
  const applyCursor = (value, fields) => {
    try {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("cursor must be an object");
      cursor = normalizeCursor({ ...cursor, ...fields });
      changed("cursor");
      if (typeof region.setCaret === "function") {
        Promise.resolve(region.setCaret({
          x: cursor.col * session.cellWidth,
          y: cursor.row * session.cellHeight,
          width: session.cellWidth,
          height: session.cellHeight,
        })).catch(reportInputError);
      }
    } catch (error) {
      setError("cursor", `invalid cursor from sidecar: ${error.message}`);
    }
  };

  const enqueueInput = (entry) => {
    notifyInput({ kind: "terminal-input", input: entry });
    if (!sessionOpen) {
      if (inputQueue.length >= MAX_QUEUE_SIZE) {
        const error = new Error(`Input queue overflow (max ${MAX_QUEUE_SIZE})`);
        return Promise.reject(error);
      }
      return new Promise((resolve, reject) => inputQueue.push({ entry, resolve, reject }));
    }
    return scheduleInput(entry);
  };

  const flushInputQueue = () => {
    const pending = inputQueue.splice(0);
    for (const { entry, resolve, reject } of pending) {
      scheduleInput(entry).then(resolve, reject);
    }
  };

  // 영역 insert 이벤트: 평문 텍스트 입력
  onRegion("insert", async (event) => {
    const { text } = event;
    notifyInput({ kind: "native-insert", text });
    let composeRequest = null;
    if (compose.text) {
      compose = { text: "", selectedRange: null, replacementRange: null, attributed: false };
      session = { ...session, compose };
      changed("session");
      changed("compose");
      composeRequest = enqueueInput({ type: "compose", ...compose });
    }
    const insertRequest = enqueueInput({ type: "insert", text });
    if (composeRequest) {
      await Promise.all([observeInput(composeRequest), observeInput(insertRequest)]);
    } else {
      await observeInput(insertRequest);
    }
  });

  // 영역 key 이벤트: 특수 키와 수정자
  // 사이드카는 키 이름만 받고 이스케이프 시퀀스를 생성한다
  onRegion("key", async (event) => {
    const { key, text, shift, alt, ctrl } = event;
    notifyInput({ kind: "native-key", key, text });
    // 네이티브 영역은 항상 불린으로 수정자를 보낸다. 아니면 계약 위반이다.
    if (typeof shift !== "boolean" || typeof alt !== "boolean" || typeof ctrl !== "boolean") {
      setError("key", `invalid key event from region: modifiers must be boolean, got shift:${typeof shift} alt:${typeof alt} ctrl:${typeof ctrl}`);
      return;
    }
    await observeInput(enqueueInput({ type: "key", key, text, shift, alt, ctrl }));
  });

  onRegion("error", (event) => {
    const message = `native image: ${event.reason}`;
    setError("native image", message);
    reportSurfaceError(new Error(message));
  });

  onRegion("compose", async (event) => {
    notifyInput({ kind: "native-compose", text: event.text });
    await observeInput(updateCompose(event));
  });

  onRegion("command", async (event) => {
    if (typeof event.selector !== "string" || event.selector.length === 0) {
      reportInputError("native command event requires selector");
      return;
    }
    await observeInput(enqueueInput({ type: "command", selector: event.selector }));
  });

  // Edit 메뉴 동작은 선언된 명령을 레지스트리로 실행한다(docs/spec/terminal-runtime.md).
  const ACTIONS = { paste: "terminal.paste", copy: "terminal.copy" };
  onRegion("action", async (event) => {
    const command = ACTIONS[event?.name];
    if (!command) {
      reportInputError(new Error(`unknown native action: ${String(event?.name)}`));
      return;
    }
    await observeInput(Promise.resolve().then(() => expose.run(command, {})));
  });

  onRegion("focus", async (event) => {
    if (typeof event.focused !== "boolean") {
      reportInputError("native focus event requires boolean focused");
      return;
    }
    nativeFocused = event.focused;
    await observeInput(enqueueInput({ type: "focus", focused: event.focused }));
    if (event.focused) {
      for (const resolve of focusWaiters) resolve();
      focusWaiters.clear();
    }
  });


  // 네이티브 포커스를 받은 뒤 DOM 기본 동작이 키보드 소유권을 되찾지 않게 한다.
  const preventDefaultFocus = (event) => event.preventDefault();
  view.addEventListener("pointerdown", preventDefaultFocus);
  let selectionPointerId = null;
  let selectionStart = null;
  let selectionStarted = false;
  // 누름은 뷰 안이어야 한다. 누른 뒤 끄는 포인터가 뷰 밖으로 나가면 뷰 안의 가장 가까운 점으로 맞춘다.
  // 줄의 처음이나 끝을 고르는 끌기는 포인터가 뷰 가장자리를 지나기 쉽다.
  const selectionPoint = (event, nearest = false) => {
    const rect = view.getBoundingClientRect();
    let x = event.clientX - rect.left;
    let y = event.clientY - rect.top;
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("terminal selection pointer has no position");
    if (nearest) {
      x = Math.min(rect.width - 1, Math.max(0, x));
      y = Math.min(rect.height - 1, Math.max(0, y));
    } else if (x < 0 || y < 0 || x >= rect.width || y >= rect.height) {
      throw new Error("terminal selection pointer is outside the view");
    }
    return { x, y };
  };
  // 포인터 아래 칸의 OSC 8 링크. 사이드카의 selection_cell 과 같이 CSS 칸 크기로 칸을 정한다.
  const linkAt = (event) => {
    const rect = view.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    if (!(session.cellWidth > 0 && session.cellHeight > 0 && session.cols > 0 && session.rows > 0)) return null;
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= rect.width || y >= rect.height) return null;
    const col = Math.min(Math.floor(x / session.cellWidth), session.cols - 1);
    const row = Math.min(Math.floor(y / session.cellHeight), session.rows - 1);
    const link = screen[row]?.[col]?.link;
    return typeof link === "string" ? link : null;
  };
  // 포인터 입력을 사이드카에 알린다. 프로그램이 마우스 보고를 켰으면 사이드카가 보고로 바꾸고, 아니면 무시한다.
  // 버튼 없는 움직임은 칸이 바뀔 때만 보낸다.
  let hoverCell = null;
  // 마우스 보고와 선택 연산은 같은 PTY 상태를 갱신한다. 요청을 동시에 보내면
  // transport 응답 순서가 달라져 selection.update 가 selection.start 보다 먼저
  // 처리될 수 있다. 제스처 전체를 하나의 순서열로 보낸다.
  let pointerInputChain = Promise.resolve();
  const queuePointerInput = (body) => {
    const request = pointerInputChain.then(() => terminal.send(id, body));
    pointerInputChain = request.catch(recoverInputTail);
    observeInput(request);
    return request;
  };
  const sendMouse = (phase, point, event, pressed) => {
    queuePointerInput({ operation: "mouse", phase, ...point, pressed,
      shift: event.shiftKey === true, alt: event.altKey === true, ctrl: event.ctrlKey === true });
  };
  const hoverMouse = (event) => {
    if (selectionPointerId !== null || !(session.cellWidth > 0 && session.cellHeight > 0)) return;
    const rect = view.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= rect.width || y >= rect.height) return;
    const cell = `${Math.floor(x / session.cellWidth)},${Math.floor(y / session.cellHeight)}`;
    if (cell === hoverCell) return;
    hoverCell = cell;
    sendMouse("move", { x, y }, event, false);
  };
  // 프로그램이 정한 포인터 모양. 기본값은 페이지의 커서다.
  const pointerStyle = () => (session.pointer === "default" ? "" : session.pointer);
  // 링크 칸 위의 포인터는 손 모양이다.
  const hoverLink = (event) => {
    const link = event.type === "pointerleave" ? null : linkAt(event);
    if (link === session.link) return;
    view.style.cursor = link ? "pointer" : pointerStyle();
    session = { ...session, link };
    changed("session");
  };
  const beginSelection = (event) => {
    if (event.button !== 0 || selectionPointerId !== null) return;
    // Command 와 함께 누른 링크 칸은 선언된 명령으로 링크를 열고 선택을 시작하지 않는다.
    const link = event.metaKey ? linkAt(event) : null;
    if (link) {
      event.preventDefault();
      observeInput(Promise.resolve().then(() => expose.run("terminal.link.open", { uri: link })));
      return;
    }
    try {
      const point = selectionPoint(event);
      // Pointer capture is the ownership boundary. Do not publish a selecting
      // state or enqueue a mouse down until the browser confirms the capture.
      view.setPointerCapture(event.pointerId);
      sendMouse("down", point, event, true);
      selectionPointerId = event.pointerId;
      selectionStart = point;
      selectionStarted = false;
      session = { ...session, selecting: true };
      changed("session");
      event.preventDefault();
    } catch (error) {
      reportInputError(error);
    }
  };
  const updateSelection = (event) => {
    if (event.pointerId !== selectionPointerId) return;
    try {
      const point = selectionPoint(event, true);
      event.preventDefault();
      sendMouse("move", point, event, true);
      if (!selectionStarted) {
        if (point.x === selectionStart.x && point.y === selectionStart.y) return;
        selectionStarted = true;
        queuePointerInput({ operation: "selection.start", ...selectionStart });
      }
      queuePointerInput({ operation: "selection.update", ...point });
    } catch (error) {
      reportInputError(error);
    }
  };
  const endSelection = (event) => {
    if (event.pointerId !== selectionPointerId) return;
    selectionPointerId = null;
    const started = selectionStarted;
    const start = selectionStart;
    selectionStart = null;
    selectionStarted = false;
    session = { ...session, selecting: false };
    changed("session");
    try {
      view.releasePointerCapture(event.pointerId);
    } catch (error) {
      // The browser may have already released capture before this boundary.
      // Keep the failure observable, but do not abandon the terminal release
      // sequence or leave the next gesture dependent on this call.
      reportInputError(error);
    }
    event.preventDefault();
    // 움직이지 않은 클릭은 누른 칸에서 빈 선택을 시작하고 끝낸다. 빈 선택의 뗌은 이전 선택을 지운다.
    if (!started) queuePointerInput({ operation: "selection.start", ...start });
    queuePointerInput({ operation: "selection.end" });
    // 뗌은 선택 연산 뒤에 보낸다. 사이드카는 마우스 보고 제스처의 선택 연산을 뗌 전에 받아 선택하지 않는다.
    try {
      sendMouse("up", selectionPoint(event, true), event, false);
    } catch (error) {
      reportInputError(error);
    }
  };
  // 휠은 스크롤 제스처다. 이동량을 정수 줄로 바꿔 포인터 칸과 함께 보낸다(docs/spec/terminal-runtime.md).
  // 한 줄보다 작은 픽셀 이동은 누적한다. 양수 줄은 오래된 출력 쪽이다.
  let wheelLines = 0;
  const scrollWheel = (event) => {
    event.preventDefault();
    const { cols, rows, cellWidth, cellHeight } = session;
    const delta = event.deltaMode === 1 ? event.deltaY : event.deltaMode === 2 ? event.deltaY * rows : event.deltaY / cellHeight;
    wheelLines -= delta;
    const lines = Math.trunc(wheelLines);
    if (lines === 0) return;
    wheelLines -= lines;
    const rect = view.getBoundingClientRect();
    const col = Math.min(cols - 1, Math.max(0, Math.floor((event.clientX - rect.left) / cellWidth)));
    const row = Math.min(rows - 1, Math.max(0, Math.floor((event.clientY - rect.top) / cellHeight)));
    observeInput(terminal.send(id, { operation: "scroll", lines, col, row }));
  };
  view.addEventListener("wheel", scrollWheel, { passive: false });

  // 스크롤바는 터미널이 기록을 보관하는 동안 보인다(docs/spec/terminal-runtime.md).
  const thumbGeometry = () => {
    const { rows, scrollback: { offset, history } } = session;
    const height = scrollbar.track.getBoundingClientRect().height;
    const size = Math.min(height, Math.max(16, height * rows / (rows + history)));
    const top = Math.min(height - size, height * (history - offset) / (rows + history));
    return { height, size, top };
  };
  // 스크롤바 설정(docs/spec/terminal-runtime.md). 잘못된 값은 입력 오류로 보고하고 적용하지 않는다.
  const COLOR = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;
  const scrollbarStyle = { track: "terminal", thumb: "#8f98a080", width: 10, shape: "rounded" };
  let terminalBackground = null;
  const applyScrollbarSettings = (values) => {
    const next = { track: values["scrollbar.track"], thumb: values["scrollbar.thumb"], width: values["scrollbar.width"], shape: values["scrollbar.shape"] };
    if (next.track === "terminal" || (typeof next.track === "string" && COLOR.test(next.track))) scrollbarStyle.track = next.track;
    else reportInputError(new Error(`scrollbar.track setting is invalid: ${String(next.track)}`));
    if (typeof next.thumb === "string" && COLOR.test(next.thumb)) scrollbarStyle.thumb = next.thumb;
    else reportInputError(new Error(`scrollbar.thumb setting is invalid: ${String(next.thumb)}`));
    if (Number.isInteger(next.width) && next.width >= 4 && next.width <= 24) scrollbarStyle.width = next.width;
    else reportInputError(new Error(`scrollbar.width setting is invalid: ${String(next.width)}`));
    if (next.shape === "rounded" || next.shape === "square") scrollbarStyle.shape = next.shape;
    else reportInputError(new Error(`scrollbar.shape setting is invalid: ${String(next.shape)}`));
    paintScrollbar();
  };
  // 트랙은 네이티브 그림이 잘린 자리를 칠한다. terminal 은 터미널의 현재 기본 배경색이다.
  const paintScrollbar = () => {
    if (!scrollbar) return;
    scrollbar.track.style.width = `${scrollbarStyle.width}px`;
    // 기본값: 첫 화면의 배경을 받기 전에는 트랙을 아직 색칠하지 않는다.
    scrollbar.track.style.background = scrollbarStyle.track === "terminal" ? (terminalBackground ?? "") : scrollbarStyle.track;
    scrollbar.thumb.style.background = scrollbarStyle.thumb;
    scrollbar.thumb.style.borderRadius = scrollbarStyle.shape === "square" ? "0px" : "999px";
  };
  const drawScrollbar = () => {
    if (!scrollbar) return;
    scrollbar.track.hidden = session.scrollback.history === 0;
    if (scrollbar.track.hidden) return;
    const { size, top } = thumbGeometry();
    scrollbar.thumb.style.height = `${size}px`;
    scrollbar.thumb.style.top = `${top}px`;
  };
  // 손잡이를 끄는 동안 포인터 아래의 오프셋으로 선언된 명령을 실행한다.
  let thumbDrag = null;
  const beginThumbDrag = (event) => {
    if (event.button !== 0 || thumbDrag) return;
    event.preventDefault();
    event.stopPropagation();
    const { top } = thumbGeometry();
    thumbDrag = { pointerId: event.pointerId, grab: event.clientY - scrollbar.track.getBoundingClientRect().top - top, sent: null };
    // 끄는 동안 손잡이는 쥔 손 포인터를 보인다.
    scrollbar.thumb.dataset.dragging = "";
    scrollbar.thumb.setPointerCapture(event.pointerId);
  };
  const moveThumb = (event) => {
    if (!thumbDrag || event.pointerId !== thumbDrag.pointerId) return;
    event.preventDefault();
    const { rows, scrollback: { history } } = session;
    const { height } = thumbGeometry();
    const top = event.clientY - scrollbar.track.getBoundingClientRect().top - thumbDrag.grab;
    const offset = Math.min(history, Math.max(0, Math.round(history - top / height * (rows + history))));
    if (offset === thumbDrag.sent) return;
    thumbDrag.sent = offset;
    observeInput(Promise.resolve().then(() => expose.run("terminal.scrollback.set", { offset })));
  };
  const endThumbDrag = (event) => {
    if (!thumbDrag || event.pointerId !== thumbDrag.pointerId) return;
    scrollbar.thumb.releasePointerCapture(event.pointerId);
    delete scrollbar.thumb.dataset.dragging;
    thumbDrag = null;
  };
  if (scrollbar) {
    scrollbar.thumb.addEventListener("pointerdown", beginThumbDrag);
    scrollbar.thumb.addEventListener("pointermove", moveThumb);
    scrollbar.thumb.addEventListener("pointerup", endThumbDrag);
    scrollbar.thumb.addEventListener("pointercancel", endThumbDrag);
    drawScrollbar();
  }
  view.addEventListener("pointerdown", beginSelection);
  view.addEventListener("pointermove", updateSelection);
  view.addEventListener("pointermove", hoverLink);
  view.addEventListener("pointermove", hoverMouse);
  view.addEventListener("pointerleave", hoverLink);
  view.addEventListener("pointerup", endSelection);
  view.addEventListener("pointercancel", endSelection);
  // 카드 전환이나 창 비활성화로 캡처가 풀리면 pointerup이 오지 않을 수 있다. 선택 포인터와
  // 사이드카의 누른 상태를 같은 경계에서 닫아 다음 카드 복귀 뒤 새 드래그를 허용한다.
  view.addEventListener("lostpointercapture", endSelection);

  // screen.read 응답을 기다리는 resolver
  let pendingScreenRead = null;

  // 사이드카 메시지 수신
  const stopSidecar = await terminal.on(id, (body) => {
    if (body.event === "state") {
      // 숫자 필드의 유효성을 확인한다. 계약 위반이면 오류로 보고한다.
      const errorDetails = [];
      if (typeof body.cols !== "number" || body.cols <= 0) {
        errorDetails.push(`cols: ${typeof body.cols === "number" ? `invalid value ${body.cols}` : `missing or wrong type`}`);
      }
      if (typeof body.rows !== "number" || body.rows <= 0) {
        errorDetails.push(`rows: ${typeof body.rows === "number" ? `invalid value ${body.rows}` : `missing or wrong type`}`);
      }
      if (typeof body.cellWidth !== "number" || body.cellWidth <= 0) {
        errorDetails.push(`cellWidth: ${typeof body.cellWidth === "number" ? `invalid value ${body.cellWidth}` : `missing or wrong type`}`);
      }
      if (typeof body.cellHeight !== "number" || body.cellHeight <= 0) {
        errorDetails.push(`cellHeight: ${typeof body.cellHeight === "number" ? `invalid value ${body.cellHeight}` : `missing or wrong type`}`);
      }

      if (errorDetails.length > 0) {
        setError("state", `invalid state from sidecar: ${errorDetails.join("; ")}`);
        return;
      }

      session = {
        ...session,
        sessionId: typeof body.sessionId === "string" ? body.sessionId : "",
        cols: body.cols,
        rows: body.rows,
        cellWidth: body.cellWidth,
        cellHeight: body.cellHeight,
        unsupported: session.unsupported,
      };
      resolveError("state");
      if (body.cursor !== undefined) applyCursor(body.cursor, body.cursor);
      sessionOpen = true;
      changed("session");
      flushInputQueue();
    } else if (body.event === "session") {
      if (typeof body.sessionId !== "string" || body.sessionId.length === 0) {
        reportInputError("invalid persistent session event", "session");
        return;
      }
      session = { ...session, sessionId: body.sessionId };
      resolveError("session");
      sessionOpen = true;
      changed("session");
    } else if (body.event === "screen") {
      // screen 이벤트를 처리한다. screen.read 응답이나 화면 변화 알림.
      screen = body.lines;
      changed("screen");
      if (typeof body.background === "string" && body.background !== terminalBackground) {
        terminalBackground = body.background;
        paintScrollbar();
      }
      if (body.scrollback !== undefined) {
        const { offset, history } = body.scrollback;
        if (!Number.isInteger(offset) || !Number.isInteger(history) || offset < 0 || history < 0) {
          reportInputError(`invalid screen scrollback from sidecar: ${JSON.stringify(body.scrollback)}`, "screen");
        } else if (offset !== session.scrollback.offset || history !== session.scrollback.history) {
          session = { ...session, scrollback: { offset, history } };
          changed("session");
          drawScrollbar();
        }
      }
      // 화면의 커서는 현재 위치·표시·포커스와 그린 모양이다. 그린 모양은 표시 규칙이 적용된 값이므로 정책 값을 바꾸지 않고
      // drawn 에 둔다.
      if (body.cursor !== undefined) {
        const { col, row, visible, focused, shape, blinking } = body.cursor;
        if (!Number.isInteger(col) || !Number.isInteger(row) || typeof visible !== "boolean" || typeof focused !== "boolean" ||
          !Object.hasOwn(DRAWN_SHAPES, shape) || typeof blinking !== "boolean") {
          reportInputError(`invalid screen cursor from sidecar: ${JSON.stringify(body.cursor)}`, "screen");
        } else {
          applyCursor(body.cursor, { col, row, visible, focused, drawn: { shape: DRAWN_SHAPES[shape], blinking } });
          if (resolveError("screen")) changed("session");
        }
      }
      if (pendingScreenRead) {
        pendingScreenRead(body);
        pendingScreenRead = null;
      }
    } else if (body.event === "cursor") {
      try {
        const policy = normalizeCursorPolicy(body);
        cursor = { ...cursor, ...policy };
        changed("cursor");
      } catch (error) {
        reportInputError(new Error(`invalid cursor policy from sidecar: ${error.message}`));
      }
    } else if (body.event === "theme") {
      if (body.mode !== "dark" && body.mode !== "light") {
        reportInputError(new Error("invalid theme acknowledgement from sidecar"), "theme");
        return;
      }
      // 사이드카가 적용한 기본 배경을 함께 알린다. 검사는 이 값으로 테마가 적용되었음을 안다.
      session = { ...session, theme: body.mode, background: typeof body.background === "string" ? body.background : null };
      resolveError("theme");
      changed("session");
    } else if (body.event === "mouse") {
      const modes = body.modes;
      if (!["down", "move", "up"].includes(body.phase) || !modes ||
          !["click", "drag", "motion"].every((key) => typeof modes[key] === "boolean") ||
          typeof body.reported !== "boolean" || typeof body.written !== "boolean" ||
          (body.bytes !== null && typeof body.bytes !== "string")) {
        reportInputError(new Error("invalid mouse measurement from sidecar"));
        return;
      }
      session = { ...session, mouse: {
        phase: body.phase, x: body.x, y: body.y, pressed: body.pressed, shift: body.shift,
        alt: body.alt, ctrl: body.ctrl, reported: body.reported, written: body.written,
        modes, bytes: body.bytes, error: typeof body.error === "string" ? body.error : null,
      }};
      changed("session");
    } else if (body.event === "clipboard.store") {
      handleClipboardStore(body).catch(reportInputError);
    } else if (body.event === "clipboard.query") {
      handleClipboardQuery(body).catch(reportInputError);
    } else if (body.event === "clipboard.rejected") {
      reportInputError(new Error(typeof body.reason === "string" ? body.reason : "program clipboard query rejected"));
    } else if (body.event === "selection.copy") {
      handleSelectionCopy(body).catch(reportInputError);
      releasedSelection();
    } else if (body.event === "copy") {
      // 복사 명령의 답이다. 선택이 없으면 사이드카가 copied false 로 알리고 클립보드는 그대로 둔다.
      if (body.copied === false) return;
      handleSelectionCopy(body).catch(reportInputError);
    } else if (body.ack === true && ACKNOWLEDGED.has(body.event)) {
      // 사이드카가 연산을 적용했다는 확인이다. 결과는 이미지나 뒤따르는 이벤트로 온다.
    } else if (body.event === "selection.end") {
      // 글자를 담지 않은 선택의 해제다. 사이드카가 선택을 지웠고 복사할 것이 없다.
      if (body.copied !== false) reportInputError(new Error("selection.end requires copied false"));
      releasedSelection();
    } else if (body.event === "directory") {
      if (typeof body.uri !== "string" || body.uri.length === 0 || (body.path !== null && typeof body.path !== "string")) {
        reportInputError(new Error("invalid directory event from sidecar"));
        return;
      }
      session = { ...session, vendor: { ...session.vendor, directory: body.uri } };
      changed("session");
      // 다른 컴퓨터의 디렉터리(path null)는 기록한 디렉터리를 지운다.
      try {
        tab.directory(body.path);
      } catch (error) {
        reportInputError(error);
      }
    } else if (body.event === "title") {
      if (typeof body.title !== "string") {
        reportInputError(new Error("invalid title event from sidecar"));
        return;
      }
      // 빈 제목은 제목이 없다는 뜻이다.
      programTitle = body.title === "" ? null : body.title;
      applyTitle();
    } else if (body.event === "title.reset") {
      programTitle = null;
      applyTitle();
    } else if (body.event === "hyperlink") {
      if (typeof body.id !== "string" || (body.uri !== null && typeof body.uri !== "string")) {
        reportInputError(new Error("invalid hyperlink event from sidecar"));
        return;
      }
      session = { ...session, vendor: { ...session.vendor, hyperlink: { id: body.id, uri: body.uri } } };
      changed("session");
    } else if (body.event === "pointer") {
      if (typeof body.shape !== "string" || body.shape.length === 0) {
        reportInputError(new Error("invalid pointer event from sidecar"));
        return;
      }
      session = { ...session, pointer: body.shape };
      if (!session.link) view.style.cursor = pointerStyle();
      changed("session");
    } else if (body.event === "notification") {
      if (typeof body.message !== "string" || body.message.length === 0) {
        reportInputError(new Error("invalid notification event from sidecar"));
        return;
      }
      session = { ...session, vendor: { ...session.vendor, notification: body.message } };
      changed("session");
      // 보이지 않는 탭이면 워크벤치가 탭에 알림을 둔다. 거부된 알림은 세션 오류다.
      try {
        tab.notify(body.message, notificationPolicy);
      } catch (error) {
        setError("notification", `terminal notification failed: ${error.message}`);
        reportSurfaceError(error);
      }
    } else if (body.event === "vendor.shell.state") {
      const markers = new Set(["prompt.start", "prompt.end", "command.start", "command.finished"]);
      if (!markers.has(body.marker) || !Array.isArray(body.params) || body.params.some((value) => typeof value !== "string")) {
        reportInputError(new Error("invalid shell state event from sidecar"));
        return;
      }
      session = { ...session, vendor: { ...session.vendor, shell: { marker: body.marker, params: body.params } } };
      changed("session");
    } else if (body.event === "image.inline" && body.command === "display" && typeof body.name === "string") {
      if (!session.inlineImages.includes(body.name)) {
        session = { ...session, inlineImages: [...session.inlineImages, body.name] };
        changed("session");
      }
    } else if (body.event === "image.inline.deleted" && typeof body.name === "string") {
      if (session.inlineImages.includes(body.name)) {
        session = { ...session, inlineImages: session.inlineImages.filter((name) => name !== body.name) };
        changed("session");
      }
    } else if (body.event === "sequence.rejected") {
      if (typeof body.reason !== "string" || body.reason.length === 0) {
        reportInputError(new Error("invalid sequence.rejected event from sidecar"));
        return;
      }
      session = { ...session, rejected: [...session.rejected, body.reason].slice(-REJECTED_KEPT) };
      changed("session");
    } else if (body.event === "error") {
      // error 이벤트를 session 상태에 저장한다
      const error = new Error(typeof body.reason === "string" ? body.reason : (typeof body.error === "string" ? body.error : "Unknown sidecar error"));
      setError("sidecar", error.message);
      reportSurfaceError(error);
    } else if (body.event === "font" && typeof body.family === "string") {
      session = { ...session, font: body.family, fontSystem: body.system === true, fontSize: body.size };
      changed("session");
    } else if (body.error) {
      // 오류 응답 처리: {"error":"invalidParams","reason":"...",...}
      // reason 을 버리지 않고 오류에 실어 보낸다.
      const message = typeof body.reason === "string" ? `${body.error}: ${body.reason}` : body.error;
      setError("sidecar", message);
      reportSurfaceError(new Error(message));
    } else if (body.event) {
      // 알 수 없는 이벤트 타입을 보고한다
      console.warn(`sidecar sent unknown event type: ${body.event}`);
      if (!session.unsupported.includes(body.event)) {
        session = { ...session, unsupported: [...session.unsupported, body.event] };
        changed("session");
      }
    }
  });

  // 세션 열기는 크기를 보내지 않는다. 호스트가 네이티브 영역을 적용하며 보낸 configure만
  // 이미지와 PTY 크기의 권위 있는 입력이다.
  // 세션은 설정 shell 이 가리키는 셸을 연다(login 은 계정의 로그인 셸). 설정이 없으면 다른 셸로 대신하지 않는다.
  const shell = settings.read().shell;
  if (typeof shell !== "string" || shell.length === 0) throw new Error("terminal shell setting is missing");
  applyTitle();
  // 터미널에서 쪼갠 터미널은 그 터미널이 마지막으로 알린 디렉터리에서, 아니면 프로젝트 루트에서 시작한다.
  // 프로젝트가 없는 창에서는 홈 디렉터리에서 시작한다(docs/spec/terminal-runtime.md).
  // 기본값: 분할 출처에 디렉터리가 없으면 프로젝트 루트, 프로젝트도 없으면 홈 디렉터리에서 연다.
  const directory = origin.directory ?? project?.root ?? null;
  await terminal.send(id, { operation: "open", image: "view", shell, ...(directory === null ? {} : { directory }) });

  let themeReady = Promise.resolve();
  let themeSubscription = null;
  if (typeof theme === "function") {
    let first = true;
    themeSubscription = theme((value) => {
      if (!value || (value.scheme !== "dark" && value.scheme !== "light")) {
        const error = new Error("theme callback must provide scheme dark or light");
        reportInputError(error);
        if (first) { first = false; return Promise.reject(error); }
        return Promise.resolve();
      }
      const request = setTheme(value.scheme, value.tokens);
      if (first) {
        first = false;
        return request.then(undefined, (error) => { reportInputError(error); throw error; });
      }
      return request.catch(reportInputError);
    });
    // 기본값: 구독 결과에 ready 약속이 없으면 구독 결과 자체가 첫 테마 적용의 완료다.
    themeReady = Promise.resolve(themeSubscription?.ready ?? themeSubscription).catch((error) => {
      reportInputError(error);
      throw error;
    });
  }
  await themeReady;

  let settingsSubscription = null;
  const settingsPolicy = () => {
    const values = settings.read();
    return {
      shape: values["cursor.shape"],
      blink: values["cursor.blink"],
      interval: values["cursor.interval"],
      idleTimeout: values["cursor.idleTimeout"],
      unfocused: values["cursor.unfocused"],
    };
  };
  if (settings) {
    await setFont(settings.read()["font.family"]).catch((error) => {
      reportInputError(error);
    });
    await setCursorPolicy(settingsPolicy());
    applyScrollbarSettings(settings.read());
    settingsSubscription = settings.on((values) => {
      applyScrollbarSettings(values);
      applyTitle();
      const nextClipboardPolicy = values["clipboard.program"];
      if (!PROGRAM_CLIPBOARD_POLICIES.has(nextClipboardPolicy)) {
        reportInputError(new Error(`clipboard.program setting is invalid: ${String(nextClipboardPolicy)}`));
        return;
      }
      programClipboardPolicy = nextClipboardPolicy;
      const policy = {
        shape: values["cursor.shape"],
        blink: values["cursor.blink"],
        interval: values["cursor.interval"],
        idleTimeout: values["cursor.idleTimeout"],
        unfocused: values["cursor.unfocused"],
      };
      setCursorPolicy(policy).catch(reportInputError);
      setFont(values["font.family"]).catch(reportInputError);
    });
  }

  const textSizeSubscription = textSize.on((factor) => setTextSize(factor).catch(reportInputError));

  // 공개 항목 등록
  await Promise.all([
    expose.status("terminal.session", read.session, watch("session")),
    expose.status("terminal.screen", read.screen, watch("screen")),
    expose.status("terminal.compose", read.compose, watch("compose")),
    expose.status("terminal.cursor", read.cursor, watch("cursor")),
    expose.command("terminal.input", async ({ bytes }) => {
      if (typeof bytes !== "string") throw new Error("terminal.input requires bytes");
      try {
        await enqueueInput({ type: "insert", text: bytes });
      } catch (error) {
        reportInputError(error);
        throw error;
      }
      return null;
    }),
    expose.command("terminal.screen.read", async () => {
      if (region === null) throw new Error("Terminal not initialized");
      return new Promise((resolve, reject) => {
        let resolved = false;
        const timeout = setTimeout(() => {
          if (!resolved) {
            resolved = true;
            pendingScreenRead = null;
            reject(new Error("screen.read timeout"));
          }
        }, 5000);

        pendingScreenRead = (event) => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            resolve(event.lines);
          }
        };

        terminal.send(id, { operation: "screen.read" }).catch((error) => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            pendingScreenRead = null;
            reject(error);
          }
        });
      });
    }),
    expose.command("terminal.close", async () => {
      await terminal.send(id, { operation: "close" });
      return null;
    }),
    expose.command("terminal.image.inline.delete", async ({ name }) => {
      if (typeof name !== "string" || name.length === 0) {
        throw new Error("terminal.image.inline.delete requires a non-empty name");
      }
      await terminal.send(id, { operation: "image.inline.delete", name });
      return null;
    }),
    expose.dom("terminal.view", view),
  ]);
  await expose.command("terminal.focus", async () => {
    try {
      await region.focus();
      return null;
    } catch (error) {
      reportInputError(error);
      throw error;
    }
  });
  // 빠진 필드는 지금 정책 값을 유지한다.
  await expose.command("terminal.cursor.set", async (policy) => setCursorPolicy({
    shape: cursor.shape, blink: cursor.blink, interval: cursor.interval, idleTimeout: cursor.idleTimeout,
    unfocused: cursor.unfocused, ...policy,
  }));
  await expose.command("terminal.paste", pasteText);
  await expose.command("terminal.scrollback.set", async ({ offset } = {}) => {
    if (!Number.isInteger(offset) || offset < 0) throw new Error(`terminal.scrollback.set requires a nonnegative integer offset: ${String(offset)}`);
    await terminal.send(id, { operation: "viewport", offset });
    return null;
  });
  if (scrollbar) {
    await Promise.all([
      expose.dom("terminal.scrollbar", scrollbar.track),
      expose.dom("terminal.scrollbar.thumb", scrollbar.thumb),
      expose.mark(scrollbar.thumb, "terminal.scrollback.set"),
    ]);
  }
  // 현재 선택의 텍스트는 사이드카가 copy 이벤트로 보낸다.
  await expose.command("terminal.link.open", async ({ uri } = {}) => {
    if (typeof uri !== "string" || uri.length === 0) throw new Error("terminal.link.open requires a uri");
    if (!links) throw new Error("the terminal has no link capability");
    await links.open(uri);
  });
  await expose.command("terminal.copy", async () => {
    await terminal.send(id, { operation: "copy" });
    return null;
  });
  await expose.command("terminal.drop", dropFiles);
  // 진단 빌드에서는 진단 모듈이 preedit 주입과 입력 기록 항목을 이 연산으로 등록한다.
  if (diagnostics) {
    await diagnostics.attach({
      expose,
      updateCompose,
      onInput: (fn) => {
        inputObservers.add(fn);
        return () => inputObservers.delete(fn);
      },
      reportError: (message) => setError("trace", message),
      resolveError: () => {
        if (resolveError("trace")) changed("session");
      },
    });
  }
  return {
    setTheme,
    setCursorPolicy,
    pasteText,
    async focus() {
      if (nativeFocused) return;
      let resolveFocus;
      const focused = new Promise((resolve) => {
        resolveFocus = resolve;
        focusWaiters.add(resolve);
      });
      try {
        await region.focus();
        if (!nativeFocused) await focused;
      } catch (error) {
        focusWaiters.delete(resolveFocus);
        throw error;
      }
    },
    async dispose() {
      const offTheme = await themeSubscription?.dispose;
      // 기본값: 테마나 설정 구독이 없으면 해제 함수도 없다.
      offTheme?.();
      // 기본값: 설정 구독이 없으면 해제 함수도 없다.
      settingsSubscription?.();
      textSizeSubscription();
      // 기본값: 사이드카 구독을 만들지 못한 경우에는 해제 함수가 없다.
      stopSidecar?.();
      view.removeEventListener("pointerdown", preventDefaultFocus);
      view.removeEventListener("pointerdown", beginSelection);
      view.removeEventListener("pointermove", updateSelection);
      view.removeEventListener("pointermove", hoverLink);
      view.removeEventListener("pointermove", hoverMouse);
      view.removeEventListener("pointerleave", hoverLink);
      view.removeEventListener("pointerup", endSelection);
      view.removeEventListener("wheel", scrollWheel);
      if (scrollbar) {
        scrollbar.thumb.removeEventListener("pointerdown", beginThumbDrag);
        scrollbar.thumb.removeEventListener("pointermove", moveThumb);
        scrollbar.thumb.removeEventListener("pointerup", endThumbDrag);
        scrollbar.thumb.removeEventListener("pointercancel", endThumbDrag);
      }
      view.removeEventListener("pointercancel", endSelection);
      view.removeEventListener("lostpointercapture", endSelection);
      await terminal.send(id, { operation: "close" });
    },
  };
}
