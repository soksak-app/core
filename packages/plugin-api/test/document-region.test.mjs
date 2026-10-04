// 문서 영역이 요소의 뷰포트 여백을 알리고, 호출 순서를 지키고, 자기 상태만 받는지 검사한다.
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { attachRegion, regionInsets } from "../document-region.js";

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
  // 관찰은 animation frame 에서 시작한다. frame() 이 기다리는 콜백을 실행한다.
  const frames = [];
  window.requestAnimationFrame = (fn) => frames.push(fn);
  window.cancelAnimationFrame = () => {};
  const reported = [];
  Object.defineProperty(window, "innerWidth", { value: 800, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: 600, configurable: true });
  window.visualViewport = { get width() { return window.innerWidth; }, get height() { return window.innerHeight; } };
  const element = window.document.getElementById("region");
  let rect = { left: 10, top: 40, right: 510, bottom: 440, width: 500, height: 400 };
  element.getBoundingClientRect = () => rect;
  return {
    window, element, observed,
    resize: (next) => { rect = next; for (const fn of [...callbacks]) fn([]); },
    callbacks,
    reported,
    report: (line) => { reported.push(line); },
    frame: () => { for (const fn of frames.splice(0)) fn(); },
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
    go: async (name, action, offset) => { calls.push(offset === undefined ? ["go", name, action] : ["go", name, action, offset]); return true; },
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

test("fractional viewport sizes do not create native region insets", () => {
  const f = fixture();
  f.window.visualViewport = { width: 597.5, height: 286.5 };
  Object.defineProperty(f.window, "innerWidth", { value: 597 });
  Object.defineProperty(f.window, "innerHeight", { value: 286 });
  f.resize({ left: 0, top: 0, right: 597.5, bottom: 286.5, width: 597.5, height: 286.5 });
  assert.deepEqual(regionInsets(f.element, f.window).insets,
    { left: 0, top: 0, right: 0, bottom: 0 });
});

test("calls wait for attach and run in order", async () => {
  const f = fixture();
  const p = port();
  const region = attachRegion(p, f.element, "page", f.window, { report: f.report });
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
  const region = attachRegion(p, f.element, "page", f.window, { report: f.report });
  // 관찰은 다음 animation frame 에 시작한다(AGENTS.md).
  assert.deepEqual(f.observed, [], "an element was observed before the next animation frame");
  f.frame();
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
  const region = attachRegion(p, f.element, "page", f.window, { report: f.report });
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
  const region = attachRegion(p, f.element, "page", f.window, { report: f.report });
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
  assert.throws(() => attachRegion(p, f.element, "Page", f.window, { report: f.report }), /invalid document name/);
  p.release();
  const region = attachRegion(p, f.element, "page", f.window, { report: f.report });
  await assert.rejects(region.go("home"), /unknown document action/);
  await assert.rejects(region.entry(0), /invalid history offset/);
  await assert.rejects(region.entry(1.5), /invalid history offset/);
});

test("a history entry is sent as the entry action with its offset", async () => {
  const f = fixture();
  const p = port();
  p.release();
  const region = attachRegion(p, f.element, "page", f.window, { report: f.report });
  assert.equal(await region.entry(-2), true);
  assert.deepEqual(p.calls.at(-1), ["go", "page", "entry", -2]);
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
  // 요소는 mock getBoundingClientRect에서 받은 width와 height를 가진다
  const insets = regionInsets(f.element, f.window);
  assert.equal(insets.visible, true, "normal element with size is visible");
});

test("visibility: propagates through attachRegion place", async () => {
  const f = fixture();
  const p = port();
  p.release();

  const region = attachRegion(p, f.element, "page", f.window, { report: f.report });
  await settle();

  // 첫 place 호출이 visible=true인지 확인한다
  const placeCallsBefore = p.calls.filter(([kind]) => kind === "place");
  assert.equal(placeCallsBefore.length, 1, "initial place call");
  assert.equal(placeCallsBefore[0][3], true, "initial visible is true");

  // 요소를 숨긴다
  f.element.style.display = "none";
  f.resize({ left: 10, top: 40, right: 510, bottom: 440, width: 500, height: 400 });
  await settle();

  // 새 place 호출이 visible=false인지 확인한다
  const placeCallsAfter = p.calls.filter(([kind]) => kind === "place");
  assert.equal(placeCallsAfter.length, 2, "place called again on visibility change");
  assert.equal(placeCallsAfter[1][3], false, "visible is false when display:none");
});

test("a document region requires a report for its failures", () => {
  const f = fixture();
  assert.throws(() => attachRegion(port(), f.element, "page", f.window), /requires a report/);
});

test("a placement that fails while observing is reported as an error", async () => {
  const f = fixture();
  const p = port();
  p.release();
  p.place = async () => { throw new Error("host refused the placement"); };
  attachRegion(p, f.element, "page", f.window, { report: f.report });
  f.frame();
  f.resize({ left: 20, top: 40, right: 420, bottom: 340, width: 400, height: 300 });
  await settle();
  assert.ok(f.reported.some((line) => line === "document page place: host refused the placement"), JSON.stringify(f.reported));
});
