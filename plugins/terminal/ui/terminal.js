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
      text: text || "",
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

// macOS WebKit's Korean input source can emit compatibility jamo through insertText
// while the actual syllable is still delivered through setMarkedText. Those insertText
// events are not committed terminal input. They are consumed until the corresponding
// preedit is confirmed or cancelled.
function isHangulJamo(text) {
  if (typeof text !== "string" || text.length === 0) return false;
  for (const character of text) {
    const code = character.codePointAt(0);
    if (!((code >= 0x3131 && code <= 0x318e) || (code >= 0xffa0 && code <= 0xffdc))) return false;
  }
  return true;
}

const CURSOR_SHAPES = new Set(["block", "underline", "beam"]);
const CURSOR_BLINK_MODES = new Set(["Never", "Off", "On", "Always"]);
const CURSOR_UNFOCUSED = new Set(["hollow", "solid", "underline", "beam", "unchanged"]);
const PROGRAM_CLIPBOARD_POLICIES = new Set(["deny", "allow"]);
const DEFAULT_CURSOR = Object.freeze({
  row: 0, col: 0, shape: "block", visible: true, blinking: false, focused: false,
  blink: "Off", interval: 750, idleTimeout: 5000, unfocused: "hollow", hollow: false,
  blinkVisible: true,
});

function normalizeRange(range) {
  if (range === null || range === undefined) return null;
  if (!Number.isInteger(range.location) || !Number.isInteger(range.length) ||
      range.location < 0 || range.length < 0) return null;
  return { location: range.location, length: range.length };
}

function normalizeCursor(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("cursor must be an object");
  }
  const cursor = value;
  const rawShape = cursor.shape ?? DEFAULT_CURSOR.shape;
  const shapes = { block: "block", Block: "block", underline: "underline", Underline: "underline", beam: "beam", Beam: "beam", HollowBlock: "block", Hidden: "block" };
  if (typeof rawShape !== "string" || !Object.hasOwn(shapes, rawShape)) {
    throw new Error(`cursor.shape is invalid: ${String(rawShape)}`);
  }
  const shape = shapes[rawShape];
  const blink = cursor.blink ?? (cursor.blinking === true ? "On" : DEFAULT_CURSOR.blink);
  if (!CURSOR_BLINK_MODES.has(blink)) throw new Error(`cursor.blink is invalid: ${String(blink)}`);
  const integer = (field, fallback) => {
    if (cursor[field] === undefined) return fallback;
    if (!Number.isInteger(cursor[field]) || cursor[field] < 0) throw new Error(`cursor.${field} is invalid`);
    return cursor[field];
  };
  const number = (field, fallback) => {
    if (cursor[field] === undefined) return fallback;
    if (typeof cursor[field] !== "number" || !Number.isFinite(cursor[field]) || cursor[field] < 0) {
      throw new Error(`cursor.${field} is invalid`);
    }
    return cursor[field];
  };
  const boolean = (field, fallback) => {
    if (cursor[field] === undefined) return fallback;
    if (typeof cursor[field] !== "boolean") throw new Error(`cursor.${field} is invalid`);
    return cursor[field];
  };
  if (cursor.unfocused !== undefined && !CURSOR_UNFOCUSED.has(cursor.unfocused)) {
    throw new Error(`cursor.unfocused is invalid: ${String(cursor.unfocused)}`);
  }
  return {
    row: integer("row", DEFAULT_CURSOR.row),
    col: integer("col", DEFAULT_CURSOR.col),
    shape,
    visible: boolean("visible", rawShape === "Hidden" ? false : DEFAULT_CURSOR.visible),
    blinking: boolean("blinking", blink === "On" || blink === "Always"),
    focused: boolean("focused", DEFAULT_CURSOR.focused),
    blink,
    interval: number("interval", DEFAULT_CURSOR.interval),
    idleTimeout: number("idleTimeout", DEFAULT_CURSOR.idleTimeout),
    unfocused: cursor.unfocused ?? DEFAULT_CURSOR.unfocused,
    hollow: boolean("hollow", rawShape === "HollowBlock" || DEFAULT_CURSOR.hollow),
    blinkVisible: boolean("blinkVisible", DEFAULT_CURSOR.blinkVisible),
  };
}

function normalizeCursorPolicy(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("cursor policy must be an object");
  const shape = value.shape ?? DEFAULT_CURSOR.shape;
  if (!CURSOR_SHAPES.has(shape)) throw new Error(`cursor policy shape is invalid: ${String(shape)}`);
  const blink = value.blink ?? DEFAULT_CURSOR.blink;
  if (!CURSOR_BLINK_MODES.has(blink)) throw new Error(`cursor policy blink is invalid: ${String(blink)}`);
  const unfocused = value.unfocused ?? DEFAULT_CURSOR.unfocused;
  if (!CURSOR_UNFOCUSED.has(unfocused)) throw new Error(`cursor policy unfocused is invalid: ${String(unfocused)}`);
  const integer = (name, fallback, minimum) => {
    if (value[name] === undefined) return fallback;
    if (!Number.isInteger(value[name]) || value[name] < minimum) throw new Error(`cursor policy ${name} is invalid`);
    return value[name];
  };
  return {
    shape,
    blink,
    interval: integer("interval", DEFAULT_CURSOR.interval, 1),
    idleTimeout: integer("idleTimeout", DEFAULT_CURSOR.idleTimeout, 0),
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
  settings, clipboard, reportSurfaceError = () => {},
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

  // 현재 세션 상태
  let session = {
    sessionId: "", cols: 80, rows: 24, cellWidth: 8, cellHeight: 16, unsupported: [],
    inlineImages: [],
    vendor: { directory: null, hyperlink: null, notification: null, shell: null },
    compose: { text: "", selectedRange: null, replacementRange: null, attributed: false },
    theme: "dark",
  };
  let screen = [];
  let compose = session.compose;
  let pendingImeJamo = "";
  let cursor = { ...DEFAULT_CURSOR };
  const initialSettings = settings?.read?.() ?? {};
  let programClipboardPolicy = initialSettings["clipboard.program"] ?? "deny";
  if (!PROGRAM_CLIPBOARD_POLICIES.has(programClipboardPolicy)) {
    throw new Error(`clipboard.program setting is invalid: ${String(programClipboardPolicy)}`);
  }

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

  // 세션이 생겼는지 추적한다. 래스터 크기는 페이지가 아니라 호스트 configure가 정한다.
  let sessionOpen = false;
  let nativeFocused = false;
  const focusWaiters = new Set();

  let inputChain = Promise.resolve();
  const inputQueue = [];
  const MAX_QUEUE_SIZE = 1024;

  const reportInputError = (error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`terminal input failed: ${message}`);
    session = { ...session, error: `terminal input failed: ${message}` };
    changed("session");
  };

  const setTheme = async (mode) => {
    if (mode !== "dark" && mode !== "light") throw new Error(`terminal theme mode is invalid: ${String(mode)}`);
    await terminal.send(id, { operation: "theme", mode });
  };
  const setCursorPolicy = async (value) => {
    const policy = normalizeCursorPolicy(value);
    await terminal.send(id, { operation: "cursor", ...policy });
    cursor = {
      ...cursor,
      shape: policy.shape,
      blink: policy.blink,
      interval: policy.interval,
      idleTimeout: policy.idleTimeout,
      unfocused: policy.unfocused,
    };
    changed("cursor");
    return policy;
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
        selectedRange: entry.selectedRange ?? null,
        replacementRange: entry.replacementRange ?? null,
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

  const enqueueInput = (entry) => {
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
    // A WebKit Korean IME may echo both raw jamo and replacement syllables through
    // insertText. While a preedit is active, neither echo is a terminal commit.
    if (compose.text || pendingImeJamo || isHangulJamo(text)) {
      if (isHangulJamo(text)) pendingImeJamo += text;
      return;
    }
    await observeInput(enqueueInput({ type: "insert", text }));
  });

  // 영역 key 이벤트: 특수 키와 수정자
  // 사이드카는 키 이름만 받고 이스케이프 시퀀스를 생성한다
  onRegion("key", async (event) => {
    const { key, text, shift, alt, ctrl } = event;
    // 네이티브 영역은 항상 불린으로 수정자를 보낸다. 아니면 계약 위반이다.
    if (typeof shift !== "boolean" || typeof alt !== "boolean" || typeof ctrl !== "boolean") {
      const errorMsg = `invalid key event from region: modifiers must be boolean, got shift:${typeof shift} alt:${typeof alt} ctrl:${typeof ctrl}`;
      console.error(errorMsg);
      session = { ...session, error: errorMsg };
      changed("session");
      return;
    }
    await observeInput(enqueueInput({ type: "key", key, text, shift, alt, ctrl }));
  });

  onRegion("error", (event) => {
    const message = `native image: ${event.reason}`;
    console.error(message);
    const error = new Error(message);
    session = { ...session, error: message };
    changed("session");
    reportSurfaceError(error);
  });

  onRegion("compose", async (event) => {
    const previousText = compose.text;
    compose = {
      text: typeof event.text === "string" ? event.text : "",
      selectedRange: normalizeRange(event.selectedRange),
      replacementRange: normalizeRange(event.replacementRange),
      attributed: event.attributed === true,
    };
    session = { ...session, compose };
    changed("session");
    changed("compose");
    const composeRequest = enqueueInput({ type: "compose", ...compose });
    const commitRequest = compose.text === "" && previousText
      ? enqueueInput({ type: "insert", text: previousText })
      : null;
    if (compose.text === "") pendingImeJamo = "";
    await observeInput(composeRequest);
    if (commitRequest) await observeInput(commitRequest);
  });

  onRegion("command", async (event) => {
    if (typeof event.selector !== "string" || event.selector.length === 0) {
      reportInputError("native command event requires selector");
      return;
    }
    await observeInput(enqueueInput({ type: "command", selector: event.selector }));
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
  const selectionPoint = (event) => {
    const rect = view.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= rect.width || y >= rect.height) {
      throw new Error("terminal selection pointer is outside the view");
    }
    return { x, y };
  };
  const beginSelection = (event) => {
    if (event.button !== 0 || selectionPointerId !== null) return;
    try {
      const point = selectionPoint(event);
      selectionPointerId = event.pointerId;
      selectionStart = point;
      selectionStarted = false;
      view.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    } catch (error) {
      reportInputError(error);
    }
  };
  const updateSelection = (event) => {
    if (event.pointerId !== selectionPointerId) return;
    try {
      const point = selectionPoint(event);
      event.preventDefault();
      if (!selectionStarted) {
        if (point.x === selectionStart.x && point.y === selectionStart.y) return;
        selectionStarted = true;
        observeInput(terminal.send(id, { operation: "selection.start", ...selectionStart }));
      }
      observeInput(terminal.send(id, { operation: "selection.update", ...point }));
    } catch (error) {
      reportInputError(error);
    }
  };
  const endSelection = (event) => {
    if (event.pointerId !== selectionPointerId) return;
    selectionPointerId = null;
    const started = selectionStarted;
    selectionStart = null;
    selectionStarted = false;
    view.releasePointerCapture?.(event.pointerId);
    event.preventDefault();
    if (started) observeInput(terminal.send(id, { operation: "selection.end" }));
  };
  view.addEventListener("pointerdown", beginSelection);
  view.addEventListener("pointermove", updateSelection);
  view.addEventListener("pointerup", endSelection);
  view.addEventListener("pointercancel", endSelection);
  const dragOverFiles = (event) => {
    const types = [...(event.dataTransfer?.types ?? [])];
    if (types.includes("text/uri-list") || types.includes("Files")) event.preventDefault();
  };
  const dropFilesFromEvent = (event) => {
    event.preventDefault();
    try {
      const raw = event.dataTransfer?.getData?.("text/uri-list");
      if (typeof raw !== "string" || raw.trim().length === 0) {
        throw new Error("terminal file drop requires a text/uri-list payload");
      }
      const urls = raw.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
      observeInput(dropFiles({ urls }));
    } catch (error) {
      reportInputError(error);
    }
  };
  view.addEventListener("dragover", dragOverFiles);
  view.addEventListener("drop", dropFilesFromEvent);

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
        const errorMsg = `invalid state from sidecar: ${errorDetails.join("; ")}`;
        console.error(errorMsg);
        session = {
          ...session,
          error: errorMsg,
        };
        changed("session");
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
        error: session.error?.startsWith("native image:") ? session.error : undefined,
      };
      if (body.cursor !== undefined) {
        try {
          cursor = normalizeCursor({ ...cursor, ...body.cursor });
          changed("cursor");
          if (typeof region.setCaret === "function") {
            Promise.resolve(region.setCaret({
              x: cursor.col * body.cellWidth,
              y: cursor.row * body.cellHeight,
              width: body.cellWidth,
              height: body.cellHeight,
            })).catch(reportInputError);
          }
        } catch (error) {
          const message = `invalid cursor from sidecar: ${error.message}`;
          console.error(message);
          session = { ...session, error: message };
        }
      }
      sessionOpen = true;
      changed("session");
      flushInputQueue();
    } else if (body.event === "session") {
      if (typeof body.sessionId !== "string" || body.sessionId.length === 0) {
        reportInputError("invalid persistent session event");
        return;
      }
      session = { ...session, sessionId: body.sessionId, error: undefined };
      sessionOpen = true;
      changed("session");
    } else if (body.event === "screen") {
      // screen 이벤트를 처리한다. screen.read 응답이나 화면 변화 알림.
      screen = body.lines;
      changed("screen");
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
        reportInputError(new Error("invalid theme acknowledgement from sidecar"));
        return;
      }
      session = { ...session, theme: body.mode, error: undefined };
      changed("session");
    } else if (body.event === "clipboard.store") {
      handleClipboardStore(body).catch(reportInputError);
    } else if (body.event === "clipboard.query") {
      handleClipboardQuery(body).catch(reportInputError);
    } else if (body.event === "clipboard.rejected") {
      reportInputError(new Error(typeof body.reason === "string" ? body.reason : "program clipboard query rejected"));
    } else if (body.event === "selection.copy") {
      handleSelectionCopy(body).catch(reportInputError);
    } else if (body.event === "directory") {
      if (typeof body.uri !== "string" || body.uri.length === 0) {
        reportInputError(new Error("invalid directory event from sidecar"));
        return;
      }
      session = { ...session, vendor: { ...session.vendor, directory: body.uri } };
      changed("session");
    } else if (body.event === "hyperlink") {
      if (typeof body.id !== "string" || (body.uri !== null && typeof body.uri !== "string")) {
        reportInputError(new Error("invalid hyperlink event from sidecar"));
        return;
      }
      session = { ...session, vendor: { ...session.vendor, hyperlink: { id: body.id, uri: body.uri } } };
      changed("session");
    } else if (body.event === "notification") {
      if (typeof body.message !== "string" || body.message.length === 0) {
        reportInputError(new Error("invalid notification event from sidecar"));
        return;
      }
      session = { ...session, vendor: { ...session.vendor, notification: body.message } };
      changed("session");
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
    } else if (body.event === "error") {
      // error 이벤트를 session 상태에 저장한다
      const error = new Error(typeof body.reason === "string" ? body.reason : (typeof body.error === "string" ? body.error : "Unknown sidecar error"));
      session = {
        ...session,
        error: error.message,
      };
      changed("session");
      reportSurfaceError(error);
    } else if (body.error) {
      // 오류 응답 처리: {"error":"invalidParams","reason":"...",...}
      // reason 을 버리지 않고 오류에 실어 보낸다.
      const message = typeof body.reason === "string" ? `${body.error}: ${body.reason}` : body.error;
      const error = new Error(message);
      session = {
        ...session,
        error: message,
      };
      changed("session");
      reportSurfaceError(error);
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
  await terminal.send(id, { operation: "open", image: "view" });

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
      const request = setTheme(value.scheme);
      if (first) {
        first = false;
        return request.then(undefined, (error) => { reportInputError(error); throw error; });
      }
      return request.catch(reportInputError);
    });
    themeReady = Promise.resolve(themeSubscription?.ready ?? themeSubscription).catch((error) => {
      reportInputError(error);
      throw error;
    });
  }
  await themeReady;

  let settingsSubscription = null;
  const settingsPolicy = () => {
    const values = settings?.read?.() ?? {};
    return {
      shape: values["cursor.shape"],
      blink: values["cursor.blink"],
      interval: values["cursor.interval"],
      idleTimeout: values["cursor.idleTimeout"],
      unfocused: values["cursor.unfocused"],
    };
  };
  if (settings) {
    await setCursorPolicy(settingsPolicy());
    settingsSubscription = settings.on((values) => {
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
    });
  }

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
  await expose.command("terminal.cursor.set", async (policy) => setCursorPolicy(policy));
  await expose.command("terminal.paste", pasteText);
  await expose.command("terminal.drop", dropFiles);
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
      offTheme?.();
      settingsSubscription?.();
      stopSidecar?.();
      view.removeEventListener("pointerdown", preventDefaultFocus);
      view.removeEventListener("pointerdown", beginSelection);
      view.removeEventListener("pointermove", updateSelection);
      view.removeEventListener("pointerup", endSelection);
      view.removeEventListener("pointercancel", endSelection);
      view.removeEventListener("dragover", dragOverFiles);
      view.removeEventListener("drop", dropFilesFromEvent);
      await terminal.send(id, { operation: "close" });
    },
  };
}
