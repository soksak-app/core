import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createBinder } from "@soksak/plugin-api";
import { startTerminal } from "../ui/terminal.js";

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
    clientWidth: 800,
    clientHeight: 600,
    dataset: {},
    parentElement: parent,
    addEventListener(event, handler) { if (!listeners.has(event)) listeners.set(event, []); listeners.get(event).push(handler); },
    removeEventListener(event, handler) { listeners.set(event, (listeners.get(event) ?? []).filter((item) => item !== handler)); },
    _trigger: function(event) {
      const nativeEvent = event instanceof Event ? event : new Event(event, { bubbles: true, cancelable: true });
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
    bind: async function(...args) { return binder.bind(...args); },
    dispose: async function() { binder.dispose(); },
    getStatus: (name) => statuses.get(name),
    getCommand: (name) => commands.get(name),
    getDom: (name) => doms.get(name),
    getStatuses: () => statuses,
    getCommands: () => commands,
    getDoms: () => doms,
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
  assert.deepEqual(sidecar.getMessages().filter(({ body }) => body.op === "input").map(({ body }) => body.keys[0]),
    [event, event]);
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
  assert.deepEqual(sidecar.getMessages().map(({ body }) => body.op), ["open"]);
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
  assert.equal(attachCall.sidecar, "@soksak/sidecar-vt-alacritty", "correct sidecar");

  // sidecar에 open이 갔는가?
  const messages = fakeSidecar.getMessages();
  const openMessage = messages.find((m) => m.body.op === "open");
  assert(openMessage, "open message sent to sidecar");
  assert.equal(openMessage.body.image, "view", "open message has image: 'view'");
  assert.equal("width" in openMessage.body, false, "DOM width is not sent");
  assert.equal("height" in openMessage.body, false, "DOM height is not sent");
  assert.equal("scale" in openMessage.body, false, "DOM scale is not sent");
});

// 테스트 2: 영역 insert{text:"ls\r"} → sidecar {op:"input", bytes: base64("ls\r")}
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
  }).then(() => fakeAttachImage.function(fakeView, "view", "@soksak/sidecar-vt-alacritty"));

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

  // sidecar 메시지를 확인한다
  const messages = fakeSidecar.getMessages();
  const inputMessage = messages.find((m) => m.body.op === "input" && m.body.bytes);
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
  const inputMessage = messages.find((m) => m.body.op === "input" && m.body.bytes);
  assert(inputMessage, "input message with bytes sent");

  const decodedBytes = Buffer.from(inputMessage.body.bytes, "base64").toString("utf8");
  assert.equal(decodedBytes, "ls\r", "command sends same encoding as region insert");
});

// 테스트 4: 영역 key(Enter) → {op:"input", keys:[{key:"Enter"}]}
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

  const messages = fakeSidecar.getMessages();
  const keyMessage = messages.find((m) => m.body.op === "input" && m.body.keys);
  assert(keyMessage, "key message sent");
  assert.deepEqual(keyMessage.body.keys[0], {
    key: "Enter",
    text: "",
    shift: false,
    alt: false,
    ctrl: false,
  }, "Enter key formatted correctly");
});

// 테스트 4b: 영역 key(ArrowUp) → {op:"input", keys:[{key:"Up"}]}
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

  const messages = fakeSidecar.getMessages();
  const keyMessage = messages.find((m) => m.body.op === "input" && m.body.keys);
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

// 테스트 5: view의 pointerdown → 영역 focus() 한 번
test("View pointerdown triggers region focus", async () => {
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
  let focusCalled = false;
  const patchedAttachImage = function(view, name, sidecar) {
    const result = fakeAttachImage.function(view, name, sidecar);
    const originalFocus = result.focus.bind(result);
    result.focus = async function() {
      focusCalled = true;
      return originalFocus();
    };
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

  focusCalled = false;
  fakeView._trigger("pointerdown");

  assert(focusCalled, "region.focus() called on pointerdown");
});

test("pointerdown prevents DOM focus, bubbles, and invokes terminal.focus once", { timeout: 10000 }, async () => {
  FakeResizeObserver.reset();
  const attach = createFakeAttachImage();
  const expose = createFakeExpose();
  const view = createFakeView();
  let focusCalls = 0;
  let region;
  await startTerminal({
    view, attachImage: (...args) => {
      region = attach.function(...args);
      region.focus = async () => { focusCalls++; };
      return region;
    },
    sidecar: createFakeSidecar(), expose, window: { TextEncoder: FakeTextEncoder },
  });

  const event = view._trigger("pointerdown");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(expose.getCommand("terminal.focus") !== undefined, true);
  assert.equal(focusCalls, 1);
  assert.equal(event.defaultPrevented, true);
  assert.equal(view._parent.bubbleCount, 1);
});

test("terminal.focus binding reports focus rejection through terminal.session", { timeout: 10000 }, async () => {
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

  view._trigger("pointerdown");
  await new Promise((resolve) => setImmediate(resolve));
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
  const screenReadMessage = messages.find((m) => m.body.op === "screen.read");
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

// 테스트 8: terminal.close → sidecar {op:"close"} 한 번
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
  const closeMessage = messages.find((m) => m.body.op === "close");
  assert(closeMessage, "close message sent to sidecar");
});

test("open is independent of DOM element size", async () => {
  FakeResizeObserver.reset();
  const fakeAttachImage = createFakeAttachImage();
  const fakeSidecar = createFakeSidecar();
  const fakeExpose = createFakeExpose();

  // 초기 크기가 0인 view를 만든다
  const fakeView = {
    ownerDocument: {
      location: { search: "?id=test-session" },
    },
    clientWidth: 0,
    clientHeight: 0,
    addEventListener: function(event, handler) {
      if (event === "pointerdown" && !this._pointerdown) {
        this._pointerdown = handler;
      }
    },
    _trigger: function(event) {
      if (event === "pointerdown" && this._pointerdown) {
        this._pointerdown();
      }
    },
  };

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
  let messages = fakeSidecar.getMessages();
  let openMessage = messages.find((m) => m.body.op === "open");
  assert(openMessage, "open message is sent at DOM size 0x0");
  assert.deepEqual(openMessage.body, { op: "open", image: "view" });

  // 이제 크기를 800x400으로 변경한다
  fakeView.clientWidth = 800;
  fakeView.clientHeight = 400;
  FakeResizeObserver.triggerAll();

  messages = fakeSidecar.getMessages();
  openMessage = messages.find((m) => m.body.op === "open");
  assert(openMessage, "the original open remains the only session request");
  const openMessages = messages.filter((m) => m.body.op === "open");
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
  let openMessage = messages.find((m) => m.body.op === "open");
  assert(openMessage, "open message sent");

  // 세션 상태가 생겨도 페이지는 래스터를 관리하지 않는다.
  fakeSidecar.triggerEvent("test-session", { event: "state", sessionId: "s1", cols: 100, rows: 50, cellWidth: 8, cellHeight: 16 });

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
test("input_before_open: terminal.input throws error before open", async () => {
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

  // open 전에 terminal.input을 호출하면 오류가 발생한다
  try {
    await inputCommand({ bytes: "test" });
    assert.fail("terminal.input should throw error before open");
  } catch (error) {
    assert.match(error.message, /session is not open/i, "error message indicates session not open");
  }
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
});

// 새로운 테스트 5a: compose_event_tracking
test("compose_event_tracking: compose events are tracked in unsupported", async () => {
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
  const initialSession = sessionStatus.readFn();
  assert(!initialSession.unsupported.includes("compose"), "compose not in unsupported initially");

  // Compose 이벤트를 trigger한다
  regionReference._trigger("compose", { text: "test", caret: 0 });

  const updatedSession = sessionStatus.readFn();
  assert(updatedSession.unsupported.includes("compose"), "compose added to unsupported after event");
});

// 새로운 테스트 5b: unknown_sidecar_event_tracking
test("unknown_sidecar_event_tracking: unknown sidecar events are tracked", async () => {
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
  assert(!initialSession.unsupported.includes("notification"), "notification not in unsupported initially");

  // 알 수 없는 이벤트를 보낸다
  fakeSidecar.triggerEvent("test-session", { event: "notification", message: "test" });

  const updatedSession = sessionStatus.readFn();
  assert(updatedSession.unsupported.includes("notification"), "unknown event added to unsupported");
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
  assert.deepEqual(fakeSidecar.getMessages(), [{
    id: "test-session",
    body: { op: "open", image: "view" },
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
    await startTerminal({
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

test("region input waits for sidecar state after open", async () => {
  FakeResizeObserver.reset();
  const fakeAttachImage = createFakeAttachImage();
  const fakeSidecar = createFakeSidecar();
  const fakeExpose = createFakeExpose();
  
  // 초기 크기가 0인 view를 만든다
  const fakeView = {
    ownerDocument: {
      location: { search: "?id=test-session" },
    },
    clientWidth: 0,
    clientHeight: 0,
    addEventListener: function(event, handler) {
      if (event === "pointerdown" && !this._pointerdown) {
        this._pointerdown = handler;
      }
    },
    _trigger: function(event) {
      if (event === "pointerdown" && this._pointerdown) {
        this._pointerdown();
      }
    },
  };

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

  // open만 전송되고 입력은 아직 queue에 있어야 한다.
  let messages = fakeSidecar.getMessages();
  assert.equal(messages.length, 1, "only open is sent before the session exists");
  assert.equal(messages[0].body.op, "open", "first message is open");
  assert.deepEqual(messages[0].body, { op: "open", image: "view" });

  // 사이드카가 state 이벤트로 세션을 연다
  fakeSidecar.triggerEvent("test-session", { event: "state", sessionId: "s1", cols: 100, rows: 50, cellWidth: 8, cellHeight: 16 });

  messages = fakeSidecar.getMessages();
  assert.equal(messages.length, 3, "three messages sent: open, input(a), input(Enter)");

  // 두 번째: input(a)
  assert.equal(messages[1].body.op, "input", "second message is input");
  assert(messages[1].body.bytes, "input has bytes");
  const decodedInsert = Buffer.from(messages[1].body.bytes, "base64").toString("utf8");
  assert.equal(decodedInsert, "a", "input bytes is 'a'");

  // 세 번째: input(Enter key)
  assert.equal(messages[2].body.op, "input", "third message is input");
  assert(messages[2].body.keys, "input has keys");
  assert.deepEqual(messages[2].body.keys[0].key, "Enter", "key is Enter");
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
  let messages = fakeSidecar.getMessages();
  assert.equal(messages.length, 1, "one open message");
  assert.equal(messages[0].body.op, "open", "first message is open");
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
  messages = fakeSidecar.getMessages();

  assert.equal(messages.length, 1, "DOM size change does not retry open");

  // 세션이 생긴다.
  fakeSidecar.triggerEvent("test-session", { event: "state", sessionId: "s1", cols: 61, rows: 18, cellWidth: 8, cellHeight: 15.5 });
  const session = fakeExpose.getStatus("terminal.session").readFn();
  assert.equal(session.sessionId, "s1", "state event opens the session");
  assert.equal(session.error, undefined, "a valid state clears the error");

  // 세션이 생긴 뒤에도 DOM 크기는 프로토콜 입력이 아니다.
  fakeView.clientWidth = 600;
  fakeView.clientHeight = 300;
  FakeResizeObserver.triggerAll();
  messages = fakeSidecar.getMessages();
  assert.equal(messages.length, 1, "DOM resize sends no sidecar message");
});
