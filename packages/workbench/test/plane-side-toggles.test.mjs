// 카드 머리의 사이드바 단추는 판을 다시 그려도 문서에서 빠지지 않아야 한다. WebKit 은 누름을 받은 노드가 문서에서
// 빠지면 그 누름의 click 대상을 지우고(EventHandler::nodeWillBeRemoved), 뗌에서 click 을 보내지 않는다. insertBefore 로
// 이미 있는 노드를 옮겨도 먼저 빠진다. 접기 명령의 배치는 준비 뒤 다음 task 에서 그려지므로(F43, F92), 누름과 뗌
// 사이에 그 그리기가 오면 단추의 click 이 사라진다(F65).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { registerPlugin } from "../registry.js";

const pluginId = "fixture-side-toggles";
const setId = "fixture-set";

test("a draw keeps the pressed card header fold control in the document", { timeout: 5000 }, async (t) => {
  const markup = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const dom = new JSDOM(markup, { url: "http://localhost/" });
  // JSDOM 에 없는 matchMedia. 뷰는 해상도 변경 구독에만 쓰고, 이 검사는 해상도를 바꾸지 않는다.
  dom.window.matchMedia = (query) => ({ media: query, matches: true,
    addEventListener: () => {}, removeEventListener: () => {} });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.CSS = dom.window.CSS;
  globalThis.PointerEvent = dom.window.PointerEvent;
  globalThis.MouseEvent = dom.window.MouseEvent;
  // 사이드바 띠는 장치 pixel 격자에 맞춘다. 이 검사의 화면 배율은 2 다.
  globalThis.devicePixelRatio = 2;
  // 판의 크기. JSDOM 은 배치를 계산하지 않으므로 두 사이드바가 들어갈 크기를 준다.
  const planeEl = document.getElementById("plane");
  Object.defineProperty(planeEl, "clientWidth", { value: 800 });
  Object.defineProperty(planeEl, "clientHeight", { value: 600 });
  // 앱 스타일시트가 카드에 주는 테두리 폭과 접힌 사이드바 폭. JSDOM 은 app.css 를 불러오지 않는다.
  const style = document.createElement("style");
  style.textContent = ".card { --bw: 1px; --divider: 1px; }";
  document.head.appendChild(style);

  const reports = [];
  const actualHost = await import("../host.js");
  t.mock.module("../host.js", { exports: { ...actualHost, report: (line) => reports.push(line) } });
  t.mock.module("../surface-modules.js", { exports: {
    mountSurface: () => Promise.resolve(),
    disposeSurface: () => Promise.resolve(), focusSurface: () => true, placePluginPlaceholder: () => {},
  } });
  t.mock.module("../environment.js", { exports: {
    environment: () => ({ workspace: { focus: "main", grid: {
      xs: [0, 1], ys: [0, 1],
      cards: [{ id: "main", c0: 0, c1: 1, r0: 0, r1: 1, tabs: [{ plugin: pluginId, title: "main" }] }],
    } } }),
    pluginUnits: () => [{ id: pluginId, name: "Fixture", description: "검사용 표면.", surface: true, sections: [] }],
  } });
  // 섹션이 없는 세트 하나. 카드의 위와 왼쪽 면에 붙인다.
  const actualSettings = await import("../settings.js");
  const sets = [{ id: setId, title: "Fixture", layout: "list", sections: [] }];
  t.mock.module("../settings.js", { exports: { ...actualSettings,
    value: (key) => (key === "sets" ? sets : actualSettings.value(key)) } });
  registerPlugin({
    id: pluginId, name: "Fixture", mark: "f", svg: "<path/>", ink: null, background: null, drop: null,
    surface: (surfaceId) => ({ module: "/fixture.js", composition: { kind: "dom" }, surfaceId, pluginId,
      declarations: {}, sidecars: [] }),
  });

  const { registry } = await import("../exposure.js");
  registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
  const plane = await import("../plane.js");
  try {
    // 수신자는 그리기 함수를 보관하고 즉시 그리지 않는다. 네이티브 준비와 다음 task 를 기다리는 페이지와 같다.
    let held = null;
    plane.onLayout((made, draw) => { held = draw; });
    const drawHeld = () => { const draw = held; held = null; draw(); };
    plane.adopt(plane.fresh());
    drawHeld();
    for (const side of ["top", "left"]) {
      plane.assignSidebar("main", side, setId);
      drawHeld();
    }
    const card = document.querySelector('.card[data-card-id="main"]');
    const controls = () => [...card.querySelectorAll(".chrome__acts .chrome__side")].map((button) => button.dataset.side);
    assert.deepEqual(controls(), ["top", "left"], "the header does not show the top and left fold controls");
    const left = card.querySelector('.chrome__side[data-side="left"]');

    // 첫 누름이 왼쪽 면을 접고, 그 배치의 그리기는 아직 기다린다. 다음 누름이 그 단추에 닿은 뒤 그리기가 실행된다.
    plane.foldSidebar("main", "left");
    const acts = left.parentElement;
    const observer = new dom.window.MutationObserver(() => {});
    observer.observe(acts, { childList: true });
    drawHeld();
    const removed = observer.takeRecords().flatMap((record) => [...record.removedNodes])
      .map((node) => node.dataset?.side ?? node.className);
    observer.disconnect();
    assert.deepEqual(removed, [], "the draw took fold controls out of the card header");
    assert.equal(card.dataset.sidebarLeft, "folded");
    assert.deepEqual(controls(), ["top", "left"], "the draw changed the order of the fold controls");
    assert.deepEqual(reports, []);
  } finally {
    delete globalThis.devicePixelRatio;
    dom.window.close();
  }
});
