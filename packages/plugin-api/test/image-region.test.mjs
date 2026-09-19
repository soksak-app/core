// 그림 영역이 요소의 뷰포트 여백을 알리고, 호출 순서를 지키고, 자기 이벤트만 받는지 검사한다.
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { regionInsets } from "../document-region.js";
import { attachImage } from "../image-region.js";

const settle = () => new Promise((resolve) => setImmediate(resolve));

/** 요소의 사각형을 정할 수 있는 창. ResizeObserver 는 observe 한 요소와 콜백을 기록한다. */
function fixture() {
  const { window } = new JSDOM("<body><div id=outer><div id=region></div></div></body>", { url: "https://example.test/" });
  const observed = [];
  const callbacks = [];
  window.ResizeObserver = class {
    constructor(fn) { callbacks.push(fn); this.disconnected = false; }
    observe(node) { observed.push(node); }
    disconnect() { this.disconnected = true; callbacks.length = 0; }
  };
  Object.defineProperty(window, "innerWidth", { value: 800, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: 600, configurable: true });
  const element = window.document.getElementById("region");
  let rect = { left: 10, top: 40, right: 510, bottom: 440, width: 500, height: 400 };
  element.getBoundingClientRect = () => rect;
  return {
    window, element, observed,
    resize: (next) => { rect = next; for (const fn of [...callbacks]) fn([]); },
    callbacks,
  };
}

function port() {
  const calls = [];
  let eventListeners = null;
  let attached = false;
  return {
    calls, attached: Promise.resolve(),
    attach: (name, sidecar) => { calls.push(["attach", name, sidecar]); attached = true; return Promise.resolve(); },
    place: async (name, insets, visible) => { calls.push(["place", name, insets, visible]); },
    focus: async (name) => { calls.push(["focus", name]); },
    caret: async (name, x, y, w, h) => { calls.push(["caret", name, x, y, w, h]); },
    text: async (name, text) => { calls.push(["text", name, text]); },
    detach: async (name) => { calls.push(["detach", name]); },
    on: (fn) => { eventListeners = fn; return Promise.resolve(); },
    send: (name, event) => { if (eventListeners) eventListeners(name, event); },
  };
}

test("attach calls with correct name and sidecar", async () => {
  const f = fixture();
  const p = port();
  const image = attachImage(p, f.element, "preview", "editor", f.window);
  await settle();
  assert.equal(p.calls[0][0], "attach");
  assert.equal(p.calls[0][1], "preview");
  assert.equal(p.calls[0][2], "editor");
  assert.equal(image.name, "preview");
});

test("place is called with element insets when element size changes", async () => {
  const f = fixture();
  const p = port();
  const image = attachImage(p, f.element, "preview", "editor", f.window);
  await settle();
  p.calls.length = 0;
  f.resize({ left: 20, top: 40, right: 420, bottom: 340, width: 400, height: 300 });
  await settle();
  const places = p.calls.filter(([kind]) => kind === "place");
  assert.deepEqual(places, [[
    "place", "preview",
    { left: 20, top: 40, right: 380, bottom: 260 },
    true
  ]]);
});

test("visible(false) calls place with visible false", async () => {
  const f = fixture();
  const p = port();
  const image = attachImage(p, f.element, "preview", "editor", f.window);
  await settle();
  p.calls.length = 0;
  await image.visible(false);
  await settle();
  const places = p.calls.filter(([kind]) => kind === "place");
  assert.equal(places.length, 1);
  assert.equal(places[0][3], false);
});

test("on() receives only events for this image", async () => {
  const f = fixture();
  const p = port();
  const image = attachImage(p, f.element, "preview", "editor", f.window);
  await settle();
  const received = [];
  image.on("key", (event) => received.push(event));
  p.send("other-image", { type: "key", key: "a" });
  p.send("preview", { type: "key", key: "b" });
  p.send("preview", { type: "insert", text: "x" });
  await settle();
  assert.deepEqual(received, [{ type: "key", key: "b" }]);
});

test("on() filters by event type", async () => {
  const f = fixture();
  const p = port();
  const image = attachImage(p, f.element, "preview", "editor", f.window);
  await settle();
  const keyEvents = [];
  const insertEvents = [];
  image.on("key", (event) => keyEvents.push(event));
  image.on("insert", (event) => insertEvents.push(event));
  p.send("preview", { type: "key", key: "a" });
  p.send("preview", { type: "insert", text: "x" });
  p.send("preview", { type: "key", key: "b" });
  await settle();
  assert.deepEqual(keyEvents, [{ type: "key", key: "a" }, { type: "key", key: "b" }]);
  assert.deepEqual(insertEvents, [{ type: "insert", text: "x" }]);
});

test("focus() calls the focus method", async () => {
  const f = fixture();
  const p = port();
  const image = attachImage(p, f.element, "preview", "editor", f.window);
  await settle();
  p.calls.length = 0;
  await image.focus();
  await settle();
  assert.deepEqual(p.calls, [["focus", "preview"]]);
});

test("setCaret() calls caret with coordinates", async () => {
  const f = fixture();
  const p = port();
  const image = attachImage(p, f.element, "preview", "editor", f.window);
  await settle();
  p.calls.length = 0;
  await image.setCaret({ x: 10, y: 20, width: 2, height: 24 });
  await settle();
  assert.deepEqual(p.calls, [["caret", "preview", 10, 20, 2, 24]]);
});

test("setAccessibleText() calls text with string", async () => {
  const f = fixture();
  const p = port();
  const image = attachImage(p, f.element, "preview", "editor", f.window);
  await settle();
  p.calls.length = 0;
  await image.setAccessibleText("hello");
  await settle();
  assert.deepEqual(p.calls, [["text", "preview", "hello"]]);
});

test("detach stops observation and rejects later calls", async () => {
  const f = fixture();
  const p = port();
  const image = attachImage(p, f.element, "preview", "editor", f.window);
  await settle();
  await image.detach();
  await settle();
  assert.equal(p.calls.at(-1)[0], "detach");
  const countAfterDetach = p.calls.length;
  await assert.rejects(image.focus(), /detached/);
  await settle();
  assert.equal(p.calls.length, countAfterDetach);
  f.window.dispatchEvent(new f.window.Event("resize"));
  assert.equal(p.calls.length, countAfterDetach);
});

test("invalid names are rejected", async () => {
  const f = fixture();
  const p = port();
  assert.throws(() => attachImage(p, f.element, "Preview", "editor", f.window), /invalid image name/);
});

test("unknown event types are warned about", async () => {
  const f = fixture();
  const p = port();
  const image = attachImage(p, f.element, "preview", "editor", f.window);
  await settle();
  p.calls.length = 0;

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);

  try {
    p.send("preview", { type: "unknownType", data: "test" });
    await settle();

    assert(warnings.length > 0, "console.warn called for unknown event type");
    const warnText = warnings[0][0];
    assert(warnText.includes("no handlers"), "warning mentions no handlers");
  } finally {
    console.warn = originalWarn;
  }
});

test("events without type field are warned about", async () => {
  const f = fixture();
  const p = port();
  const image = attachImage(p, f.element, "preview", "editor", f.window);
  await settle();
  p.calls.length = 0;

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);

  try {
    p.send("preview", { data: "test" }); // no type field
    await settle();

    assert(warnings.length > 0, "console.warn called for event without type");
    const warnText = warnings[0][0];
    assert(warnText.includes("no type"), "warning mentions no type");
  } finally {
    console.warn = originalWarn;
  }
});
