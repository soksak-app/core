import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createBinder } from "@soksak/plugin-api";
import * as terminalDiagnostics from "../ui/terminal-diagnostics.js";
import { startTerminal as realStartTerminal } from "../ui/terminal.js";

// 설정을 받지 않는 테스트의 터미널은 매니페스트 기본값과 /bin/sh 로 시작한다. 설정을 받는 테스트는 shell 값을 직접 적는다.
const SHELL_SETTINGS = {
  read: () => ({ ...Object.fromEntries(Object.entries(terminalManifest.settings).map(([key, { default: value }]) => [key, value])),
    shell: "/bin/sh" }),
  on: () => () => {},
};
const startTerminal = (options) => realStartTerminal({ id: "test-session", settings: SHELL_SETTINGS, ...options });
const terminalManifest = JSON.parse(readFileSync(new URL("../plugin.json", import.meta.url), "utf8"));

/**
 * 가짜 ResizeObserver 구현.
 */
function createFakeResizeObserverClass() {
  const observers = [];

  class FakeResizeObserver {
    constructor(callback) {
      this.callback = callback;
    }
    observe() {
      observers.push(this);
    }
    unobserve() {}
    disconnect() {}
  }

  FakeResizeObserver.triggerAll = function() {
    for (const observer of observers) {
      observer.callback();
    }
  };

  FakeResizeObserver.reset = function() {
    observers.length = 0;
  };

  return FakeResizeObserver;
}

const FakeResizeObserver = createFakeResizeObserverClass();

/**
 * 사이드카 state 이벤트로 세션을 연다.
 * 세션이 생기기 전에는 플러그인이 입력을 보내지 않으므로 입력 테스트는 이 함수로 시작한다.
 */
const openSession = (fakeSidecar) => {
  fakeSidecar.triggerEvent("test-session", { event: "state", sessionId: "s1", cols: 100, rows: 50, cellWidth: 8, cellHeight: 16 });
};

/**
 * 가짜 TextEncoder 구현.
 */
class FakeTextEncoder {
  encode(text) {
    if (typeof text !== "string") throw new Error("encode input must be string");
    const arr = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) {
      arr[i] = text.charCodeAt(i);
    }
    return arr;
  }
}

/**
 * 가짜 view 구현.
 */
function createFakeView() {
  const listeners = new Map();
  const parent = {
    bubbleCount: 0,
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { this.bubbleCount++; return true; },
  };
  const view = {
    ownerDocument: {
      location: { search: "?id=test-session" },
    },
    surfaceId: "test-session",
    clientWidth: 800,
    clientHeight: 600,
    getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 }; },
    style: {},
    setPointerCapture() {},
    releasePointerCapture() {},
    dataset: {},
    parentElement: parent,
    addEventListener(event, handler) { if (!listeners.has(event)) listeners.set(event, []); listeners.get(event).push(handler); },
    removeEventListener(event, handler) { listeners.set(event, (listeners.get(event) ?? []).filter((item) => item !== handler)); },
    _trigger: function(event, init = {}) {
      const nativeEvent = event instanceof Event ? event : new Event(event, { bubbles: true, cancelable: true });
      for (const [name, value] of Object.entries(init)) Object.defineProperty(nativeEvent, name, { value, configurable: true });
      for (const handler of [...(listeners.get(nativeEvent.type) ?? [])]) handler(nativeEvent);
      if (nativeEvent.bubbles && !nativeEvent.cancelBubble) parent.dispatchEvent(nativeEvent);
      return nativeEvent;
    },
    _parent: parent,
  };
  return view;
}

/**
 * 가짜 attachImage 구현.
 */
function createFakeAttachImage() {
  const attachCalls = [];
  let regionEventHandlers = {};

  return {
    function: function(view, name, sidecar) {
      attachCalls.push({ view, name, sidecar });

      return {
        on: function(eventType, handler) {
          if (!regionEventHandlers[eventType]) {
            regionEventHandlers[eventType] = [];
          }
          regionEventHandlers[eventType].push(handler);
          return function unsubscribe() {
            const idx = regionEventHandlers[eventType].indexOf(handler);
            if (idx >= 0) regionEventHandlers[eventType].splice(idx, 1);
          };
        },
        focus: async function() {
          return Promise.resolve();
        },
        setCaret: async function(rect) {
          this._caret = rect;
          return Promise.resolve();
        },
        _trigger: function(eventType, event) {
          if (regionEventHandlers[eventType]) {
            for (const handler of regionEventHandlers[eventType]) {
              handler(event);
            }
          }
        },
        _getHandlers: function() {
          return regionEventHandlers;
        },
      };
    },
    getCalls: () => attachCalls,
    // 네이티브 영역이 보고한 이벤트를 처리기에 전달하고 처리기의 결과를 모두 기다린다.
    trigger: (eventType, event) => Promise.all((regionEventHandlers[eventType] ?? []).map((handler) => handler(event))),
    reset: () => {
      attachCalls.length = 0;
      regionEventHandlers = {};
    },
  };
}

/**
 * 가짜 sidecar 구현.
 */
function createFakeSidecar() {
  const messages = [];
  const listeners = new Map();

  return {
    send: async function(id, body) {
      messages.push({ id, body });
      return Promise.resolve();
    },
    on: async function(id, handler) {
      if (!listeners.has(id)) {
        listeners.set(id, []);
      }
      listeners.get(id).push(handler);
      return Promise.resolve();
    },
    getMessages: () => messages,
    triggerEvent: function(id, event) {
      if (listeners.has(id)) {
        for (const handler of listeners.get(id)) {
          handler(event);
        }
      }
    },
    reset: () => {
      messages.length = 0;
      listeners.clear();
    },
  };
}

/**
 * 가짜 expose 구현.
 */
function createFakeExpose() {
  const statuses = new Map();
  const commands = new Map();
  const doms = new Map();
  const binds = [];

  const declared = new Set(terminalManifest.exposes.commands.map(({ name }) => name));
  const binder = createBinder((name, params) => {
    const command = commands.get(name);
    assert.ok(command, `command ${name} must be registered before binding`);
    return command(params);
  }, {
    check: (name) => { if (!declared.has(name)) throw new Error(`command ${name} is not declared`); },
  });

  return {
    status: async function(name, readFn, watchFn) {
      statuses.set(name, { readFn, watchFn });
      return Promise.resolve();
    },
    command: async function(name, handler) {
      commands.set(name, handler);
      return Promise.resolve();
    },
    dom: async function(name, element) {
      doms.set(name, element);
      return Promise.resolve();
    },
    bind: async function(...args) { binds.push(args); return binder.bind(...args); },
    mark: async function(...args) { return binder.mark(...args); },
    run: async function(name, params) { return binder.run(name, params); },
    dispose: async function() { binder.dispose(); },
    getStatus: (name) => statuses.get(name),
    getCommand: (name) => commands.get(name),
    getDom: (name) => doms.get(name),
    getStatuses: () => statuses,
    getCommands: () => commands,
    getDoms: () => doms,
    getBinds: () => binds,
    reset: () => {
      statuses.clear();
      commands.clear();
      doms.clear();
    },
  };
}

test("modified native character keys preserve their text before and after session open", async () => {
  const attach = createFakeAttachImage();
  const sidecar = createFakeSidecar();
  let region;
  await startTerminal({
    view: createFakeView(), attachImage: (...args) => (region = attach.function(...args)),
    sidecar, expose: createFakeExpose(),
    window: { TextEncoder: FakeTextEncoder },
  });
  const event = { key: "Char", text: "c", shift: false, alt: false, ctrl: true };
  region._trigger("key", event);
  openSession(sidecar);
  region._trigger("key", event);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sidecar.getMessages().filter(({ body }) => body.operation === "input").map(({ body }) => body.keys[0]),
    [event, event]);
});

test("native image errors remain visible after later session state updates", async () => {
  const attach = createFakeAttachImage();
  const sidecar = createFakeSidecar();
  const expose = createFakeExpose();
  let region;
  await startTerminal({
    view: createFakeView(), attachImage: (...args) => (region = attach.function(...args)), sidecar, expose,
    window: { TextEncoder: FakeTextEncoder },
  });
  openSession(sidecar);
  region._trigger("error", { reason: "size" });
  assert.equal(expose.getStatus("terminal.session").readFn().error, "native image: size");
  openSession(sidecar);
  assert.equal(expose.getStatus("terminal.session").readFn().error, "native image: size");
});

/** 오류 수명 검사용 터미널. 세션을 연 뒤 영역, 사이드카, 공개 항목을 반환한다. */
// 설정이 보내는 글꼴과 커서 정책을 뺀 세션 메시지. 글꼴과 커서 메시지는 각자의 테스트가 검사한다.
const sessionMessages = (sidecar) => sidecar.getMessages().filter(({ body }) => !["font", "cursor"].includes(body.operation));

async function errorTerminal() {
  const attach = createFakeAttachImage();
  const sidecar = createFakeSidecar();
  const expose = createFakeExpose();
  let region;
  await startTerminal({
    view: createFakeView(), attachImage: (...args) => (region = attach.function(...args)), sidecar, expose,
    window: { TextEncoder: FakeTextEncoder },
  });
  openSession(sidecar);
  const error = () => expose.getStatus("terminal.session").readFn().error;
  const emit = (event) => sidecar.triggerEvent("test-session", event);
  return { region, sidecar, expose, error, emit };
}

/* 다른 출처의 오류를 해소하는 이벤트들. 어느 것도 관련 없는 오류를 지우지 않는다. */
const UNRELATED_RESOLVERS = [
  ["state", { event: "state", sessionId: "s1", cols: 100, rows: 50, cellWidth: 8, cellHeight: 16 }],
  ["session", { event: "session", sessionId: "s1" }],
  ["theme", { event: "theme", mode: "light" }],
  ["screen", { event: "screen", lines: [""], cursor: { col: 0, row: 0, visible: true, focused: false, shape: "Block", blinking: false } }],
];

const PERSISTENT_ERRORS = [
  ["a sidecar error event", ({ emit }) => emit({ event: "error", reason: "pty failed" }), "pty failed"],
  ["a sidecar error reply", ({ emit }) => emit({ error: "invalidParams", reason: "bad size" }), "invalidParams: bad size"],
  ["a native image error", ({ region }) => region._trigger("error", { reason: "size" }), "native image: size"],
  ["an invalid native key event", ({ region }) => region._trigger("key", { key: "Char", text: "c", shift: 1, alt: false, ctrl: false }),
    "invalid key event from region: modifiers must be boolean, got shift:number alt:boolean ctrl:boolean"],
  ["an invalid clipboard rejection", ({ emit }) => emit({ event: "clipboard.rejected", reason: "denied" }), "terminal input failed: denied"],
];

for (const [name, raise, message] of PERSISTENT_ERRORS) {
  test(`${name} stays in terminal.session until the surface closes`, async () => {
    const terminal = await errorTerminal();
    raise(terminal);
    assert.equal(terminal.error(), message);
    for (const [kind, event] of UNRELATED_RESOLVERS) {
      terminal.emit(event);
      assert.equal(terminal.error(), message, `a ${kind} event hid ${name}`);
    }
  });
}

const RESOLVED_ERRORS = [
  ["state", { event: "state", cols: 0, rows: 50, cellWidth: 8, cellHeight: 16 },
    "invalid state from sidecar: cols: invalid value 0"],
  ["session", { event: "session", sessionId: "" }, "terminal input failed: invalid persistent session event"],
  ["theme", { event: "theme", mode: "sepia" }, "terminal input failed: invalid theme acknowledgement from sidecar"],
  ["screen", { event: "screen", lines: [""], cursor: { col: -0.5, row: 0, visible: true, focused: false, shape: "Block", blinking: false } },
    "terminal input failed: invalid screen cursor from sidecar: {\"col\":-0.5,\"row\":0,\"visible\":true,\"focused\":false,\"shape\":\"Block\",\"blinking\":false}"],
];

for (const [kind, invalid, message] of RESOLVED_ERRORS) {
  test(`an invalid ${kind} event error is cleared only by the next valid ${kind} event`, async () => {
    const terminal = await errorTerminal();
    terminal.emit(invalid);
    assert.equal(terminal.error(), message);
    for (const [other, event] of UNRELATED_RESOLVERS) {
      if (other === kind) continue;
      terminal.emit(event);
      assert.equal(terminal.error(), message, `a ${other} event hid the ${kind} error`);
    }
    terminal.emit(UNRELATED_RESOLVERS.find(([name]) => name === kind)[1]);
    assert.equal(terminal.error(), undefined, `a valid ${kind} event did not resolve its error`);
  });
}

test("resolving one error shows the most recent remaining error", async () => {
  const terminal = await errorTerminal();
  terminal.emit({ event: "error", reason: "pty failed" });
  terminal.emit({ event: "theme", mode: "sepia" });
  assert.equal(terminal.error(), "terminal input failed: invalid theme acknowledgement from sidecar");
  terminal.emit({ event: "theme", mode: "dark" });
  assert.equal(terminal.error(), "pty failed");
});

test("terminal.screen publishes sidecar output without polling or input commands", async () => {
  const sidecar = createFakeSidecar();
  const expose = createFakeExpose();
  await startTerminal({
    view: createFakeView(), attachImage: createFakeAttachImage().function, sidecar, expose,
    window: { TextEncoder: FakeTextEncoder },
  });
  const status = expose.getStatus("terminal.screen");
  assert.ok(status);
  assert.deepEqual(status.readFn(), []);
  const received = [];
  const stop = status.watchFn((value) => received.push(value));
  const lines = [[{ ch: "x", width: 1 }]];
  sidecar.triggerEvent("test-session", { event: "screen", lines });
  assert.deepEqual(status.readFn(), lines);
  assert.deepEqual(received, [lines]);
  stop();
  sidecar.triggerEvent("test-session", { event: "screen", lines: [] });
  assert.deepEqual(status.readFn(), []);
  assert.deepEqual(received, [lines]);
  assert.deepEqual(sessionMessages(sidecar).map(({ body }) => body.operation), ["open"]);
});

// 테스트 1: 부팅 → attachImage가 한 번 호출되고 sidecar에 open이 간다
test("Boot: attachImage called once and sidecar receives open message", async () => {
  FakeResizeObserver.reset();
  const fakeAttachImage = createFakeAttachImage();
  const fakeSidecar = createFakeSidecar();
  const fakeExpose = createFakeExpose();
  const fakeView = createFakeView();
  const fakeWindow = {
    ResizeObserver: FakeResizeObserver,
    TextEncoder: FakeTextEncoder,
    devicePixelRatio: 2,
  };

  await startTerminal({
    view: fakeView,
    attachImage: fakeAttachImage.function,
    sidecar: fakeSidecar,
    expose: fakeExpose,
    scale: 2,
    window: fakeWindow,
  });

  // attachImage가 정확히 한 번 호출되었는가?
  assert.equal(fakeAttachImage.getCalls().length, 1, "attachImage called once");
  const attachCall = fakeAttachImage.getCalls()[0];
  assert.equal(attachCall.name, "view", "attachImage called with name 'view'");
  assert.equal(attachCall.sidecar, undefined, "sidecar is resolved by the host composition");

  // sidecar에 open이 갔는가?
  const messages = fakeSidecar.getMessages();
  const openMessage = messages.find((m) => m.body.operation === "open");
  assert(openMessage, "open message sent to sidecar");
  assert.equal(openMessage.body.image, "view", "open message has image: 'view'");
  assert.equal("width" in openMessage.body, false, "DOM width is not sent");
  assert.equal("height" in openMessage.body, false, "DOM height is not sent");
  assert.equal("scale" in openMessage.body, false, "DOM scale is not sent");
});

// 테스트 2: 영역 insert{text:"ls\r"} → sidecar {operation:"input", bytes: base64("ls\r")}
test("Region insert event sends base64-encoded bytes to sidecar", async () => {
  FakeResizeObserver.reset();
  const fakeAttachImage = createFakeAttachImage();
  const fakeSidecar = createFakeSidecar();
  const fakeExpose = createFakeExpose();
  const fakeView = createFakeView();
  const fakeWindow = {
    ResizeObserver: FakeResizeObserver,
    TextEncoder: FakeTextEncoder,
    devicePixelRatio: 1,
  };

  const region = await startTerminal({
    view: fakeView,
    attachImage: fakeAttachImage.function,
    sidecar: fakeSidecar,
    expose: fakeExpose,
    scale: 1,
    window: fakeWindow,
  }).then(() => fakeAttachImage.function(fakeView, "view", "terminal-port"));

  // 실제 region 객체는 startTerminal이 내부에서 생성하므로, 여기서는
  // 이미 attach된 region으로부터 trigger한다
  const attachCalls = fakeAttachImage.getCalls();
  const attachRegion = attachCalls[0]; // 이미 attach된 region 정보

  // 재정의: 실제로는 startTerminal 내부에서 region이 생성되므로
  // 다시 테스트를 진행해야 한다

  fakeAttachImage.reset();
  fakeSidecar.reset();
  fakeExpose.reset();
  FakeResizeObserver.reset();

  let regionReference = null;
  const patchedAttachImage = function(view, name, sidecar) {
    const result = fakeAttachImage.function(view, name, sidecar);
    regionReference = result;
    return result;
  };

  await startTerminal({
    view: fakeView,
    attachImage: patchedAttachImage,
    sidecar: fakeSidecar,
    expose: fakeExpose,
    scale: 1,
    window: fakeWindow,
  });

  // ResizeObserver 콜백으로 open 을 보내고 state 이벤트로 세션을 연다
  openSession(fakeSidecar);

  // 이제 region에 insert 이벤트를 trigger한다
  regionReference._trigger("insert", { text: "ls\r" });
  await new Promise((resolve) => setImmediate(resolve));

  // sidecar 메시지를 확인한다
  const messages = fakeSidecar.getMessages();
  const inputMessage = messages.find((m) => m.body.operation === "input" && m.body.bytes);
  assert(inputMessage, "input message with bytes sent");

  // base64 디코딩하여 확인한다
  const decodedBytes = Buffer.from(inputMessage.body.bytes, "base64").toString("utf8");
  assert.equal(decodedBytes, "ls\r", "bytes correctly encode 'ls\\r'");
});

// 테스트 3: terminal.input 명령으로 {bytes:"ls\r"}를 보내면 테스트 2와 같은 본문이 간다
test("terminal.input command sends same body as region insert", async () => {
  FakeResizeObserver.reset();
  const fakeAttachImage = createFakeAttachImage();
  const fakeSidecar = createFakeSidecar();
  const fakeExpose = createFakeExpose();
  const fakeView = createFakeView();
  const fakeWindow = {
    ResizeObserver: FakeResizeObserver,
    TextEncoder: FakeTextEncoder,
    devicePixelRatio: 1,
  };

  await startTerminal({
    view: fakeView,
    attachImage: fakeAttachImage.function,
    sidecar: fakeSidecar,
    expose: fakeExpose,
    scale: 1,
    window: fakeWindow,
  });

  // ResizeObserver 콜백으로 open 을 보내고 state 이벤트로 세션을 연다
  openSession(fakeSidecar);

  // terminal.input 명령을 호출한다
  const inputCommand = fakeExpose.getCommand("terminal.input");
  assert(inputCommand, "terminal.input command registered");

  fakeSidecar.reset();
  await inputCommand({ bytes: "ls\r" });

  // sidecar 메시지를 확인한다
  const messages = fakeSidecar.getMessages();
  const inputMessage = messages.find((m) => m.body.operation === "input" && m.body.bytes);
  assert(inputMessage, "input message with bytes sent");

  const decodedBytes = Buffer.from(inputMessage.body.bytes, "base64").toString("utf8");
  assert.equal(decodedBytes, "ls\r", "command sends same encoding as region insert");
});

test("terminal.paste reads explicit user text once and sends one paste operation", async () => {
  FakeResizeObserver.reset();
  const fakeSidecar = createFakeSidecar();
  const fakeExpose = createFakeExpose();
  const clipboardCalls = [];
  const clipboard = {
    read: async (type) => {
      clipboardCalls.push(type);
      return "printf 'user paste'\n";
    },
  };
  await startTerminal({
    view: createFakeView(), attachImage: createFakeAttachImage().function,
    sidecar: fakeSidecar, expose: fakeExpose, clipboard,
    window: { TextEncoder: FakeTextEncoder },
  });
  openSession(fakeSidecar);
  fakeSidecar.reset();

  const paste = fakeExpose.getCommand("terminal.paste");
  assert.ok(paste, "terminal.paste command registered");
  await paste();

  assert.deepEqual(clipboardCalls, ["text"]);
  assert.deepEqual(fakeSidecar.getMessages().map(({ body }) => body.operation), ["paste"]);
  assert.equal(fakeSidecar.getMessages()[0].body.text, "printf 'user paste'\n");
});

test("a session opens the shell that the shell setting names", async () => {
  FakeResizeObserver.reset();
  const fakeSidecar = createFakeSidecar();
  await startTerminal({
    view: createFakeView(), attachImage: createFakeAttachImage().function,
    sidecar: fakeSidecar, expose: createFakeExpose(),
    settings: { read: () => ({ ...SHELL_SETTINGS.read(), shell: "login" }), on: () => () => {} },
    window: { TextEncoder: FakeTextEncoder },
  });
  const open = fakeSidecar.getMessages().find((message) => message.body.operation === "open");
  assert.deepEqual(open.body, { operation: "open", image: "view", shell: "login" });
});

test("a session without a shell setting is not opened", async () => {
  FakeResizeObserver.reset();
  const fakeSidecar = createFakeSidecar();
  await assert.rejects(startTerminal({
    view: createFakeView(), attachImage: createFakeAttachImage().function,
    sidecar: fakeSidecar, expose: createFakeExpose(),
    settings: { read: () => ({ ...SHELL_SETTINGS.read(), shell: undefined }), on: () => () => {} },
    window: { TextEncoder: FakeTextEncoder },
  }), /terminal shell setting is missing/);
  assert.equal(fakeSidecar.getMessages().some((message) => message.body.operation === "open"), false);
});

test("the region's paste action runs terminal.paste once", async () => {
  FakeResizeObserver.reset();
  const fakeSidecar = createFakeSidecar();
  const fakeExpose = createFakeExpose();
  const attach = createFakeAttachImage();
  const clipboardCalls = [];
  const clipboard = { read: async (type) => { clipboardCalls.push(type); return "echo pasted"; } };
  await startTerminal({
    view: createFakeView(), attachImage: attach.function,
    sidecar: fakeSidecar, expose: fakeExpose, clipboard,
    window: { TextEncoder: FakeTextEncoder },
  });
  openSession(fakeSidecar);
  fakeSidecar.reset();

  await attach.trigger("action", { type: "action", name: "paste" });

  assert.deepEqual(clipboardCalls, ["text"]);
  assert.deepEqual(fakeSidecar.getMessages().map(({ body }) => body.operation), ["paste"]);
  assert.equal(fakeSidecar.getMessages()[0].body.text, "echo pasted");
});

test("the region's copy action runs terminal.copy and writes the sidecar's selection text once", async () => {
  FakeResizeObserver.reset();
  const fakeSidecar = createFakeSidecar();
  const fakeExpose = createFakeExpose();
  const attach = createFakeAttachImage();
  const writes = [];
  const clipboard = { read: async () => null, writeText: async (text) => { writes.push(text); } };
  await startTerminal({
    view: createFakeView(), attachImage: attach.function,
    sidecar: fakeSidecar, expose: fakeExpose, clipboard,
    window: { TextEncoder: FakeTextEncoder },
  });
  openSession(fakeSidecar);
  // 이벤트 수신자는 남기고 보낸 메시지만 비운다.
  fakeSidecar.getMessages().length = 0;
  const releases = fakeExpose.getStatus("terminal.session").readFn().selectionReleases;

  await attach.trigger("action", { type: "action", name: "copy" });
  assert.deepEqual(sessionMessages(fakeSidecar).map(({ body }) => body.operation), ["copy"]);
  fakeSidecar.triggerEvent("test-session", { event: "copy", text: "chosen", userInitiated: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(writes, ["chosen"]);

  // 선택이 없으면 클립보드를 바꾸지 않으며 오류도 아니다.
  fakeSidecar.triggerEvent("test-session", { event: "copy", copied: false });
  await new Promise((resolve) => setImmediate(resolve));
  const session = fakeExpose.getStatus("terminal.session").readFn();
  assert.deepEqual(writes, ["chosen"]);
  assert.equal(session.error, undefined);
  assert.equal(session.selectionReleases, releases, "a copy is not a selection release");
});

test("wheel input is sent as whole scroll lines at the pointer cell and the screen reports scrollback", async () => {
  FakeResizeObserver.reset();
  const fakeSidecar = createFakeSidecar();
  const fakeExpose = createFakeExpose();
  const view = createFakeView();
  await startTerminal({
    view, attachImage: createFakeAttachImage().function,
    sidecar: fakeSidecar, expose: fakeExpose,
    window: { TextEncoder: FakeTextEncoder },
  });
  openSession(fakeSidecar);
  fakeSidecar.getMessages().length = 0;
  const scrolls = () => sessionMessages(fakeSidecar).filter(({ body }) => body.operation === "scroll").map(({ body }) => body);

  // 칸은 8x16 이다. 위로 48 픽셀은 오래된 출력 쪽 세 줄이다.
  const up = view._trigger("wheel", { deltaY: -48, deltaMode: 0, clientX: 20, clientY: 40 });
  assert.equal(up.defaultPrevented, true, "the wheel does not scroll the page");
  // 한 줄보다 작은 이동은 누적한다.
  view._trigger("wheel", { deltaY: 10, deltaMode: 0, clientX: 20, clientY: 40 });
  view._trigger("wheel", { deltaY: 10, deltaMode: 0, clientX: 20, clientY: 40 });
  view._trigger("wheel", { deltaY: 2, deltaMode: 1, clientX: 20, clientY: 40 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(scrolls(), [
    { operation: "scroll", lines: 3, col: 2, row: 2 },
    { operation: "scroll", lines: -1, col: 2, row: 2 },
    { operation: "scroll", lines: -2, col: 2, row: 2 },
  ]);

  fakeSidecar.triggerEvent("test-session", { event: "screen", lines: [""], cursor: { col: 0, row: 0, visible: false, focused: false, shape: "Block", blinking: false },
    scrollback: { offset: 3, history: 40 } });
  assert.deepEqual(fakeExpose.getStatus("terminal.session").readFn().scrollback, { offset: 3, history: 40 });
});

test("the scrollbar shows the scrollback position and dragging its thumb moves the viewport", async () => {
  FakeResizeObserver.reset();
  const fakeSidecar = createFakeSidecar();
  const fakeExpose = createFakeExpose();
  const track = Object.assign(createFakeView(), { style: {}, hidden: false });
  const thumb = Object.assign(createFakeView(), { style: {} });
  await startTerminal({
    view: createFakeView(), attachImage: createFakeAttachImage().function,
    sidecar: fakeSidecar, expose: fakeExpose, scrollbar: { track, thumb },
    window: { TextEncoder: FakeTextEncoder },
  });
  openSession(fakeSidecar);
  fakeSidecar.getMessages().length = 0;
  assert.equal(track.hidden, true, "the scrollbar is hidden without history");

  // 50행, 기록 50줄, 오프셋 25. 600 픽셀 트랙에서 손잡이는 높이 300, 위치 150 이다.
  const screen = (offset) => fakeSidecar.triggerEvent("test-session", { event: "screen", lines: [""],
    cursor: { col: 0, row: 0, visible: false, focused: false, shape: "Block", blinking: false }, scrollback: { offset, history: 50 } });
  screen(25);
  assert.equal(track.hidden, false);
  // 트랙은 네이티브 그림이 잘린 자리를 칠하므로 터미널의 현재 기본 배경색이어야 한다.
  fakeSidecar.triggerEvent("test-session", { event: "screen", lines: [""], background: "#102030",
    cursor: { col: 0, row: 0, visible: false, focused: false, shape: "Block", blinking: false }, scrollback: { offset: 25, history: 50 } });
  assert.equal(track.style.background, "#102030");
  assert.deepEqual([thumb.style.height, thumb.style.top], ["300px", "150px"]);

  thumb._trigger("pointerdown", { button: 0, pointerId: 4, clientX: 795, clientY: 160 });
  thumb._trigger("pointermove", { pointerId: 4, clientX: 795, clientY: 10 });
  thumb._trigger("pointermove", { pointerId: 4, clientX: 795, clientY: 460 });
  thumb._trigger("pointerup", { pointerId: 4, clientX: 795, clientY: 460 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sessionMessages(fakeSidecar).map(({ body }) => body), [
    { operation: "viewport", offset: 50 },
    { operation: "viewport", offset: 0 },
  ]);
  // 가장 새 출력에서도 기록이 있으면 보이며 손잡이는 트랙 맨 아래에 있다.
  screen(0);
  assert.equal(track.hidden, false);
  assert.deepEqual([thumb.style.height, thumb.style.top], ["300px", "300px"]);
  fakeSidecar.triggerEvent("test-session", { event: "screen", lines: [""], cursor: { col: 0, row: 0, visible: true, focused: false, shape: "Block", blinking: false },
    scrollback: { offset: 0, history: 0 } });
  assert.equal(track.hidden, true, "the scrollbar is hidden without history");
});

test("scrollbar settings set the track background, thumb color, width, and shape", async () => {
  FakeResizeObserver.reset();
  const fakeSidecar = createFakeSidecar();
  const fakeExpose = createFakeExpose();
  const track = Object.assign(createFakeView(), { style: {}, hidden: true });
  const thumb = Object.assign(createFakeView(), { style: {} });
  let values = {
    ...SHELL_SETTINGS.read(),
    "scrollbar.track": "terminal", "scrollbar.thumb": "#ff000080", "scrollbar.width": 16, "scrollbar.shape": "square",
  };
  let notify = null;
  await startTerminal({
    view: createFakeView(), attachImage: createFakeAttachImage().function,
    sidecar: fakeSidecar, expose: fakeExpose, scrollbar: { track, thumb },
    settings: { read: () => values, on: (listener) => { notify = listener; return () => {}; } },
    window: { TextEncoder: FakeTextEncoder },
  });
  openSession(fakeSidecar);
  fakeSidecar.triggerEvent("test-session", { event: "screen", lines: [""], background: "#102030",
    cursor: { col: 0, row: 0, visible: true, focused: false, shape: "Block", blinking: false }, scrollback: { offset: 0, history: 50 } });
  assert.deepEqual([track.style.width, track.style.background, thumb.style.background, thumb.style.borderRadius],
    ["16px", "#102030", "#ff000080", "0px"]);

  values = { ...values, "scrollbar.track": "#112233", "scrollbar.width": 8, "scrollbar.shape": "rounded" };
  notify(values);
  assert.deepEqual([track.style.width, track.style.background, thumb.style.borderRadius], ["8px", "#112233", "999px"]);

  // 잘못된 색은 입력 오류이며 적용하지 않는다.
  values = { ...values, "scrollbar.thumb": "red" };
  notify(values);
  assert.equal(thumb.style.background, "#ff000080");
  assert.match(fakeExpose.getStatus("terminal.session").readFn().error, /scrollbar.thumb/);
});

test("the region reports an unknown action as an input error", async () => {
  FakeResizeObserver.reset();
  const fakeSidecar = createFakeSidecar();
  const fakeExpose = createFakeExpose();
  const attach = createFakeAttachImage();
  await startTerminal({
    view: createFakeView(), attachImage: attach.function,
    sidecar: fakeSidecar, expose: fakeExpose,
    window: { TextEncoder: FakeTextEncoder },
  });
  openSession(fakeSidecar);
  fakeSidecar.reset();

  await attach.trigger("action", { type: "action", name: "print" });

  assert.match(fakeExpose.getStatus("terminal.session").readFn().error, /unknown native action: print/);
  assert.deepEqual(fakeSidecar.getMessages(), []);
});

test("terminal.paste rejects an absent clipboard without sending input", async () => {
  FakeResizeObserver.reset();
  const fakeSidecar = createFakeSidecar();
  const fakeExpose = createFakeExpose();
  const clipboard = { read: async () => null };
  await startTerminal({
    view: createFakeView(), attachImage: createFakeAttachImage().function,
    sidecar: fakeSidecar, expose: fakeExpose, clipboard,
    window: { TextEncoder: FakeTextEncoder },
  });
  openSession(fakeSidecar);
  fakeSidecar.reset();

  await assert.rejects(fakeExpose.getCommand("terminal.paste")(), /clipboard has no text, file, or PNG payload/);
  assert.deepEqual(fakeSidecar.getMessages(), []);
});

test("terminal.paste quotes file URLs without adding an executable newline", async () => {
  FakeResizeObserver.reset();
  const fakeSidecar = createFakeSidecar();
  const fakeExpose = createFakeExpose();
  const clipboardCalls = [];
  const clipboard = {
    read: async (type) => {
      clipboardCalls.push(type);
      if (type === "text") return null;
      if (type === "fileURLs") return ["file:///tmp/a%20b.txt", "file:///tmp/quote%27name.txt"];
      return null;
    },
  };
  await startTerminal({
    view: createFakeView(), attachImage: createFakeAttachImage().function,
    sidecar: fakeSidecar, expose: fakeExpose, clipboard,
    window: { TextEncoder: FakeTextEncoder },
  });
  openSession(fakeSidecar);
  fakeSidecar.reset();

  await fakeExpose.getCommand("terminal.paste")();

  assert.deepEqual(clipboardCalls, ["text", "fileURLs"]);
  assert.deepEqual(fakeSidecar.getMessages().map(({ body }) => body), [
    { operation: "paste", text: "'/tmp/a b.txt' '/tmp/quote'\\''name.txt'" },
  ]);
});

test("terminal.paste persists a PNG and sends its owned shell path once", async () => {
  FakeResizeObserver.reset();
  const fakeSidecar = createFakeSidecar();
  const fakeExpose = createFakeExpose();
  const clipboardCalls = [];
  const persisted = [];
  const clipboard = {
    read: async (type) => {
      clipboardCalls.push(type);
      return type === "png" ? new Uint8Array([0, 255, 1]) : null;
    },
    persistPNG: async (bytes) => {
      persisted.push([...bytes]);
      return { path: "/config/clipboard/pasted-image.png", shellQuotedPath: "'/config/clipboard/pasted-image.png'" };
    },
  };
  await startTerminal({
    view: createFakeView(), attachImage: createFakeAttachImage().function,
    sidecar: fakeSidecar, expose: fakeExpose, clipboard,
    window: { TextEncoder: FakeTextEncoder },
  });
  openSession(fakeSidecar);
  fakeSidecar.reset();

  await fakeExpose.getCommand("terminal.paste")();

  assert.deepEqual(clipboardCalls, ["text", "fileURLs", "png"]);
  assert.deepEqual(persisted, [[0, 255, 1]]);
  assert.deepEqual(fakeSidecar.getMessages().map(({ body }) => body), [
    { operation: "paste", text: "'/config/clipboard/pasted-image.png'" },
  ]);
});

test("terminal.paste rejects malformed file URLs and unavailable PNG persistence", async () => {
  for (const [kind, clipboard] of [
    ["file", { read: async (type) => type === "text" ? null : type === "fileURLs" ? ["https://example.invalid/file"] : null }],
    ["PNG", { read: async (type) => type === "png" ? new Uint8Array([1]) : null }],
  ]) {
    FakeResizeObserver.reset();
    const fakeSidecar = createFakeSidecar();
    const fakeExpose = createFakeExpose();
    await startTerminal({
      view: createFakeView(), attachImage: createFakeAttachImage().function,
      sidecar: fakeSidecar, expose: fakeExpose, clipboard,
      window: { TextEncoder: FakeTextEncoder },
    });
    openSession(fakeSidecar);
    fakeSidecar.reset();
    await assert.rejects(fakeExpose.getCommand("terminal.paste")(), kind === "file" ? /not local/ : /persistence is unavailable/);
    assert.deepEqual(fakeSidecar.getMessages(), []);
  }
});

test("terminal file drop quotes local URLs and sends one non-executing paste", async () => {
  FakeResizeObserver.reset();
  const fakeSidecar = createFakeSidecar();
  const fakeExpose = createFakeExpose();
  const fakeView = createFakeView();
  await startTerminal({
    view: fakeView, attachImage: createFakeAttachImage().function,
    sidecar: fakeSidecar, expose: fakeExpose, clipboard: { read: async () => null },
    window: { TextEncoder: FakeTextEncoder },
  });
  openSession(fakeSidecar);
  fakeSidecar.reset();

  await fakeExpose.getCommand("terminal.drop")({ urls: ["file:///tmp/dropped%20file.txt", "file:///tmp/quote%27name.txt"] });

  assert.deepEqual(fakeSidecar.getMessages().map(({ body }) => body), [
    { operation: "paste", text: "'/tmp/dropped file.txt' '/tmp/quote'\\''name.txt'" },
  ]);
});

test("terminal file drop rejects unsupported or malformed payloads without input", async () => {
  FakeResizeObserver.reset();
  const fakeSidecar = createFakeSidecar();
  const fakeExpose = createFakeExpose();
  const fakeView = createFakeView();
  await startTerminal({
    view: fakeView, attachImage: createFakeAttachImage().function,
    sidecar: fakeSidecar, expose: fakeExpose, clipboard: { read: async () => null },
    window: { TextEncoder: FakeTextEncoder },
  });
  openSession(fakeSidecar);
  fakeSidecar.reset();

  await assert.rejects(fakeExpose.getCommand("terminal.drop")({ urls: ["https://example.invalid/file"] }), /not local/);
  await assert.rejects(fakeExpose.getCommand("terminal.drop")({ urls: [] }), /no file URLs/);
  await assert.rejects(fakeExpose.getCommand("terminal.drop")({}), /no file URLs/);

  assert.deepEqual(fakeSidecar.getMessages(), []);
});

test("program clipboard queries are explicitly denied and do not remain pending", async () => {
  FakeResizeObserver.reset();
  const fakeSidecar = createFakeSidecar();
  const fakeExpose = createFakeExpose();
  await startTerminal({
    view: createFakeView(), attachImage: createFakeAttachImage().function,
    sidecar: fakeSidecar, expose: fakeExpose, clipboard: { read: async () => "secret" },
    window: { TextEncoder: FakeTextEncoder },
  });
  openSession(fakeSidecar);

  fakeSidecar.triggerEvent("test-session", { event: "clipboard.query", requestId: 7, selection: "clipboard" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(fakeSidecar.getMessages().filter(({ body }) => body.operation === "clipboard.reject").map(({ body }) => body), [
    { operation: "clipboard.reject", requestId: 7, reason: "program clipboard query denied by policy" },
  ]);
});

test("allowed program clipboard handles only text through the host capability", async () => {
  FakeResizeObserver.reset();
  const fakeSidecar = createFakeSidecar();
  const fakeExpose = createFakeExpose();
  const writes = [];
  const settings = { read: () => ({ ...SHELL_SETTINGS.read(), "clipboard.program": "allow" }), on: () => () => {} };
  const clipboard = {
    read: async (type) => { assert.equal(type, "text"); return "from host"; },
    writeText: async (text) => { writes.push(text); },
  };
  await startTerminal({
    view: createFakeView(), attachImage: createFakeAttachImage().function,
    sidecar: fakeSidecar, expose: fakeExpose, settings, clipboard,
    window: { TextEncoder: FakeTextEncoder },
  });
  openSession(fakeSidecar);
  fakeSidecar.triggerEvent("test-session", { event: "clipboard.store", selection: "clipboard", text: "program copy" });
  fakeSidecar.triggerEvent("test-session", { event: "clipboard.query", requestId: 8, selection: "clipboard" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(writes, ["program copy"]);
  assert.deepEqual(fakeSidecar.getMessages().filter(({ body }) => body.operation === "clipboard.resolve").map(({ body }) => body), [
    { operation: "clipboard.resolve", requestId: 8, text: "from host" },
  ]);
});

test("user selection copy writes non-empty text independently of program clipboard policy", async () => {
  FakeResizeObserver.reset();
  const fakeSidecar = createFakeSidecar();
  const fakeExpose = createFakeExpose();
  const writes = [];
  const clipboard = { writeText: async (text) => writes.push(text) };
  await startTerminal({
    view: createFakeView(), attachImage: createFakeAttachImage().function,
    sidecar: fakeSidecar, expose: fakeExpose, clipboard,
    window: { TextEncoder: FakeTextEncoder },
  });
  openSession(fakeSidecar);

  fakeSidecar.triggerEvent("test-session", { event: "selection.copy", userInitiated: true, text: "selected text" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(writes, ["selected text"]);
});

test("selection copy rejects non-user or empty payloads without writing", async () => {
  FakeResizeObserver.reset();
  const fakeSidecar = createFakeSidecar();
  const fakeExpose = createFakeExpose();
  const writes = [];
  const clipboard = { writeText: async (text) => writes.push(text) };
  await startTerminal({
    view: createFakeView(), attachImage: createFakeAttachImage().function,
    sidecar: fakeSidecar, expose: fakeExpose, clipboard,
    window: { TextEncoder: FakeTextEncoder },
  });
  openSession(fakeSidecar);

  fakeSidecar.triggerEvent("test-session", { event: "selection.copy", userInitiated: false, text: "secret" });
  fakeSidecar.triggerEvent("test-session", { event: "selection.copy", userInitiated: true, text: "" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(writes, []);
  assert.match(fakeExpose.getStatus("terminal.session").readFn().error, /selection.copy/);
});

test("a selection release without text is accepted without a copy or an error", async () => {
  FakeResizeObserver.reset();
  const fakeSidecar = createFakeSidecar();
  const fakeExpose = createFakeExpose();
  const writes = [];
  const clipboard = { writeText: async (text) => writes.push(text) };
  await startTerminal({
    view: createFakeView(), attachImage: createFakeAttachImage().function,
    sidecar: fakeSidecar, expose: fakeExpose, clipboard,
    window: { TextEncoder: FakeTextEncoder },
  });
  openSession(fakeSidecar);

  fakeSidecar.triggerEvent("test-session", { event: "selection.end", copied: false });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(writes, []);
  const state = fakeExpose.getStatus("terminal.session").readFn();
  assert.equal(state.error, undefined);
  assert.ok(!state.unsupported.includes("selection.end"), "selection.end is a declared event");
  assert.equal(state.selectionReleases, 1, "the answered release is counted");
});

test("sidecar acknowledgements of selection and paste operations are not unsupported events", async () => {
  FakeResizeObserver.reset();
  const fakeSidecar = createFakeSidecar();
  const fakeExpose = createFakeExpose();
  await startTerminal({
    view: createFakeView(), attachImage: createFakeAttachImage().function,
    sidecar: fakeSidecar, expose: fakeExpose,
    window: { TextEncoder: FakeTextEncoder },
  });
  openSession(fakeSidecar);

  for (const event of ["selection.start", "selection.update", "paste"]) {
    fakeSidecar.triggerEvent("test-session", { ack: true, event });
  }
  await new Promise((resolve) => setImmediate(resolve));
  const state = fakeExpose.getStatus("terminal.session").readFn();
  assert.deepEqual(state.unsupported, []);
  assert.equal(state.error, undefined);
});

// 테스트 4: 영역 key(Enter) → {operation:"input", keys:[{key:"Enter"}]}
test("Region key event for Enter sends correct message format", async () => {
  FakeResizeObserver.reset();
  const fakeAttachImage = createFakeAttachImage();
  const fakeSidecar = createFakeSidecar();
  const fakeExpose = createFakeExpose();
  const fakeView = createFakeView();
  const fakeWindow = {
    ResizeObserver: FakeResizeObserver,
    TextEncoder: FakeTextEncoder,
    devicePixelRatio: 1,
  };

  let regionReference = null;
  const patchedAttachImage = function(view, name, sidecar) {
    const result = fakeAttachImage.function(view, name, sidecar);
    regionReference = result;
    return result;
  };

  await startTerminal({
    view: fakeView,
    attachImage: patchedAttachImage,
    sidecar: fakeSidecar,
    expose: fakeExpose,
    scale: 1,
    window: fakeWindow,
  });

  // ResizeObserver 콜백으로 open 을 보내고 state 이벤트로 세션을 연다
  openSession(fakeSidecar);

  fakeSidecar.reset();
  regionReference._trigger("key", { key: "Enter", shift: false, alt: false, ctrl: false });
  await new Promise((resolve) => setImmediate(resolve));

  const messages = fakeSidecar.getMessages();
  const keyMessage = messages.find((m) => m.body.operation === "input" && m.body.keys);
  assert(keyMessage, "key message sent");
  assert.deepEqual(keyMessage.body.keys[0], {
    key: "Enter",
    text: "",
    shift: false,
    alt: false,
    ctrl: false,
  }, "Enter key formatted correctly");
});

// 테스트 4b: 영역 key(ArrowUp) → {operation:"input", keys:[{key:"Up"}]}
test("Region key event for ArrowUp sends Up key (no escape sequences)", async () => {
  FakeResizeObserver.reset();
  const fakeAttachImage = createFakeAttachImage();
  const fakeSidecar = createFakeSidecar();
  const fakeExpose = createFakeExpose();
  const fakeView = createFakeView();
  const fakeWindow = {
    ResizeObserver: FakeResizeObserver,
    TextEncoder: FakeTextEncoder,
    devicePixelRatio: 1,
  };

  let regionReference = null;
  const patchedAttachImage = function(view, name, sidecar) {
    const result = fakeAttachImage.function(view, name, sidecar);
    regionReference = result;
    return result;
  };

  await startTerminal({
    view: fakeView,
    attachImage: patchedAttachImage,
    sidecar: fakeSidecar,
    expose: fakeExpose,
    scale: 1,
    window: fakeWindow,
  });

  // ResizeObserver 콜백으로 open 을 보내고 state 이벤트로 세션을 연다
  openSession(fakeSidecar);

  fakeSidecar.reset();
  regionReference._trigger("key", { key: "Up", shift: false, alt: false, ctrl: false });
  await new Promise((resolve) => setImmediate(resolve));

  const messages = fakeSidecar.getMessages();
  const keyMessage = messages.find((m) => m.body.operation === "input" && m.body.keys);
  assert(keyMessage, "key message sent");
  assert.deepEqual(keyMessage.body.keys[0].key, "Up", "Up key sent");
  // 중요: 이스케이프 시퀀스가 없어야 한다
  const allMessages = messages.map((m) => m.body);
  for (const body of allMessages) {
    if (body.bytes) {
      const decoded = Buffer.from(body.bytes, "base64").toString("utf8");
      assert.notMatch(decoded, /\x1b\[/, "no escape sequences in messages");
    }
  }
});

test("terminal focus remains a command owned by the card, not a second pointerdown binder", async () => {
  FakeResizeObserver.reset();
  const fakeAttachImage = createFakeAttachImage();
  const fakeSidecar = createFakeSidecar();
  const fakeExpose = createFakeExpose();
  const fakeView = createFakeView();
  const fakeWindow = {
    ResizeObserver: FakeResizeObserver,
    TextEncoder: FakeTextEncoder,
    devicePixelRatio: 1,
  };

  const patchedAttachImage = function(view, name, sidecar) {
    const result = fakeAttachImage.function(view, name, sidecar);
    return result;
  };

  await startTerminal({
    view: fakeView,
    attachImage: patchedAttachImage,
    sidecar: fakeSidecar,
    expose: fakeExpose,
    scale: 1,
    window: fakeWindow,
  });

  assert.equal(fakeExpose.getBinds().length, 0,
    "terminal must not bind pointerdown to focus because the card owns that gesture");
  assert.equal(typeof fakeExpose.getCommand("terminal.focus"), "function",
    "terminal.focus remains available for the card focus command");
});

test("terminal pointerdown prevents DOM focus and still bubbles to the card", async () => {
  FakeResizeObserver.reset();
  const attach = createFakeAttachImage();
  const expose = createFakeExpose();
  const view = createFakeView();
  await startTerminal({
    view, attachImage: (...args) => {
      return attach.function(...args);
    },
    sidecar: createFakeSidecar(), expose, window: { TextEncoder: FakeTextEncoder },
  });

  const event = view._trigger("pointerdown");
  assert.equal(event.defaultPrevented, true);
  assert.equal(view._parent.bubbleCount, 1);
  assert.equal(expose.getBinds().length, 0);
});

test("terminal pointer drag sends one complete selection gesture to the sidecar", async () => {
  FakeResizeObserver.reset();
  const fakeSidecar = createFakeSidecar();
  const fakeExpose = createFakeExpose();
  const view = createFakeView();
  await startTerminal({
    view, attachImage: createFakeAttachImage().function,
    sidecar: fakeSidecar, expose: fakeExpose,
    window: { TextEncoder: FakeTextEncoder },
  });
  openSession(fakeSidecar);
  fakeSidecar.reset();

  view._trigger("pointerdown", { button: 0, pointerId: 4, clientX: 10, clientY: 12 });
  view._trigger("pointermove", { pointerId: 4, clientX: 42, clientY: 12 });
  view._trigger("pointerup", { pointerId: 4, clientX: 42, clientY: 12 });
  await new Promise((resolve) => setImmediate(resolve));

  // 포인터 입력은 mouse 로도 알린다. 뗌은 선택 연산 뒤에 온다.
  assert.deepEqual(fakeSidecar.getMessages().map(({ body }) => body.operation === "mouse" ? `mouse.${body.phase}` : body.operation), [
    "mouse.down", "mouse.move", "selection.start", "selection.update", "selection.end", "mouse.up",
  ]);
  const messages = fakeSidecar.getMessages().map(({ body }) => body);
  assert.deepEqual(messages[0], { operation: "mouse", phase: "down", x: 10, y: 12, pressed: true, shift: false, alt: false, ctrl: false });
  assert.deepEqual(messages[1], { operation: "mouse", phase: "move", x: 42, y: 12, pressed: true, shift: false, alt: false, ctrl: false });
  assert.equal(messages[2].x, 10);
  assert.equal(messages[3].x, 42);
  assert.deepEqual(messages[5], { operation: "mouse", phase: "up", x: 42, y: 12, pressed: false, shift: false, alt: false, ctrl: false });
});

test("a lost pointer capture resets terminal drag ownership for the next card focus", async () => {
  FakeResizeObserver.reset();
  const fakeSidecar = createFakeSidecar();
  const fakeExpose = createFakeExpose();
  const view = createFakeView();
  await startTerminal({
    view, attachImage: createFakeAttachImage().function,
    sidecar: fakeSidecar, expose: fakeExpose,
    window: { TextEncoder: FakeTextEncoder },
  });
  openSession(fakeSidecar);
  fakeSidecar.reset();

  view._trigger("pointerdown", { button: 0, pointerId: 4, clientX: 10, clientY: 12 });
  view._trigger("pointermove", { pointerId: 4, clientX: 42, clientY: 12 });
  view._trigger("lostpointercapture", { pointerId: 4, clientX: 42, clientY: 12 });
  view._trigger("pointerdown", { button: 0, pointerId: 5, clientX: 18, clientY: 20 });
  view._trigger("pointermove", { pointerId: 5, clientX: 50, clientY: 20 });
  view._trigger("pointerup", { pointerId: 5, clientX: 50, clientY: 20 });
  await new Promise((resolve) => setImmediate(resolve));

  const mouse = fakeSidecar.getMessages().filter(({ body }) => body.operation === "mouse");
  assert.deepEqual(mouse.map(({ body }) => `${body.phase}.${body.pressed}`), [
    "down.true", "move.true", "up.false", "down.true", "move.true", "up.false",
  ]);
});

test("a drag that leaves the view selects to the nearest edge point", async () => {
  FakeResizeObserver.reset();
  const fakeSidecar = createFakeSidecar();
  const fakeExpose = createFakeExpose();
  const view = createFakeView();
  await startTerminal({
    view, attachImage: createFakeAttachImage().function,
    sidecar: fakeSidecar, expose: fakeExpose,
    window: { TextEncoder: FakeTextEncoder },
  });
  openSession(fakeSidecar);
  fakeSidecar.getMessages().length = 0;

  view._trigger("pointerdown", { button: 0, pointerId: 9, clientX: 44, clientY: 20 });
  view._trigger("pointermove", { pointerId: 9, clientX: -30, clientY: 20 });
  view._trigger("pointermove", { pointerId: 9, clientX: 900, clientY: 700 });
  view._trigger("pointerup", { pointerId: 9, clientX: -30, clientY: -5 });
  await new Promise((resolve) => setImmediate(resolve));

  const selection = sessionMessages(fakeSidecar).filter(({ body }) => body.operation.startsWith("selection."))
    .map(({ body }) => body);
  // 뷰는 800x600 이다. 뷰 밖의 점은 뷰 안의 가장 가까운 점이 된다.
  assert.deepEqual(selection, [
    { operation: "selection.start", x: 44, y: 20 },
    { operation: "selection.update", x: 0, y: 20 },
    { operation: "selection.update", x: 799, y: 599 },
    { operation: "selection.end" },
  ]);
  assert.equal(fakeExpose.getStatus("terminal.session").readFn().error, undefined);
});

test("a terminal click clears the selection with an empty selection at the pressed cell", async () => {
  FakeResizeObserver.reset();
  const fakeSidecar = createFakeSidecar();
  const fakeExpose = createFakeExpose();
  const view = createFakeView();
  await startTerminal({
    view, attachImage: createFakeAttachImage().function,
    sidecar: fakeSidecar, expose: fakeExpose,
    window: { TextEncoder: FakeTextEncoder },
  });
  openSession(fakeSidecar);
  fakeSidecar.reset();

  view._trigger("pointerdown", { button: 0, pointerId: 8, clientX: 10, clientY: 12 });
  view._trigger("pointerup", { pointerId: 8, clientX: 10, clientY: 12 });
  await new Promise((resolve) => setImmediate(resolve));

  // 빈 선택의 뗌은 이전 선택을 지운다(docs/spec/terminal-runtime.md). 움직이지 않은 클릭은 그 뗌을 보내야 한다.
  assert.deepEqual(fakeSidecar.getMessages().map((message) => message.body.operation).filter((operation) => operation !== "mouse"),
    ["selection.start", "selection.end"], "a click must end an empty selection so that the previous selection is cleared");
  assert.equal(fakeSidecar.getMessages().find((message) => message.body.operation === "selection.start").body.x, 10);
});

test("terminal.focus command reports focus rejection through terminal.session", { timeout: 10000 }, async () => {
  FakeResizeObserver.reset();
  const attach = createFakeAttachImage();
  const expose = createFakeExpose();
  const view = createFakeView();
  let region;
  await startTerminal({
    view, attachImage: (...args) => {
      region = attach.function(...args);
      region.focus = async () => { throw new Error("focus rejected"); };
      return region;
    },
    sidecar: createFakeSidecar(), expose, window: { TextEncoder: FakeTextEncoder },
  });

  await assert.rejects(expose.getCommand("terminal.focus")(), /focus rejected/);
  assert.match(expose.getStatus("terminal.session").readFn().error, /terminal input failed: focus rejected/);
});

// 테스트 6: terminal.screen.read → sidecar에 screen.read가 가고, 가짜가 screen 이벤트로 답하면 줄 텍스트 배열이 돌아온다
test("terminal.screen.read sends request and returns lines on screen event", async () => {
  FakeResizeObserver.reset();
  const fakeAttachImage = createFakeAttachImage();
  const fakeSidecar = createFakeSidecar();
  const fakeExpose = createFakeExpose();
  const fakeView = createFakeView();
  const fakeWindow = {
    ResizeObserver: FakeResizeObserver,
    TextEncoder: FakeTextEncoder,
    devicePixelRatio: 1,
  };

  let regionReference = null;
  const patchedAttachImage = function(view, name, sidecar) {
    const result = fakeAttachImage.function(view, name, sidecar);
    regionReference = result;
    return result;
  };

  await startTerminal({
    view: fakeView,
    attachImage: patchedAttachImage,
    sidecar: fakeSidecar,
    expose: fakeExpose,
    scale: 1,
    window: fakeWindow,
  });

  // ResizeObserver 콜백을 호출하여 open을 전송한다
  FakeResizeObserver.triggerAll();

  const screenReadCommand = fakeExpose.getCommand("terminal.screen.read");
  assert(screenReadCommand, "terminal.screen.read command registered");

  // 비동기로 sidecar screen event를 trigger하자 (지금은 region이 아니라 sidecar에서 온다)
  setTimeout(() => {
    fakeSidecar.triggerEvent("test-session", { event: "screen", lines: ["line1", "line2", "line3"] });
  }, 10);

  const lines = await screenReadCommand();
  assert.deepEqual(lines, ["line1", "line2", "line3"], "screen.read returns lines from sidecar screen event");

  // sidecar에 screen.read가 갔는가?
  const messages = fakeSidecar.getMessages();
  const screenReadMessage = messages.find((m) => m.body.operation === "screen.read");
  assert(screenReadMessage, "screen.read message sent to sidecar");
});

// 테스트 7: sidecar state event → terminal.session 상태가 그 값을 갖는다
test("Sidecar state event updates terminal.session status", async () => {
  FakeResizeObserver.reset();
  const fakeAttachImage = createFakeAttachImage();
  const fakeSidecar = createFakeSidecar();
  const fakeExpose = createFakeExpose();
  const fakeView = createFakeView();
  const fakeWindow = {
    ResizeObserver: FakeResizeObserver,
    TextEncoder: FakeTextEncoder,
    devicePixelRatio: 1,
  };

  await startTerminal({
    view: fakeView,
    attachImage: fakeAttachImage.function,
    sidecar: fakeSidecar,
    expose: fakeExpose,
    scale: 1,
    window: fakeWindow,
  });

  // ResizeObserver 콜백을 호출하여 open을 전송한다
  FakeResizeObserver.triggerAll();

  const sessionStatus = fakeExpose.getStatus("terminal.session");
  assert(sessionStatus, "terminal.session status registered");

  // 초기값
  const initialSession = sessionStatus.readFn();
  assert.equal(initialSession.cols, 80, "default cols is 80");
  assert.equal(initialSession.rows, 24, "default rows is 24");

  // sidecar에서 state 이벤트를 보낸다
  fakeSidecar.triggerEvent("test-session", {
    event: "state",
    sessionId: "x",
    cols: 100,
    rows: 30,
    cellWidth: 8,
    cellHeight: 16,
  });

  // 상태가 업데이트되었는가?
  const updatedSession = sessionStatus.readFn();
  assert.equal(updatedSession.sessionId, "x", "sessionId updated");
  assert.equal(updatedSession.cols, 100, "cols updated");
  assert.equal(updatedSession.rows, 30, "rows updated");
});

// 테스트 7-1: resize 응답 state 이벤트(셀 크기 포함)는 오류 없이 상태를 갱신한다
test("Resize state event with cell dimensions updates session without error", async () => {
  FakeResizeObserver.reset();
  const fakeAttachImage = createFakeAttachImage();
  const fakeSidecar = createFakeSidecar();
  const fakeExpose = createFakeExpose();
  const fakeView = createFakeView();
  const fakeWindow = {
    ResizeObserver: FakeResizeObserver,
    TextEncoder: FakeTextEncoder,
    devicePixelRatio: 1,
  };

  await startTerminal({
    view: fakeView,
    attachImage: fakeAttachImage.function,
    sidecar: fakeSidecar,
    expose: fakeExpose,
    scale: 1,
    window: fakeWindow,
  });

  FakeResizeObserver.triggerAll();

  const sessionStatus = fakeExpose.getStatus("terminal.session");

  // resize 이후 사이드카가 보내는 state 이벤트 형태
  fakeSidecar.triggerEvent("test-session", {
    event: "state",
    sessionId: "test-session",
    cols: 120,
    rows: 40,
    cellWidth: 8,
    cellHeight: 16,
  });

  const resizedSession = sessionStatus.readFn();
  assert.equal(resizedSession.cols, 120, "cols updated by resize state event");
  assert.equal(resizedSession.rows, 40, "rows updated by resize state event");
  assert.equal(resizedSession.error, undefined, "resize state event must not set an error");

  // 셀 크기가 없는 state 이벤트는 오류로 나타난다
  fakeSidecar.triggerEvent("test-session", {
    event: "state",
    sessionId: "test-session",
    cols: 100,
    rows: 30,
  });

  const invalidSession = sessionStatus.readFn();
  assert.ok(
    typeof invalidSession.error === "string" && invalidSession.error.includes("cellWidth"),
    "state event without cellWidth reports an error"
  );
});

// 테스트 8: terminal.close → sidecar {operation:"close"} 한 번
test("terminal.close sends close message to sidecar", async () => {
  FakeResizeObserver.reset();
  const fakeAttachImage = createFakeAttachImage();
  const fakeSidecar = createFakeSidecar();
  const fakeExpose = createFakeExpose();
  const fakeView = createFakeView();
  const fakeWindow = {
    ResizeObserver: FakeResizeObserver,
    TextEncoder: FakeTextEncoder,
    devicePixelRatio: 1,
  };

  await startTerminal({
    view: fakeView,
    attachImage: fakeAttachImage.function,
    sidecar: fakeSidecar,
    expose: fakeExpose,
    scale: 1,
    window: fakeWindow,
  });

  // ResizeObserver 콜백을 호출하여 open을 전송한다
  FakeResizeObserver.triggerAll();

  const closeCommand = fakeExpose.getCommand("terminal.close");
  assert(closeCommand, "terminal.close command registered");

  fakeSidecar.reset();
  await closeCommand();

  const messages = fakeSidecar.getMessages();
  const closeMessage = messages.find((m) => m.body.operation === "close");
  assert(closeMessage, "close message sent to sidecar");
});

test("terminal.image.inline.delete sends one explicit owned-image deletion", async () => {
  FakeResizeObserver.reset();
  const fakeAttachImage = createFakeAttachImage();
  const sidecar = createFakeSidecar();
  const fakeExpose = createFakeExpose();
  const fakeView = createFakeView();
  const fakeWindow = {
    ResizeObserver: FakeResizeObserver,
    TextEncoder: FakeTextEncoder,
    devicePixelRatio: 1,
  };
  await startTerminal({
    view: fakeView,
    attachImage: fakeAttachImage.function,
    sidecar,
    expose: fakeExpose,
    scale: 1,
    window: fakeWindow,
  });
  const command = fakeExpose.getCommand("terminal.image.inline.delete");
  assert(command, "inline image deletion command registered");

  await command({ name: "plot" });
  const messages = sidecar.getMessages();
  assert.deepEqual(messages.at(-1)?.body, { operation: "image.inline.delete", name: "plot" });
  await assert.rejects(command({ name: "" }), /non-empty name/);
});

test("open is independent of DOM element size", async () => {
  FakeResizeObserver.reset();
  const fakeAttachImage = createFakeAttachImage();
  const fakeSidecar = createFakeSidecar();
  const fakeExpose = createFakeExpose();

  // 초기 크기가 0인 view를 만든다
  const fakeView = Object.assign(createFakeView(), { clientWidth: 0, clientHeight: 0 });

  const fakeWindow = {
    ResizeObserver: FakeResizeObserver,
    TextEncoder: FakeTextEncoder,
    devicePixelRatio: 1,
  };

  await startTerminal({
    view: fakeView,
    attachImage: fakeAttachImage.function,
    sidecar: fakeSidecar,
    expose: fakeExpose,
    scale: 1,
    window: fakeWindow,
  });

  // DOM 크기가 0이어도 세션 요청은 즉시 전송된다. 실제 래스터는 호스트가 구성한다.
  let messages = sessionMessages(fakeSidecar);
  let openMessage = messages.find((m) => m.body.operation === "open");
  assert(openMessage, "open message is sent at DOM size 0x0");
  assert.deepEqual(openMessage.body, { operation: "open", image: "view", shell: "/bin/sh" });

  // 이제 크기를 800x400으로 변경한다
  fakeView.clientWidth = 800;
  fakeView.clientHeight = 400;
  FakeResizeObserver.triggerAll();

  messages = sessionMessages(fakeSidecar);
  openMessage = messages.find((m) => m.body.operation === "open");
  assert(openMessage, "the original open remains the only session request");
  const openMessages = messages.filter((m) => m.body.operation === "open");
  assert.equal(openMessages.length, 1, "open sent exactly once");
  assert.equal(messages.length, 1, "DOM resize sends no protocol message");
});

test("DOM resize never sends terminal raster messages", async () => {
  FakeResizeObserver.reset();
  const fakeAttachImage = createFakeAttachImage();
  const fakeSidecar = createFakeSidecar();
  const fakeExpose = createFakeExpose();
  const fakeView = createFakeView();
  const fakeWindow = {
    ResizeObserver: FakeResizeObserver,
    TextEncoder: FakeTextEncoder,
    devicePixelRatio: 1,
  };

  await startTerminal({
    view: fakeView,
    attachImage: fakeAttachImage.function,
    sidecar: fakeSidecar,
    expose: fakeExpose,
    scale: 1,
    window: fakeWindow,
  });

  let messages = fakeSidecar.getMessages();
  let openMessage = messages.find((m) => m.body.operation === "open");
  assert(openMessage, "open message sent");

  // 세션 상태가 생겨도 페이지는 래스터를 관리하지 않는다.
  fakeSidecar.triggerEvent("test-session", { event: "state", sessionId: "s1", cols: 100, rows: 50, cellWidth: 8, cellHeight: 16 });
  await new Promise((resolve) => setImmediate(resolve));

  // 크기를 0x0으로 변경한다
  fakeView.clientWidth = 0;
  fakeView.clientHeight = 0;
  fakeSidecar.reset();
  FakeResizeObserver.triggerAll();

  messages = fakeSidecar.getMessages();
  assert.equal(messages.length, 0, "zero DOM size sends nothing");

  // 크기를 다시 400x300으로 변경한다
  fakeView.clientWidth = 400;
  fakeView.clientHeight = 300;
  FakeResizeObserver.triggerAll();

  messages = fakeSidecar.getMessages();
  assert.equal(messages.length, 0, "non-zero DOM resize also sends nothing");
});

// 새로운 테스트 3: input_before_open
test("input_before_open: terminal.input is buffered until open", async () => {
  FakeResizeObserver.reset();
  const fakeAttachImage = createFakeAttachImage();
  const fakeSidecar = createFakeSidecar();
  const fakeExpose = createFakeExpose();
  const fakeView = createFakeView();
  const fakeWindow = {
    ResizeObserver: FakeResizeObserver,
    TextEncoder: FakeTextEncoder,
    devicePixelRatio: 1,
  };

  await startTerminal({
    view: fakeView,
    attachImage: fakeAttachImage.function,
    sidecar: fakeSidecar,
    expose: fakeExpose,
    scale: 1,
    window: fakeWindow,
  });

  // ResizeObserver 콜백을 호출하지 않으므로 open이 전송되지 않는다
  const inputCommand = fakeExpose.getCommand("terminal.input");
  assert(inputCommand, "terminal.input command registered");

  const pending = inputCommand({ bytes: "test" });
  let settled = false;
  pending.finally(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "pre-open command remains pending");
  openSession(fakeSidecar);
  await pending;
  const input = fakeSidecar.getMessages().find(({ body }) => body.operation === "input" && body.bytes);
  assert.equal(Buffer.from(input.body.bytes, "base64").toString(), "test");
});

// 새로운 테스트 4: sidecar_error_reaches_session_status
test("sidecar_error_reaches_session_status: sidecar error event updates session", async () => {
  FakeResizeObserver.reset();
  const fakeAttachImage = createFakeAttachImage();
  const fakeSidecar = createFakeSidecar();
  const fakeExpose = createFakeExpose();
  const fakeView = createFakeView();
  const fakeWindow = {
    ResizeObserver: FakeResizeObserver,
    TextEncoder: FakeTextEncoder,
    devicePixelRatio: 1,
  };
  const surfaceErrors = [];

  await startTerminal({
    view: fakeView,
    attachImage: fakeAttachImage.function,
    sidecar: fakeSidecar,
    expose: fakeExpose,
    reportSurfaceError: (error) => surfaceErrors.push(error),
    scale: 1,
    window: fakeWindow,
  });

  FakeResizeObserver.triggerAll();

  const sessionStatus = fakeExpose.getStatus("terminal.session");
  assert(sessionStatus, "terminal.session status registered");

  // 초기값은 error 필드가 없다
  let session = sessionStatus.readFn();
  assert(!session.error, "initial session has no error field");

  // sidecar에서 error 이벤트를 보낸다
  fakeSidecar.triggerEvent("test-session", {
    event: "error",
    error: "Engine panic: minimum width is 1",
  });

  // 상태에 error 필드가 추가되었는가?
  session = sessionStatus.readFn();
  assert(session.error, "session has error field");
  assert.equal(session.error, "Engine panic: minimum width is 1", "error message is stored");
  assert.equal(surfaceErrors.length, 1, "sidecar failure reaches the surface status");
  assert.equal(surfaceErrors[0].message, "Engine panic: minimum width is 1");
});

test("inline image display and deletion are observable through terminal.session", async () => {
  FakeResizeObserver.reset();
  const fakeSidecar = createFakeSidecar();
  const fakeExpose = createFakeExpose();
  await startTerminal({
    view: createFakeView(),
    attachImage: createFakeAttachImage().function,
    sidecar: fakeSidecar,
    expose: fakeExpose,
    scale: 1,
    window: { ResizeObserver: FakeResizeObserver, TextEncoder, devicePixelRatio: 1 },
  });
  const status = fakeExpose.getStatus("terminal.session");
  fakeSidecar.triggerEvent("test-session", { event: "image.inline", command: "display", name: "plot" });
  assert.deepEqual(status.readFn().inlineImages, ["plot"]);
  fakeSidecar.triggerEvent("test-session", { event: "image.inline.deleted", name: "plot" });
  assert.deepEqual(status.readFn().inlineImages, []);
});

test("compose events are sent with ranges and published as preedit state", async () => {
  FakeResizeObserver.reset();
  const fakeAttachImage = createFakeAttachImage();
  const fakeSidecar = createFakeSidecar();
  const fakeExpose = createFakeExpose();
  const fakeView = createFakeView();
  const fakeWindow = {
    ResizeObserver: FakeResizeObserver,
    TextEncoder: FakeTextEncoder,
    devicePixelRatio: 1,
  };

  let regionReference = null;
  const patchedAttachImage = function(view, name, sidecar) {
    const result = fakeAttachImage.function(view, name, sidecar);
    regionReference = result;
    return result;
  };

  await startTerminal({
    view: fakeView,
    attachImage: patchedAttachImage,
    sidecar: fakeSidecar,
    expose: fakeExpose,
    scale: 1,
    window: fakeWindow,
  });

  FakeResizeObserver.triggerAll();
  openSession(fakeSidecar);

  const sessionStatus = fakeExpose.getStatus("terminal.session");
  const composeStatus = fakeExpose.getStatus("terminal.compose");
  assert.deepEqual(composeStatus.readFn(), {
    text: "", selectedRange: null, replacementRange: null, attributed: false,
  });

  regionReference._trigger("compose", {
    text: "한글", selectedRange: { location: 2, length: 0 },
    replacementRange: { location: 0, length: 1 }, attributed: true,
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(composeStatus.readFn(), {
    text: "한글", selectedRange: { location: 2, length: 0 },
    replacementRange: { location: 0, length: 1 }, attributed: true,
  });
  const message = fakeSidecar.getMessages().at(-1).body;
  assert.deepEqual(message, {
    operation: "input", compose: {
      text: "한글",
      selectedRange: { location: 2, length: 0 },
      replacementRange: { location: 0, length: 1 }, attributed: true,
    },
  });
});

test("native insert callbacks preserve compatibility jamo instead of discarding by Unicode range", async () => {
  FakeResizeObserver.reset();
  const fakeAttachImage = createFakeAttachImage();
  const fakeSidecar = createFakeSidecar();
  const fakeExpose = createFakeExpose();
  let regionReference;
  await startTerminal({
    view: createFakeView(),
    attachImage: (view, name, sidecar) => {
      regionReference = fakeAttachImage.function(view, name, sidecar);
      return regionReference;
    },
    sidecar: fakeSidecar,
    expose: fakeExpose,
    scale: 1,
    window: { ResizeObserver: FakeResizeObserver, TextEncoder, devicePixelRatio: 1 },
  });
  FakeResizeObserver.triggerAll();
  openSession(fakeSidecar);

  regionReference._trigger("insert", { text: "ㅎ" });
  regionReference._trigger("insert", { text: "ㄴ" });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  const byteInputs = fakeSidecar.getMessages().filter(({ body }) => body.operation === "input" && body.bytes);
  assert.deepEqual(byteInputs.map(({ body }) => Buffer.from(body.bytes, "base64").toString("utf8")), ["ㅎ", "ㄴ"],
    "every native insert must be preserved exactly unless the native input client identifies it as preedit");
});

test("Korean IME insertText commit clears an active preedit and keeps later typing live", async () => {
  FakeResizeObserver.reset();
  const fakeAttachImage = createFakeAttachImage();
  const fakeSidecar = createFakeSidecar();
  let regionReference;
  const expose = createFakeExpose();
  await startTerminal({
    view: createFakeView(),
    attachImage: (view, name, sidecar) => {
      regionReference = fakeAttachImage.function(view, name, sidecar);
      return regionReference;
    },
    sidecar: fakeSidecar,
    expose,
    scale: 1,
    window: { ResizeObserver: FakeResizeObserver, TextEncoder, devicePixelRatio: 1 },
  });
  FakeResizeObserver.triggerAll();
  openSession(fakeSidecar);

  regionReference._trigger("compose", {
    text: "한", selectedRange: { location: 1, length: 0 }, replacementRange: null, attributed: true,
  });
  // NSTextInputClient.insertText는 native marked 상태를 지우지만 빈 compose event는 따로 보내지 않는다.
  regionReference._trigger("insert", { text: "한" });
  regionReference._trigger("insert", { text: "글" });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  const byteInputs = fakeSidecar.getMessages().filter(({ body }) => body.operation === "input" && body.bytes);
  assert.equal(byteInputs.length, 2, "the committed syllable and following character must reach the PTY");
  assert.deepEqual(byteInputs.map(({ body }) => Buffer.from(body.bytes, "base64").toString("utf8")), ["한", "글"]);
  assert.equal(expose.getStatus("terminal.compose").readFn().text, "", "insertText must end the stale preedit");
});

test("clearing a native preedit cancels it without writing the uncommitted text to the PTY", async () => {
  FakeResizeObserver.reset();
  const fakeAttachImage = createFakeAttachImage();
  const fakeSidecar = createFakeSidecar();
  let regionReference;
  const expose = createFakeExpose();
  await startTerminal({
    view: createFakeView(),
    attachImage: (view, name, sidecar) => {
      regionReference = fakeAttachImage.function(view, name, sidecar);
      return regionReference;
    },
    sidecar: fakeSidecar,
    expose,
    scale: 1,
    window: { ResizeObserver: FakeResizeObserver, TextEncoder, devicePixelRatio: 1 },
  });
  FakeResizeObserver.triggerAll();
  openSession(fakeSidecar);

  regionReference._trigger("compose", {
    text: "한글", selectedRange: { location: 2, length: 0 }, replacementRange: null, attributed: true,
  });
  regionReference._trigger("compose", {
    text: "", selectedRange: null, replacementRange: null, attributed: false,
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(expose.getStatus("terminal.compose").readFn().text, "", "the cancelled preedit must clear");
  const byteInputs = fakeSidecar.getMessages().filter(({ body }) => body.operation === "input" && body.bytes);
  assert.deepEqual(byteInputs, [], "a cleared marked string is not committed input");
});

test("screen events update terminal.cursor and move the input-method caret", async () => {
  FakeResizeObserver.reset();
  const fakeAttachImage = createFakeAttachImage();
  const fakeSidecar = createFakeSidecar();
  let regionReference;
  const expose = createFakeExpose();
  await startTerminal({
    view: createFakeView(),
    attachImage: (view, name, sidecar) => {
      regionReference = fakeAttachImage.function(view, name, sidecar);
      return regionReference;
    },
    sidecar: fakeSidecar,
    expose,
    scale: 1,
    window: { ResizeObserver: FakeResizeObserver, TextEncoder, devicePixelRatio: 1 },
  });
  FakeResizeObserver.triggerAll();
  openSession(fakeSidecar);

  fakeSidecar.triggerEvent("test-session", {
    event: "screen",
    cols: 100,
    rows: 50,
    cursor: { col: 7, row: 3, shape: "Block", visible: true, blinking: false, blink_visible: true, focused: true, preedit: null },
    lines: [],
  });
  await new Promise((resolve) => setImmediate(resolve));

  const status = expose.getStatus("terminal.cursor").readFn();
  assert.deepEqual({ col: status.col, row: status.row, visible: status.visible, focused: status.focused },
    { col: 7, row: 3, visible: true, focused: true }, "terminal.cursor reports the cursor of the latest screen");
  assert.deepEqual(regionReference._caret, { x: 56, y: 48, width: 8, height: 16 },
    "the input-method caret follows the latest cursor cell");

  fakeSidecar.triggerEvent("test-session", { event: "screen", cols: 100, rows: 50, cursor: { col: 1, row: 1 }, lines: [] });
  await new Promise((resolve) => setImmediate(resolve));
  const after = expose.getStatus("terminal.cursor").readFn();
  assert.deepEqual({ col: after.col, row: after.row }, { col: 7, row: 3 }, "an incomplete cursor does not replace the status");
  assert.match(expose.getStatus("terminal.session").readFn().error ?? "", /invalid screen cursor/,
    "an incomplete cursor is reported as an error");
});

test("an input method's edited syllables reach the PTY once and in order before Enter", async () => {
  FakeResizeObserver.reset();
  const fakeAttachImage = createFakeAttachImage();
  const fakeSidecar = createFakeSidecar();
  let regionReference;
  const expose = createFakeExpose();
  await startTerminal({
    view: createFakeView(),
    attachImage: (view, name, sidecar) => {
      regionReference = fakeAttachImage.function(view, name, sidecar);
      return regionReference;
    },
    sidecar: fakeSidecar,
    expose,
    scale: 1,
    window: { ResizeObserver: FakeResizeObserver, TextEncoder, devicePixelRatio: 1 },
  });
  FakeResizeObserver.triggerAll();
  openSession(fakeSidecar);

  // macOS 한국어 입력기로 ddd 뒤 한글, Space, Enter 를 쳤을 때 네이티브 영역이 보고한 순서.
  const compose = (text) => ({ type: "compose", text, selectedRange: { location: text.length, length: 0 }, replacementRange: null, attributed: false });
  const insert = (text) => ({ type: "insert", text, replacementRange: null, attributed: false });
  const sequence = [
    insert("d"), insert("d"), insert("d"),
    compose("ㅎ"), compose("하"), compose("한"), insert("한"),
    compose("ㄱ"), compose("그"), compose("글"), insert("글"),
    compose(" "), insert(" "), compose(""),
    { type: "key", key: "Enter", shift: false, alt: false, ctrl: false },
  ];
  for (const event of sequence) regionReference._trigger(event.type, event);
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve));

  const inputs = fakeSidecar.getMessages().filter(({ body }) => body.operation === "input" && (body.bytes || body.keys));
  const written = inputs.map(({ body }) => body.bytes ? Buffer.from(body.bytes, "base64").toString("utf8") : `<${body.keys[0].key}>`);
  assert.deepEqual(written, ["d", "d", "d", "한", "글", " ", "<Enter>"],
    "only committed text reaches the PTY, once and in order, before the Enter key");
  assert.equal(expose.getStatus("terminal.compose").readFn().text, "", "no preedit remains after the commit");
});

test("accepting native marked text writes it to the PTY exactly once", async () => {
  FakeResizeObserver.reset();
  const fakeAttachImage = createFakeAttachImage();
  const fakeSidecar = createFakeSidecar();
  let regionReference;
  const expose = createFakeExpose();
  await startTerminal({
    view: createFakeView(),
    attachImage: (view, name, sidecar) => {
      regionReference = fakeAttachImage.function(view, name, sidecar);
      return regionReference;
    },
    sidecar: fakeSidecar,
    expose,
    scale: 1,
    window: { ResizeObserver: FakeResizeObserver, TextEncoder, devicePixelRatio: 1 },
  });
  FakeResizeObserver.triggerAll();
  openSession(fakeSidecar);

  // macOS unmarkText 가 보고하는 순서: 조합 해제 뒤 확정 insert 하나.
  regionReference._trigger("compose", {
    text: "한글", selectedRange: { location: 2, length: 0 }, replacementRange: null, attributed: true,
  });
  regionReference._trigger("compose", {
    text: "", selectedRange: { location: 0, length: 0 }, replacementRange: { location: 0, length: 2 }, attributed: false,
  });
  regionReference._trigger("insert", { text: "한글", replacementRange: { location: 0, length: 0 }, attributed: false });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(expose.getStatus("terminal.compose").readFn().text, "", "the accepted preedit must clear");
  const byteInputs = fakeSidecar.getMessages().filter(({ body }) => body.operation === "input" && body.bytes);
  assert.deepEqual(byteInputs.map(({ body }) => Buffer.from(body.bytes, "base64").toString("utf8")), ["한글"],
    "accepted marked text is committed once");
});

test("a terminal without a diagnostic module registers no diagnostic entries", async () => {
  FakeResizeObserver.reset();
  const expose = createFakeExpose();
  await startTerminal({
    view: createFakeView(),
    attachImage: createFakeAttachImage().function,
    sidecar: createFakeSidecar(),
    expose,
    scale: 1,
    window: { ResizeObserver: FakeResizeObserver, TextEncoder, devicePixelRatio: 1 },
  });
  assert.equal(expose.getCommand("terminal.compose.update"), undefined);
  assert.equal(expose.getCommand("terminal.ime.trace"), undefined);
  assert.equal(expose.getStatus("terminal.ime.trace"), undefined);
});

test("terminal.compose.update exposes ordered preedit changes without writing partial text to the PTY", async () => {
  FakeResizeObserver.reset();
  const fakeAttachImage = createFakeAttachImage();
  const fakeSidecar = createFakeSidecar();
  const expose = createFakeExpose();
  await startTerminal({
    view: createFakeView(),
    attachImage: fakeAttachImage.function,
    sidecar: fakeSidecar,
    expose,
    diagnostics: terminalDiagnostics,
    scale: 1,
    window: { ResizeObserver: FakeResizeObserver, TextEncoder, devicePixelRatio: 1 },
  });
  FakeResizeObserver.triggerAll();
  openSession(fakeSidecar);

  const update = expose.getCommand("terminal.compose.update");
  assert.equal(typeof update, "function", "preedit must have a declared command entry point");
  for (const text of ["ㅎ", "하", "한"]) {
    await update({ text, selectedRange: { location: text.length, length: 0 }, attributed: true });
    assert.equal(expose.getStatus("terminal.compose").readFn().text, text);
  }
  const inputMessages = fakeSidecar.getMessages().filter(({ body }) => body.operation === "input");
  assert.deepEqual(inputMessages.map(({ body }) => body.compose?.text), ["ㅎ", "하", "한"]);
  assert.equal(inputMessages.some(({ body }) => body.bytes !== undefined), false,
    "preedit updates must not become PTY bytes");
});

test("terminal.compose.update rejects malformed ranges instead of replacing them with empty ranges", async () => {
  FakeResizeObserver.reset();
  const fakeAttachImage = createFakeAttachImage();
  const fakeSidecar = createFakeSidecar();
  const expose = createFakeExpose();
  await startTerminal({
    view: createFakeView(),
    attachImage: fakeAttachImage.function,
    sidecar: fakeSidecar,
    expose,
    diagnostics: terminalDiagnostics,
    scale: 1,
    window: { ResizeObserver: FakeResizeObserver, TextEncoder, devicePixelRatio: 1 },
  });
  FakeResizeObserver.triggerAll();

  await assert.rejects(expose.getCommand("terminal.compose.update")({
    text: "한", selectedRange: { location: -1, length: 0 },
  }), /IME range must contain nonnegative integer location and length/);
  assert.equal(fakeSidecar.getMessages().some(({ body }) => body.operation === "input"), false,
    "invalid compose input must not be sent");
});

test("terminal.ime.trace records native callbacks and ordered terminal input, and reports overflow", async () => {
  FakeResizeObserver.reset();
  const fakeAttachImage = createFakeAttachImage();
  const fakeSidecar = createFakeSidecar();
  const expose = createFakeExpose();
  let regionReference;
  await startTerminal({
    view: createFakeView(),
    attachImage: (view, name, sidecar) => {
      regionReference = fakeAttachImage.function(view, name, sidecar);
      return regionReference;
    },
    sidecar: fakeSidecar,
    expose,
    diagnostics: terminalDiagnostics,
    scale: 1,
    window: { ResizeObserver: FakeResizeObserver, TextEncoder, devicePixelRatio: 1 },
  });
  FakeResizeObserver.triggerAll();
  openSession(fakeSidecar);

  await expose.getCommand("terminal.ime.trace")({ action: "start" });
  regionReference._trigger("key", { key: "Char", text: "d", shift: false, alt: false, ctrl: false });
  regionReference._trigger("insert", { text: "d" });
  regionReference._trigger("compose", { text: "ㅎ" });
  regionReference._trigger("insert", { text: "한" });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const result = await expose.getCommand("terminal.ime.trace")({ action: "stop" });
  assert.equal(result.overflow, false);
  assert.deepEqual(result.entries.map(({ kind }) => kind), [
    "native-key", "terminal-input", "native-insert", "terminal-input", "native-compose", "terminal-input", "native-insert", "terminal-input", "terminal-input",
  ]);
  assert.deepEqual(result.entries[0], { sequence: 0, kind: "native-key", key: "Char", text: "d" });
  assert.deepEqual(result.entries.filter(({ kind }) => kind === "native-insert").map(({ text }) => text), ["d", "한"]);

  await expose.getCommand("terminal.ime.trace")({ action: "start" });
  for (let i = 0; i < 257; i++) regionReference._trigger("insert", { text: "x" });
  const overflow = expose.getStatus("terminal.ime.trace").readFn();
  assert.equal(overflow.enabled, false);
  assert.equal(overflow.overflow, true);
  const error = () => expose.getStatus("terminal.session").readFn().error;
  assert.equal(error(), "IME diagnostic trace capacity exceeded");
  openSession(fakeSidecar);
  assert.equal(error(), "IME diagnostic trace capacity exceeded", "a state event hid the trace overflow");
  await expose.getCommand("terminal.ime.trace")({ action: "start" });
  assert.equal(error(), undefined, "a new trace did not resolve the overflow");
});

test("native focus and cursor state route to sidecar and caret", async () => {
  FakeResizeObserver.reset();
  const fakeAttachImage = createFakeAttachImage();
  const fakeSidecar = createFakeSidecar();
  const fakeExpose = createFakeExpose();
  const fakeView = createFakeView();
  let regionReference;
  await startTerminal({
    view: fakeView,
    attachImage: (view, name, sidecar) => {
      regionReference = fakeAttachImage.function(view, name, sidecar);
      return regionReference;
    },
    sidecar: fakeSidecar, expose: fakeExpose,
    window: { TextEncoder: FakeTextEncoder },
  });
  openSession(fakeSidecar);
  fakeSidecar.triggerEvent("test-session", {
    event: "state", sessionId: "s1", cols: 10, rows: 4, cellWidth: 9, cellHeight: 18,
    cursor: { row: 2, col: 3 },
  });
  regionReference._trigger("focus", { focused: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(regionReference._caret, { x: 27, y: 36, width: 9, height: 18 });
  assert.deepEqual(fakeSidecar.getMessages().at(-1).body, {
    operation: "input", focus: { focused: true },
  });
});

test("cursor state exposes typed shape and blink policy while routing the caret", async () => {
  FakeResizeObserver.reset();
  const fakeAttachImage = createFakeAttachImage();
  const fakeSidecar = createFakeSidecar();
  const fakeExpose = createFakeExpose();
  let regionReference;
  await startTerminal({
    view: createFakeView(),
    attachImage: (view, name, sidecar) => (regionReference = fakeAttachImage.function(view, name, sidecar)),
    sidecar: fakeSidecar, expose: fakeExpose,
    window: { TextEncoder: FakeTextEncoder },
  });
  openSession(fakeSidecar);

  fakeSidecar.triggerEvent("test-session", {
    event: "state", sessionId: "s1", cols: 10, rows: 4, cellWidth: 9, cellHeight: 18,
    cursor: {
      row: 1, col: 2, shape: "Beam", visible: true, blinking: true, focused: true,
      blink: "Always", interval: 700, idleTimeout: 1200, unfocused: "hollow", hollow: true,
    },
  });

  assert.deepEqual(fakeExpose.getStatus("terminal.cursor").readFn(), {
    row: 1, col: 2, shape: "beam", visible: true, blinking: true, focused: true,
    blink: "Always", interval: 700, idleTimeout: 1200, unfocused: "hollow", hollow: true,
    blinkVisible: true, drawn: { shape: "block", blinking: false },
  });
  assert.deepEqual(regionReference._caret, { x: 18, y: 18, width: 9, height: 18 });
});

test("the drawn cursor follows the screen event while the policy shape stays", async () => {
  FakeResizeObserver.reset();
  const fakeSidecar = createFakeSidecar();
  const fakeExpose = createFakeExpose();
  await startTerminal({
    view: createFakeView(),
    attachImage: createFakeAttachImage().function,
    sidecar: fakeSidecar, expose: fakeExpose,
    window: { TextEncoder: FakeTextEncoder },
  });
  openSession(fakeSidecar);
  fakeSidecar.triggerEvent("test-session", {
    event: "screen", lines: [""],
    cursor: { col: 1, row: 0, visible: true, focused: true, shape: "Underline", blinking: true },
  });
  const cursor = fakeExpose.getStatus("terminal.cursor").readFn();
  assert.deepEqual(cursor.drawn, { shape: "underline", blinking: true });
  assert.equal(cursor.shape, "block", "the program shape must not replace the policy shape");
  fakeSidecar.triggerEvent("test-session", {
    event: "screen", lines: [""],
    cursor: { col: 1, row: 0, visible: true, focused: false, shape: "HollowBlock", blinking: false },
  });
  assert.deepEqual(fakeExpose.getStatus("terminal.cursor").readFn().drawn, { shape: "hollowBlock", blinking: false });
});

test("an OSC 22 pointer event sets the view cursor and the session pointer", async () => {
  FakeResizeObserver.reset();
  const fakeSidecar = createFakeSidecar();
  const fakeExpose = createFakeExpose();
  const view = createFakeView();
  await startTerminal({
    view, attachImage: createFakeAttachImage().function,
    sidecar: fakeSidecar, expose: fakeExpose,
    window: { TextEncoder: FakeTextEncoder },
  });
  openSession(fakeSidecar);
  fakeSidecar.triggerEvent("test-session", { event: "pointer", shape: "crosshair" });
  assert.equal(fakeExpose.getStatus("terminal.session").readFn().pointer, "crosshair");
  assert.equal(view.style.cursor, "crosshair");
  fakeSidecar.triggerEvent("test-session", { event: "pointer", shape: "default" });
  assert.equal(view.style.cursor, "", "the default pointer returns the page cursor");
});

test("a sequence the engine rejected is recorded in the session without a surface error", async () => {
  FakeResizeObserver.reset();
  const fakeSidecar = createFakeSidecar();
  const fakeExpose = createFakeExpose();
  const errors = [];
  await startTerminal({
    view: createFakeView(), attachImage: createFakeAttachImage().function,
    sidecar: fakeSidecar, expose: fakeExpose,
    window: { TextEncoder: FakeTextEncoder },
    reportSurfaceError: (error) => errors.push(error),
  });
  openSession(fakeSidecar);
  for (let index = 0; index < 10; index++) {
    fakeSidecar.triggerEvent("test-session", { event: "sequence.rejected", reason: `unsupported OSC selector ${index}` });
  }
  const session = fakeExpose.getStatus("terminal.session").readFn();
  assert.equal(session.error, undefined, "a program's rejected sequence is not a terminal error");
  assert.deepEqual(errors, []);
  assert.deepEqual(session.rejected, [2, 3, 4, 5, 6, 7, 8, 9].map((index) => `unsupported OSC selector ${index}`),
    "the session keeps the last eight rejected sequences");
});

test("cursor policy sends explicit shape, blink, interval, idle timeout, and unfocused rendering", async () => {
  FakeResizeObserver.reset();
  const fakeSidecar = createFakeSidecar();
  const terminal = await startTerminal({
    view: createFakeView(), attachImage: createFakeAttachImage().function,
    sidecar: fakeSidecar, expose: createFakeExpose(), window: { TextEncoder: FakeTextEncoder },
  });
  const policy = await terminal.setCursorPolicy({
    shape: "beam", blink: "Always", interval: 750, idleTimeout: 5000, unfocused: "unchanged",
  });
  assert.deepEqual(policy, {
    shape: "beam", blink: "Always", interval: 750, idleTimeout: 5000, unfocused: "unchanged",
  });
  assert.deepEqual(fakeSidecar.getMessages().at(-1).body, {
    operation: "cursor", shape: "beam", blink: "Always", interval: 750, idleTimeout: 5000,
    unfocused: "unchanged",
  });
  await assert.rejects(
    terminal.setCursorPolicy({ shape: "beam", blink: "Sometimes", interval: 750, idleTimeout: 5000, unfocused: "unchanged" }),
    /cursor policy blink is invalid/
  );
});

test("declared settings are sent at startup and on effective setting changes", async () => {
  FakeResizeObserver.reset();
  const fakeSidecar = createFakeSidecar();
  const fakeExpose = createFakeExpose();
  let notify;
  const settings = {
    read: () => ({
      ...SHELL_SETTINGS.read(),
      "cursor.shape": "underline", "cursor.blink": "On", "cursor.interval": 900,
      "cursor.idleTimeout": 0, "cursor.unfocused": "beam", "clipboard.program": "deny", shell: "/bin/sh",
    }),
    on: (listener) => { notify = listener; return () => { notify = null; }; },
  };
  const terminal = await startTerminal({
    view: createFakeView(), attachImage: createFakeAttachImage().function,
    sidecar: fakeSidecar, expose: fakeExpose, settings,
    window: { TextEncoder: FakeTextEncoder },
  });
  assert.deepEqual(fakeSidecar.getMessages().at(-1).body, {
    operation: "cursor", shape: "underline", blink: "On", interval: 900,
    idleTimeout: 0, unfocused: "beam",
  });
  // 상태는 보낸 정책이 아니라 사이드카가 적용한 뒤 보낸 cursor 응답을 따른다.
  assert.equal(fakeExpose.getStatus("terminal.cursor").readFn().shape, "block");
  fakeSidecar.triggerEvent("test-session", {
    ack: true, event: "cursor", shape: "underline", blink: "On", interval: 900, idleTimeout: 0, unfocused: "beam",
  });
  assert.equal(fakeExpose.getStatus("terminal.cursor").readFn().shape, "underline");
  assert.equal(fakeExpose.getStatus("terminal.cursor").readFn().blink, "On");
  notify({
    "cursor.shape": "beam", "cursor.blink": "Never", "cursor.interval": 1000,
    "cursor.idleTimeout": 5000, "cursor.unfocused": "solid", "clipboard.program": "deny",
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(fakeSidecar.getMessages().at(-1).body, {
    operation: "cursor", shape: "beam", blink: "Never", interval: 1000,
    idleTimeout: 5000, unfocused: "solid",
  });
  assert.equal(fakeExpose.getStatus("terminal.cursor").readFn().shape, "underline");
  fakeSidecar.triggerEvent("test-session", {
    ack: true, event: "cursor", shape: "beam", blink: "Never", interval: 1000, idleTimeout: 5000, unfocused: "solid",
  });
  assert.equal(fakeExpose.getStatus("terminal.cursor").readFn().shape, "beam");
  assert.equal(fakeExpose.getStatus("terminal.cursor").readFn().blink, "Never");
  fakeSidecar.triggerEvent("test-session", {
    event: "state", sessionId: "s1", cols: 80, rows: 24, cellWidth: 8, cellHeight: 16,
    cursor: { col: 3, row: 2 },
  });
  assert.equal(fakeExpose.getStatus("terminal.cursor").readFn().shape, "beam");
  assert.equal(fakeExpose.getStatus("terminal.cursor").readFn().blink, "Never");
  await terminal.dispose();
  assert.equal(notify, null);
});

test("invalid cursor fields are observable errors and never fall back to the previous cursor", async () => {
  FakeResizeObserver.reset();
  const fakeAttachImage = createFakeAttachImage();
  const fakeSidecar = createFakeSidecar();
  const fakeExpose = createFakeExpose();
  await startTerminal({
    view: createFakeView(), attachImage: fakeAttachImage.function,
    sidecar: fakeSidecar, expose: fakeExpose,
    window: { TextEncoder: FakeTextEncoder },
  });
  openSession(fakeSidecar);
  fakeSidecar.triggerEvent("test-session", {
    event: "state", sessionId: "s1", cols: 10, rows: 4, cellWidth: 9, cellHeight: 18,
    cursor: { row: 1, col: 2, shape: "Beam", blink: "Always" },
  });
  const previous = fakeExpose.getStatus("terminal.cursor").readFn();
  fakeSidecar.triggerEvent("test-session", {
    event: "state", sessionId: "s1", cols: 10, rows: 4, cellWidth: 9, cellHeight: 18,
    cursor: { row: 3, col: 4, shape: "diagonal", blink: "Sometimes" },
  });

  assert.deepEqual(fakeExpose.getStatus("terminal.cursor").readFn(), previous);
  assert.match(fakeExpose.getStatus("terminal.session").readFn().error, /invalid cursor/);
  assert.match(fakeExpose.getStatus("terminal.session").readFn().error, /shape|blink/);
});

test("input send failures remain observable and later queued input still sends", async () => {
  FakeResizeObserver.reset();
  const fakeAttachImage = createFakeAttachImage();
  const fakeSidecar = createFakeSidecar();
  const fakeExpose = createFakeExpose();
  let fail = true;
  const send = fakeSidecar.send;
  fakeSidecar.send = async function(id, body) {
    if (fail && body.operation === "input") {
      fail = false;
      throw new Error("input unavailable");
    }
    return send.call(this, id, body);
  };
  let regionReference;
  await startTerminal({
    view: createFakeView(),
    attachImage: (view, name, sidecar) => (regionReference = fakeAttachImage.function(view, name, sidecar)),
    sidecar: fakeSidecar, expose: fakeExpose,
    window: { TextEncoder: FakeTextEncoder },
  });
  openSession(fakeSidecar);
  regionReference._trigger("insert", { text: "a" });
  regionReference._trigger("insert", { text: "b" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(fakeExpose.getStatus("terminal.session").readFn().error, /input unavailable/);
  assert.equal(Buffer.from(fakeSidecar.getMessages().at(-1).body.bytes, "base64").toString(), "b");
});

// Vendor events have typed consumers; unrelated events remain observable as unsupported.
test("vendor_events_update_the_session_and_unrelated_events_remain_unsupported", async () => {
  FakeResizeObserver.reset();
  const fakeAttachImage = createFakeAttachImage();
  const fakeSidecar = createFakeSidecar();
  const fakeExpose = createFakeExpose();
  const fakeView = createFakeView();
  const fakeWindow = {
    ResizeObserver: FakeResizeObserver,
    TextEncoder: FakeTextEncoder,
    devicePixelRatio: 1,
  };

  await startTerminal({
    view: fakeView,
    attachImage: fakeAttachImage.function,
    sidecar: fakeSidecar,
    expose: fakeExpose,
    scale: 1,
    window: fakeWindow,
  });

  FakeResizeObserver.triggerAll();

  const sessionStatus = fakeExpose.getStatus("terminal.session");
  const initialSession = sessionStatus.readFn();
  assert(!initialSession.unsupported.includes("unclassified"), "unclassified not in unsupported initially");

  fakeSidecar.triggerEvent("test-session", { event: "directory", uri: "file:///tmp/project", path: "/tmp/project" });
  fakeSidecar.triggerEvent("test-session", { event: "hyperlink", id: "docs", uri: "https://example.test" });
  fakeSidecar.triggerEvent("test-session", { event: "notification", message: "build complete" });
  fakeSidecar.triggerEvent("test-session", { event: "vendor.shell.state", marker: "command.finished", params: ["0"] });

  const updatedSession = sessionStatus.readFn();
  assert.deepEqual(updatedSession.vendor, {
    directory: "file:///tmp/project",
    hyperlink: { id: "docs", uri: "https://example.test" },
    notification: "build complete",
    shell: { marker: "command.finished", params: ["0"] },
  });

  fakeSidecar.triggerEvent("test-session", { event: "unclassified", value: "kept" });
  assert(sessionStatus.readFn().unsupported.includes("unclassified"), "unknown event was not tracked");
});

// 새로운 테스트 5c: invalid_state_is_reported_not_replaced
test("invalid_state_is_reported_not_replaced: invalid state triggers error, does not update", async () => {
  FakeResizeObserver.reset();
  const fakeAttachImage = createFakeAttachImage();
  const fakeSidecar = createFakeSidecar();
  const fakeExpose = createFakeExpose();
  const fakeView = createFakeView();
  const fakeWindow = {
    ResizeObserver: FakeResizeObserver,
    TextEncoder: FakeTextEncoder,
    devicePixelRatio: 1,
  };

  await startTerminal({
    view: fakeView,
    attachImage: fakeAttachImage.function,
    sidecar: fakeSidecar,
    expose: fakeExpose,
    scale: 1,
    window: fakeWindow,
  });

  FakeResizeObserver.triggerAll();

  const sessionStatus = fakeExpose.getStatus("terminal.session");
  const initialSession = sessionStatus.readFn();
  const initialCols = initialSession.cols;

  // 계약 위반: cols = 0
  fakeSidecar.triggerEvent("test-session", {
    event: "state",
    sessionId: "x",
    cols: 0,
    rows: 24,
    cellWidth: 8,
    cellHeight: 16,
  });

  const session = sessionStatus.readFn();
  // 상태가 업데이트되지 않음
  assert.equal(session.cols, initialCols, "cols not changed on invalid state");
  // 오류 설정
  assert(session.error, "error field set");
  assert(session.error.includes("invalid state from sidecar"), "error indicates contract violation");
});

// 새로운 테스트 5d: invalid_key_event_modifiers
test("invalid_key_event_modifiers: non-boolean modifiers trigger error", async () => {
  FakeResizeObserver.reset();
  const fakeAttachImage = createFakeAttachImage();
  const fakeSidecar = createFakeSidecar();
  const fakeExpose = createFakeExpose();
  const fakeView = createFakeView();
  const fakeWindow = {
    ResizeObserver: FakeResizeObserver,
    TextEncoder: FakeTextEncoder,
    devicePixelRatio: 1,
  };

  let regionReference = null;
  const patchedAttachImage = function(view, name, sidecar) {
    const result = fakeAttachImage.function(view, name, sidecar);
    regionReference = result;
    return result;
  };

  await startTerminal({
    view: fakeView,
    attachImage: patchedAttachImage,
    sidecar: fakeSidecar,
    expose: fakeExpose,
    scale: 1,
    window: fakeWindow,
  });

  FakeResizeObserver.triggerAll();

  const sessionStatus = fakeExpose.getStatus("terminal.session");

  // 계약 위반: shift가 문자열
  regionReference._trigger("key", { key: "Enter", shift: "true", alt: false, ctrl: false });

  const session = sessionStatus.readFn();
  assert(session.error, "error field set for invalid modifier");
  assert(session.error.includes("invalid key event"), "error indicates key event issue");
});

test("a caller scale option cannot enter the terminal protocol", async () => {
  FakeResizeObserver.reset();
  const fakeAttachImage = createFakeAttachImage();
  const fakeSidecar = createFakeSidecar();
  const fakeExpose = createFakeExpose();
  const fakeView = createFakeView();
  const fakeWindow = {
    ResizeObserver: FakeResizeObserver,
    TextEncoder: FakeTextEncoder,
    devicePixelRatio: 1,
  };

  await startTerminal({
    view: fakeView,
    attachImage: fakeAttachImage.function,
    sidecar: fakeSidecar,
    expose: fakeExpose,
    scale: 0,
    window: fakeWindow,
  });
  assert.deepEqual(sessionMessages(fakeSidecar), [{
    id: "test-session",
    body: { operation: "open", image: "view", shell: "/bin/sh" },
  }]);
});

// 새로운 테스트 5f: missing_surface_id_throws
test("missing_surface_id_throws: startTerminal throws when surface id missing", async () => {
  FakeResizeObserver.reset();
  const fakeAttachImage = createFakeAttachImage();
  const fakeSidecar = createFakeSidecar();
  const fakeExpose = createFakeExpose();

  // search 파라미터에 id가 없는 view
  const fakeView = {
    ownerDocument: {
      location: { search: "" }, // id 없음
    },
    clientWidth: 800,
    clientHeight: 600,
    addEventListener: function(event, handler) {
      if (event === "pointerdown" && !this._pointerdown) {
        this._pointerdown = handler;
      }
    },
  };

  const fakeWindow = {
    ResizeObserver: FakeResizeObserver,
    TextEncoder: FakeTextEncoder,
    devicePixelRatio: 1,
  };

  try {
    await realStartTerminal({
      view: fakeView,
      attachImage: fakeAttachImage.function,
      sidecar: fakeSidecar,
      expose: fakeExpose,
      scale: 1,
      window: fakeWindow,
    });
    assert.fail("startTerminal should throw when surface id missing");
  } catch (error) {
    assert(error.message.includes("surface id"), "error mentions surface id");
  }
});

test("region input is buffered in order until sidecar state opens the session", async () => {
  FakeResizeObserver.reset();
  const fakeAttachImage = createFakeAttachImage();
  const fakeSidecar = createFakeSidecar();
  const fakeExpose = createFakeExpose();
  
  // 초기 크기가 0인 view를 만든다
  const fakeView = Object.assign(createFakeView(), { clientWidth: 0, clientHeight: 0 });

  const fakeWindow = {
    ResizeObserver: FakeResizeObserver,
    TextEncoder: FakeTextEncoder,
    devicePixelRatio: 1,
  };

  let regionReference = null;
  const patchedAttachImage = function(view, name, sidecar) {
    const result = fakeAttachImage.function(view, name, sidecar);
    regionReference = result;
    return result;
  };

  await startTerminal({
    view: fakeView,
    attachImage: patchedAttachImage,
    sidecar: fakeSidecar,
    expose: fakeExpose,
    scale: 1,
    window: fakeWindow,
  });

  // 크기가 0인 상태에서 region 이벤트를 보낸다
  regionReference._trigger("insert", { text: "a" });
  regionReference._trigger("key", { key: "Enter", shift: false, alt: false, ctrl: false });

  // open만 전송되고 입력은 bounded startup queue에 남는다.
  let messages = sessionMessages(fakeSidecar);
  assert.equal(messages.length, 1, "only open is sent before the session exists");
  assert.equal(messages[0].body.operation, "open", "first message is open");
  assert.deepEqual(messages[0].body, { operation: "open", image: "view", shell: "/bin/sh" });

  // 사이드카가 state 이벤트로 세션을 연다
  fakeSidecar.triggerEvent("test-session", { event: "state", sessionId: "s1", cols: 100, rows: 50, cellWidth: 8, cellHeight: 16 });
  await new Promise((resolve) => setImmediate(resolve));

  messages = sessionMessages(fakeSidecar);
  assert.equal(messages.length, 3, "open and two inputs are sent after state");
  assert.equal(Buffer.from(messages[1].body.bytes, "base64").toString(), "a");
  assert.equal(messages[2].body.keys[0].key, "Enter");
});

test("startup input overflow is visible and does not report success", async () => {
  FakeResizeObserver.reset();
  const fakeAttachImage = createFakeAttachImage();
  const fakeSidecar = createFakeSidecar();
  const fakeExpose = createFakeExpose();
  let regionReference;
  await startTerminal({
    view: createFakeView(),
    attachImage: (view, name, sidecar) => (regionReference = fakeAttachImage.function(view, name, sidecar)),
    sidecar: fakeSidecar, expose: fakeExpose,
    window: { TextEncoder: FakeTextEncoder },
  });
  for (let index = 0; index <= 1024; index += 1) {
    regionReference._trigger("insert", { text: String(index) });
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(fakeExpose.getStatus("terminal.session").readFn().error, /queue overflow/);
  assert.equal(fakeSidecar.getMessages().filter(({ body }) => body.operation === "input").length, 0);
});

// 호스트 configure 오류를 페이지의 DOM 크기로 복구하려 해서는 안 된다.
test("a sidecar rejection is reported without DOM-driven retry", async () => {
  FakeResizeObserver.reset();
  const fakeAttachImage = createFakeAttachImage();
  const fakeSidecar = createFakeSidecar();
  const fakeExpose = createFakeExpose();

  // 레이아웃 완료 전의 임시 크기 1x1 CSS 픽셀에서 시작한다.
  const fakeView = createFakeView();
  fakeView.clientWidth = 1;
  fakeView.clientHeight = 1;
  const fakeWindow = {
    ResizeObserver: FakeResizeObserver,
    TextEncoder: FakeTextEncoder,
    devicePixelRatio: 2,
  };

  await startTerminal({
    view: fakeView,
    attachImage: fakeAttachImage.function,
    sidecar: fakeSidecar,
    expose: fakeExpose,
    scale: 2,
    window: fakeWindow,
  });

  // open은 페이지 크기와 무관하게 한 번만 나간다.
  let messages = sessionMessages(fakeSidecar);
  assert.equal(messages.length, 1, "one open message");
  assert.equal(messages[0].body.operation, "open", "first message is open");
  assert.equal("width" in messages[0].body, false, "transient DOM width is not sent");

  // 사이드카가 거부한다.
  fakeSidecar.triggerEvent("test-session", { error: "invalidParams", reason: "width and height must be positive" });

  // 거부 응답의 reason 이 세션 상태에 남는다.
  const sessionAfterError = fakeExpose.getStatus("terminal.session").readFn();
  assert.ok(
    String(sessionAfterError.error).includes("width and height must be positive"),
    `error keeps the rejection reason: ${sessionAfterError.error}`
  );

  // DOM 크기 변화는 host configure를 대신하지 않는다.
  fakeView.clientWidth = 494;
  fakeView.clientHeight = 287;
  FakeResizeObserver.triggerAll();
  messages = sessionMessages(fakeSidecar);

  assert.equal(messages.length, 1, "DOM size change does not retry open");

  // 세션이 생긴다.
  fakeSidecar.triggerEvent("test-session", { event: "state", sessionId: "s1", cols: 61, rows: 18, cellWidth: 8, cellHeight: 15.5 });
  const session = fakeExpose.getStatus("terminal.session").readFn();
  assert.equal(session.sessionId, "s1", "state event opens the session");
  // 오류 응답은 거부한 연산을 적지 않으므로 어떤 이벤트도 그것을 해소하지 않는다. 카드의 표면 오류와 같이 남는다.
  assert.equal(session.error, "invalidParams: width and height must be positive", "a valid state keeps the rejection");

  // 세션이 생긴 뒤에도 DOM 크기는 프로토콜 입력이 아니다.
  fakeView.clientWidth = 600;
  fakeView.clientHeight = 300;
  FakeResizeObserver.triggerAll();
  messages = sessionMessages(fakeSidecar);
  assert.equal(messages.length, 1, "DOM resize sends no sidecar message");
});

test("persistent reconnect restores the session identity before a new raster is configured", async () => {
  FakeResizeObserver.reset();
  const fakeSidecar = createFakeSidecar();
  const fakeExpose = createFakeExpose();
  await startTerminal({
    view: createFakeView(),
    attachImage: createFakeAttachImage().function,
    sidecar: fakeSidecar,
    expose: fakeExpose,
    window: { TextEncoder: FakeTextEncoder },
  });

  fakeSidecar.triggerEvent("test-session", { event: "session", sessionId: "retained-session" });
  const session = fakeExpose.getStatus("terminal.session").readFn();
  assert.equal(session.sessionId, "retained-session");
  assert.equal(session.error, undefined);
});

test("the font size is 13 points times the text size factor and follows its changes", async () => {
  FakeResizeObserver.reset();
  const fakeSidecar = createFakeSidecar();
  const fakeExpose = createFakeExpose();
  const values = {
    ...SHELL_SETTINGS.read(),
    "cursor.shape": "block", "cursor.blink": "Off", "cursor.interval": 750,
    "cursor.idleTimeout": 5000, "cursor.unfocused": "hollow", "clipboard.program": "deny",
    "font.family": "Menlo", shell: "/bin/sh",
  };
  const send = fakeSidecar.send;
  fakeSidecar.send = async (id, body) => {
    await send(id, body);
    if (body.operation !== "font") return;
    queueMicrotask(() => fakeSidecar.triggerEvent("test-session",
      { ack: true, event: "font", family: body.family, system: false, skipped: [], size: body.size }));
  };
  let factor = 1.5;
  let notify;
  const textSize = { read: () => factor, on: (listener) => { notify = listener; return () => { notify = null; }; } };
  const terminal = await startTerminal({
    view: createFakeView(), attachImage: createFakeAttachImage().function,
    sidecar: fakeSidecar, expose: fakeExpose, textSize,
    settings: { read: () => values, on: () => () => {} },
    window: { TextEncoder: FakeTextEncoder },
  });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const fonts = () => fakeSidecar.getMessages().filter(({ body }) => body.operation === "font")
    .map(({ body }) => [body.family, body.size]);
  await settle();
  assert.deepEqual(fonts(), [["Menlo", 19.5]], "the startup font uses the current factor");
  factor = 2;
  notify(factor);
  await settle();
  assert.deepEqual(fonts(), [["Menlo", 19.5], ["Menlo", 26]]);
  notify(factor);
  await settle();
  assert.equal(fonts().length, 2, "an unchanged size is not sent again");
  assert.equal(fakeExpose.getStatus("terminal.session").readFn().fontSize, 26, "the applied size is reported");
  await terminal.dispose();
  assert.equal(notify, null, "disposing the terminal stops following the text size");
});

test("the font.family list is sent at startup and on change, and the applied family is reported", async () => {
  FakeResizeObserver.reset();
  const fakeSidecar = createFakeSidecar();
  const fakeExpose = createFakeExpose();
  let notify;
  const errors = [];
  let values = {
    ...SHELL_SETTINGS.read(),
    "cursor.shape": "block", "cursor.blink": "Off", "cursor.interval": 750,
    "cursor.idleTimeout": 5000, "cursor.unfocused": "hollow", "clipboard.program": "deny",
    "font.family": "D2Coding;Menlo", shell: "/bin/sh",
  };
  // 사이드카는 설치된 첫 family 를 적용하고 확인 이벤트로 알린다. 이 가짜는 D2Coding 이 없다.
  const send = fakeSidecar.send;
  fakeSidecar.send = async (id, body) => {
    await send(id, body);
    if (body.operation !== "font") return;
    const applied = body.family.split(";").map((family) => family.trim()).find((family) => family !== "D2Coding") ?? "Menlo";
    queueMicrotask(() => fakeSidecar.triggerEvent("test-session", { ack: true, event: "font", family: applied, system: false }));
  };
  const settings = { read: () => values, on: (listener) => { notify = listener; return () => { notify = null; }; } };
  const terminal = await startTerminal({
    view: createFakeView(), attachImage: createFakeAttachImage().function,
    sidecar: fakeSidecar, expose: fakeExpose, settings,
    reportSurfaceError: (error) => errors.push(error.message),
    window: { TextEncoder: FakeTextEncoder },
  });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const fonts = () => fakeSidecar.getMessages().filter(({ body }) => body.operation === "font").map(({ body }) => body.family);
  await settle();
  assert.deepEqual(fonts(), ["D2Coding;Menlo"], "the configured list is sent at startup");
  assert.equal(fakeSidecar.getMessages().find(({ body }) => body.operation === "font").body.size, 13,
    "without a text size source the factor is 1");
  let session = fakeExpose.getStatus("terminal.session").readFn();
  assert.equal(session.font, "Menlo", "the applied family is reported");
  assert.deepEqual(session.unsupported, [], "the font acknowledgement is a known event");

  values = { ...values, "cursor.shape": "beam" };
  notify(values);
  await settle();
  assert.deepEqual(fonts(), ["D2Coding;Menlo"], "an unchanged list is not sent again");

  values = { ...values, "font.family": "Courier;Menlo" };
  notify(values);
  await settle();
  assert.deepEqual(fonts(), ["D2Coding;Menlo", "Courier;Menlo"]);
  session = fakeExpose.getStatus("terminal.session").readFn();
  assert.equal(session.font, "Courier");
  assert.equal(session.fontSystem, false);
  assert.equal(session.error, undefined, "a missing family is not an error");
  assert.deepEqual(errors, []);
  await terminal.dispose();
});

function createFakeTab({ reject = false } = {}) {
  const calls = [];
  return {
    calls,
    title: (text) => {
      if (reject && text !== null) throw new TypeError("a tab title must be 1 to 256 characters without control characters");
      calls.push(["title", text]);
    },
    directory: (path) => calls.push(["directory", path]),
    notify: (text, policy) => {
      if (reject) throw new TypeError("a tab notice must be 1 to 1024 characters without control characters");
      calls.push(["notify", text, policy]);
    },
  };
}

function titleSettings(values) {
  const listeners = [];
  let current = { ...SHELL_SETTINGS.read(), shell: "login", title: "program", ...values };
  return {
    read: () => current,
    on: (listener) => { listeners.push(listener); return () => {}; },
    change: (next) => { current = { ...current, ...next }; for (const listener of listeners) listener(current); },
  };
}

test("the tab shows the program title and a title reset or an empty title removes it", async () => {
  FakeResizeObserver.reset();
  const fakeSidecar = createFakeSidecar();
  const tab = createFakeTab();
  await startTerminal({
    view: createFakeView(), attachImage: createFakeAttachImage().function,
    sidecar: fakeSidecar, expose: createFakeExpose(), tab, settings: titleSettings({}),
    window: { TextEncoder: FakeTextEncoder },
  });
  fakeSidecar.triggerEvent("test-session", { event: "title", title: "vim README.md" });
  fakeSidecar.triggerEvent("test-session", { event: "title.reset" });
  fakeSidecar.triggerEvent("test-session", { event: "title", title: "less" });
  fakeSidecar.triggerEvent("test-session", { event: "title", title: "" });
  assert.deepEqual(tab.calls.filter(([kind]) => kind === "title"),
    [["title", null], ["title", "vim README.md"], ["title", null], ["title", "less"], ["title", null]]);
});

test("the name setting removes the program title and program shows the last title again", async () => {
  FakeResizeObserver.reset();
  const fakeSidecar = createFakeSidecar();
  const tab = createFakeTab();
  const settings = titleSettings({ title: "name" });
  await startTerminal({
    view: createFakeView(), attachImage: createFakeAttachImage().function,
    sidecar: fakeSidecar, expose: createFakeExpose(), tab, settings,
    window: { TextEncoder: FakeTextEncoder },
  });
  fakeSidecar.triggerEvent("test-session", { event: "title", title: "vim" });
  assert.deepEqual(tab.calls.filter(([kind]) => kind === "title").at(-1), ["title", null]);
  settings.change({ title: "program" });
  assert.deepEqual(tab.calls.filter(([kind]) => kind === "title").at(-1), ["title", "vim"]);
  settings.change({ title: "name" });
  assert.deepEqual(tab.calls.filter(([kind]) => kind === "title").at(-1), ["title", null]);
});

test("a title that the tab rejects is a session error", async () => {
  FakeResizeObserver.reset();
  const fakeSidecar = createFakeSidecar();
  const fakeExpose = createFakeExpose();
  const errors = [];
  await startTerminal({
    view: createFakeView(), attachImage: createFakeAttachImage().function,
    sidecar: fakeSidecar, expose: fakeExpose, tab: createFakeTab({ reject: true }), settings: titleSettings({}),
    reportSurfaceError: (error) => errors.push(error.message),
    window: { TextEncoder: FakeTextEncoder },
  });
  fakeSidecar.triggerEvent("test-session", { event: "title", title: "x".repeat(300) });
  assert.match(errors.join("\n"), /a tab title must be 1 to 256 characters/);
});

test("OSC 7 records the local directory and a directory of another machine removes it", async () => {
  FakeResizeObserver.reset();
  const fakeSidecar = createFakeSidecar();
  const tab = createFakeTab();
  await startTerminal({
    view: createFakeView(), attachImage: createFakeAttachImage().function,
    sidecar: fakeSidecar, expose: createFakeExpose(), tab, settings: titleSettings({}),
    window: { TextEncoder: FakeTextEncoder },
  });
  fakeSidecar.triggerEvent("test-session", { event: "directory", uri: "file:///tmp/a%20b", path: "/tmp/a b" });
  fakeSidecar.triggerEvent("test-session", { event: "directory", uri: "file://remote/tmp", path: null });
  assert.deepEqual(tab.calls.filter(([kind]) => kind === "directory"),
    [["directory", "/tmp/a b"], ["directory", null]]);
});

test("a session opens in the origin directory of its tab", async () => {
  FakeResizeObserver.reset();
  const fakeSidecar = createFakeSidecar();
  await startTerminal({
    view: createFakeView(), attachImage: createFakeAttachImage().function,
    sidecar: fakeSidecar, expose: createFakeExpose(), tab: createFakeTab(), origin: { directory: "/tmp/origin" },
    settings: titleSettings({}), window: { TextEncoder: FakeTextEncoder },
  });
  const open = fakeSidecar.getMessages().find((message) => message.body.operation === "open");
  assert.deepEqual(open.body, { operation: "open", image: "view", shell: "login", directory: "/tmp/origin" });
});

test("an OSC 9 notification becomes a tab notice and a rejected one is a session error", async () => {
  FakeResizeObserver.reset();
  const fakeSidecar = createFakeSidecar();
  const tab = createFakeTab();
  await startTerminal({
    view: createFakeView(), attachImage: createFakeAttachImage().function,
    sidecar: fakeSidecar, expose: createFakeExpose(), tab, settings: titleSettings({}),
    window: { TextEncoder: FakeTextEncoder },
  });
  fakeSidecar.triggerEvent("test-session", { event: "notification", message: "build complete" });
  assert.deepEqual(tab.calls.filter(([kind]) => kind === "notify"), [["notify", "build complete", "tab"]]);

  const systemTab = createFakeTab();
  const system = createFakeSidecar();
  await startTerminal({
    view: createFakeView(), attachImage: createFakeAttachImage().function,
    sidecar: system, expose: createFakeExpose(), tab: systemTab, settings: titleSettings({ notifications: "system" }),
    window: { TextEncoder: FakeTextEncoder },
  });
  system.triggerEvent("test-session", { event: "notification", message: "system delivery" });
  assert.deepEqual(systemTab.calls.filter(([kind]) => kind === "notify"), [["notify", "system delivery", "system"]]);

  const errors = [];
  const rejecting = createFakeSidecar();
  await startTerminal({
    view: createFakeView(), attachImage: createFakeAttachImage().function,
    sidecar: rejecting, expose: createFakeExpose(), tab: createFakeTab({ reject: true }), settings: titleSettings({ title: "name" }),
    reportSurfaceError: (error) => errors.push(error.message), window: { TextEncoder: FakeTextEncoder },
  });
  rejecting.triggerEvent("test-session", { event: "notification", message: "x".repeat(2000) });
  assert.match(errors.join("\n"), /a tab notice must be 1 to 1024 characters/);
});

async function startWithLink({ links } = {}) {
  FakeResizeObserver.reset();
  const fakeSidecar = createFakeSidecar();
  const fakeExpose = createFakeExpose();
  const view = createFakeView();
  const errors = [];
  await startTerminal({
    view, attachImage: createFakeAttachImage().function,
    sidecar: fakeSidecar, expose: fakeExpose, links,
    reportSurfaceError: (error) => errors.push(error.message),
    window: { TextEncoder: FakeTextEncoder },
  });
  openSession(fakeSidecar);
  // 0행의 2~5열(x 16~47)이 링크다.
  const link = "https://example.test/doc";
  fakeSidecar.triggerEvent("test-session", { event: "screen", lines: [[
    { ch: "a", width: 1 }, { ch: " ", width: 1 },
    ...[..."LINK"].map((ch) => ({ ch, width: 1, link })), { ch: " ", width: 1 },
  ]] });
  fakeSidecar.reset();
  return { fakeSidecar, fakeExpose, view, errors, link };
}

test("the pointer is a hand over a linked cell and the session reports the hovered link", async () => {
  const { fakeExpose, view, link } = await startWithLink({ links: { open: async () => {} } });
  const hovered = () => fakeExpose.getStatus("terminal.session").readFn().link;
  view._trigger("pointermove", { pointerId: 1, clientX: 20, clientY: 5 });
  assert.equal(view.style.cursor, "pointer");
  assert.equal(hovered(), link);
  view._trigger("pointermove", { pointerId: 1, clientX: 4, clientY: 5 });
  assert.equal(view.style.cursor, "");
  assert.equal(hovered(), null);
  view._trigger("pointermove", { pointerId: 1, clientX: 20, clientY: 5 });
  view._trigger("pointerleave", { pointerId: 1, clientX: 900, clientY: 5 });
  assert.equal(hovered(), null);
});

test("a Command-click on a linked cell opens the link through terminal.link.open without selecting", async () => {
  const opened = [];
  const { fakeSidecar, view, link } = await startWithLink({ links: { open: async (url) => { opened.push(url); } } });
  view._trigger("pointerdown", { button: 0, pointerId: 2, clientX: 20, clientY: 5, metaKey: true });
  view._trigger("pointerup", { button: 0, pointerId: 2, clientX: 20, clientY: 5, metaKey: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(opened, [link]);
  assert.equal(fakeSidecar.getMessages().some(({ body }) => String(body.operation).startsWith("selection")), false);

  view._trigger("pointerdown", { button: 0, pointerId: 3, clientX: 20, clientY: 5 });
  view._trigger("pointerup", { button: 0, pointerId: 3, clientX: 20, clientY: 5 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(opened, [link], "a click without Command opened the link");
  assert.equal(fakeSidecar.getMessages().some(({ body }) => body.operation === "selection.start"), true);
});

test("a link that the host rejects is an input session error", async () => {
  const { fakeExpose, view } = await startWithLink({
    links: { open: async () => { throw new Error('link URL scheme "file" is not opened'); } },
  });
  view._trigger("pointerdown", { button: 0, pointerId: 2, clientX: 20, clientY: 5, metaKey: true });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(fakeExpose.getStatus("terminal.session").readFn().error ?? "", /is not opened/);
});

test("a session without an origin directory opens in the project root, and without a project in the home directory", async () => {
  for (const [project, expected] of [[{ root: "/work/app" }, { directory: "/work/app" }], [null, {}]]) {
    FakeResizeObserver.reset();
    const fakeSidecar = createFakeSidecar();
    await startTerminal({
      view: createFakeView(), attachImage: createFakeAttachImage().function,
      sidecar: fakeSidecar, expose: createFakeExpose(), tab: createFakeTab(), project,
      settings: titleSettings({}), window: { TextEncoder: FakeTextEncoder },
    });
    const open = fakeSidecar.getMessages().find((message) => message.body.operation === "open");
    assert.deepEqual(open.body, { operation: "open", image: "view", shell: "login", ...expected });
  }
});

test("terminal.cursor.set keeps the current value of each field it does not name", async () => {
  FakeResizeObserver.reset();
  const fakeSidecar = createFakeSidecar();
  const fakeExpose = createFakeExpose();
  await startTerminal({
    view: createFakeView(), attachImage: createFakeAttachImage().function,
    sidecar: fakeSidecar, expose: fakeExpose, window: { TextEncoder: FakeTextEncoder },
  });
  await fakeExpose.getCommand("terminal.cursor.set")({ shape: "beam", blink: "Always", interval: 900, idleTimeout: 0, unfocused: "solid" });
  fakeSidecar.triggerEvent("test-session", { ack: true, event: "cursor", shape: "beam", blink: "Always", interval: 900, idleTimeout: 0, unfocused: "solid" });
  await fakeExpose.getCommand("terminal.cursor.set")({ shape: "underline" });
  assert.deepEqual(fakeSidecar.getMessages().at(-1).body, {
    operation: "cursor", shape: "underline", blink: "Always", interval: 900, idleTimeout: 0, unfocused: "solid",
  });
});
