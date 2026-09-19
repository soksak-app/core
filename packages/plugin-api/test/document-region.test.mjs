// 문서 영역이 요소의 뷰포트 여백을 알리고, 호출 순서를 지키고, 자기 상태만 받는지 검사한다.
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { attachRegion, regionInsets } from "@soksak/plugin-api";

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
  let receive = null;
  let stopped = false;
  let release;
  const attached = new Promise((resolve) => { release = resolve; });
  return {
    calls, attached, release,
    send: (document, state) => receive(document, state),
    stopped: () => stopped,
    attach: (name) => { calls.push(["attach", name]); return attached; },
    place: async (name, insets, visible) => { calls.push(["place", name, insets, visible]); },
    load: async (name, url) => { calls.push(["load", name, url]); },
    go: async (name, action) => { calls.push(["go", name, action]); return true; },
    detach: async (name) => { calls.push(["detach", name]); },
    onState: (fn) => { receive = fn; return Promise.resolve(() => { stopped = true; }); },
  };
}

test("regionInsets measures the element against the viewport", () => {
  const f = fixture();
  assert.deepEqual(regionInsets(f.element, f.window),
    { insets: { left: 10, top: 40, right: 290, bottom: 160 }, visible: true });
  f.element.getBoundingClientRect = () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });
  assert.equal(regionInsets(f.element, f.window).visible, false);
});

test("calls wait for attach and run in order", async () => {
  const f = fixture();
  const p = port();
  const region = attachRegion(p, f.element, "page", f.window);
  const loaded = region.load("http://127.0.0.1/");
  const went = region.back();
  await settle();
  assert.deepEqual(p.calls, [["attach", "page"]]);
  p.release();
  await loaded;
  assert.equal(await went, true);
  assert.deepEqual(p.calls, [
    ["attach", "page"],
    ["place", "page", { left: 10, top: 40, right: 290, bottom: 160 }, true],
    ["load", "page", "http://127.0.0.1/"],
    ["go", "page", "back"],
  ]);
});

test("layout changes place the region once per change", async () => {
  const f = fixture();
  const p = port();
  p.release();
  const region = attachRegion(p, f.element, "page", f.window);
  assert.deepEqual(f.observed.map((node) => node.id || node.tagName), ["region", "outer", "BODY", "HTML"]);
  f.resize({ left: 20, top: 40, right: 420, bottom: 340, width: 400, height: 300 });
  f.resize({ left: 20, top: 40, right: 420, bottom: 340, width: 400, height: 300 });
  f.window.dispatchEvent(new f.window.Event("resize"));
  Object.defineProperty(f.window, "innerWidth", { value: 700, configurable: true });
  f.window.dispatchEvent(new f.window.Event("resize"));
  await region.load("https://example.test/");
  const places = p.calls.filter(([kind]) => kind === "place").map((call) => call[2]);
  assert.deepEqual(places, [
    { left: 10, top: 40, right: 290, bottom: 160 },
    { left: 20, top: 40, right: 380, bottom: 260 },
    { left: 20, top: 40, right: 280, bottom: 260 },
  ]);
});

test("state reaches only the named region", async () => {
  const f = fixture();
  const p = port();
  p.release();
  const region = attachRegion(p, f.element, "page", f.window);
  const seen = [];
  region.onState((state) => seen.push(state));
  p.send("other", { url: "https://other.test/" });
  p.send("page", { url: "https://example.test/" });
  assert.deepEqual(seen, [{ url: "https://example.test/" }]);
  assert.deepEqual(region.state, { url: "https://example.test/" });
});

test("detach stops observation and rejects later calls", async () => {
  const f = fixture();
  const p = port();
  p.release();
  const region = attachRegion(p, f.element, "page", f.window);
  await region.detach();
  await settle();
  assert.equal(p.calls.at(-1)[0], "detach");
  assert.equal(f.callbacks.length, 0);
  assert.equal(p.stopped(), true);
  await assert.rejects(region.load("https://example.test/"), /detached/);
  const count = p.calls.length;
  f.window.dispatchEvent(new f.window.Event("resize"));
  assert.equal(p.calls.length, count);
});

test("invalid names and actions are rejected", async () => {
  const f = fixture();
  const p = port();
  assert.throws(() => attachRegion(p, f.element, "Page", f.window), /invalid document name/);
  p.release();
  const region = attachRegion(p, f.element, "page", f.window);
  await assert.rejects(region.go("home"), /unknown document action/);
});

test("visibility: display:none element is hidden", () => {
  const f = fixture();
  f.element.style.display = "none";
  const insets = regionInsets(f.element, f.window);
  assert.equal(insets.visible, false, "display:none element is not visible");
});

test("visibility: visibility:hidden element is hidden", () => {
  const f = fixture();
  f.element.style.visibility = "hidden";
  const insets = regionInsets(f.element, f.window);
  assert.equal(insets.visible, false, "visibility:hidden element is not visible");
});

test("visibility: ancestor with display:none hides element", () => {
  const f = fixture();
  const outer = f.window.document.getElementById("outer");
  outer.style.display = "none";
  const insets = regionInsets(f.element, f.window);
  assert.equal(insets.visible, false, "element is hidden when ancestor has display:none");
});

test("visibility: normal element is visible", () => {
  const f = fixture();
  // element has width and height from mock getBoundingClientRect
  const insets = regionInsets(f.element, f.window);
  assert.equal(insets.visible, true, "normal element with size is visible");
});

test("visibility: propagates through attachRegion place", async () => {
  const f = fixture();
  const p = port();
  p.release();

  const region = attachRegion(p, f.element, "page", f.window);
  await settle();

  // Check initial place call has visible=true
  const placeCallsBefore = p.calls.filter(([kind]) => kind === "place");
  assert.equal(placeCallsBefore.length, 1, "initial place call");
  assert.equal(placeCallsBefore[0][3], true, "initial visible is true");

  // Hide the element
  f.element.style.display = "none";
  f.resize({ left: 10, top: 40, right: 510, bottom: 440, width: 500, height: 400 });
  await settle();

  // Check that new place call has visible=false
  const placeCallsAfter = p.calls.filter(([kind]) => kind === "place");
  assert.equal(placeCallsAfter.length, 2, "place called again on visibility change");
  assert.equal(placeCallsAfter[1][3], false, "visible is false when display:none");
});
