import assert from "node:assert/strict";
import test from "node:test";
import { startTerminal } from "../ui/terminal.js";

/**
 * 가짜 ResizeObserver 구현.
 */
class FakeResizeObserver {
  constructor(callback) {
    this.callback = callback;
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

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
  return {
    ownerDocument: {
      location: { search: "?id=test-session" },
    },
    clientWidth: 800,
    clientHeight: 600,
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

// 테스트 1: 부팅 → attachImage가 한 번 호출되고 sidecar에 open이 간다
test("Boot: attachImage called once and sidecar receives open message", async () => {
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
  assert.equal(openMessage.body.width, 800, "width matches view");
  assert.equal(openMessage.body.height, 600, "height matches view");
  assert.equal(openMessage.body.scale, 2, "scale passed correctly");
});

// 테스트 2: 영역 insert{text:"ls\r"} → sidecar {op:"input", bytes: base64("ls\r")}
test("Region insert event sends base64-encoded bytes to sidecar", async () => {
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

  fakeSidecar.reset();
  regionReference._trigger("key", { key: "Enter" });

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

  fakeSidecar.reset();
  regionReference._trigger("key", { key: "Up" });

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

  focusCalled = false;
  fakeView._trigger("pointerdown");

  assert(focusCalled, "region.focus() called on pointerdown");
});

// 테스트 6: terminal.screen.read → sidecar에 screen.read가 가고, 가짜가 screen 이벤트로 답하면 줄 텍스트 배열이 돌아온다
test("terminal.screen.read sends request and returns lines on screen event", async () => {
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

  const screenReadCommand = fakeExpose.getCommand("terminal.screen.read");
  assert(screenReadCommand, "terminal.screen.read command registered");

  // 비동기로 screen event를 trigger하자
  setTimeout(() => {
    regionReference._trigger("screen", { lines: ["line1", "line2", "line3"] });
  }, 10);

  const lines = await screenReadCommand();
  assert.deepEqual(lines, ["line1", "line2", "line3"], "screen.read returns lines from screen event");

  // sidecar에 screen.read가 갔는가?
  const messages = fakeSidecar.getMessages();
  const screenReadMessage = messages.find((m) => m.body.op === "screen.read");
  assert(screenReadMessage, "screen.read message sent to sidecar");
});

// 테스트 7: sidecar state event → terminal.session 상태가 그 값을 갖는다
test("Sidecar state event updates terminal.session status", async () => {
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

// 테스트 8: terminal.close → sidecar {op:"close"} 한 번
test("terminal.close sends close message to sidecar", async () => {
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

  const closeCommand = fakeExpose.getCommand("terminal.close");
  assert(closeCommand, "terminal.close command registered");

  fakeSidecar.reset();
  await closeCommand();

  const messages = fakeSidecar.getMessages();
  const closeMessage = messages.find((m) => m.body.op === "close");
  assert(closeMessage, "close message sent to sidecar");
});
