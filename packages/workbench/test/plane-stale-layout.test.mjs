// 판은 배치를 만든 뒤 onLayout 수신자에게 그리기 함수를 넘기고, 수신자는 네이티브 준비가 끝난 뒤에 그 함수를
// 호출한다. 그 사이에 닫을 수 있는 카드의 마지막 탭이 닫히면 카드는 판에서 사라지지만, 넘긴 그리기 함수는 그 카드를
// 담은 이전 배치를 가지고 있다. 그 그리기는 예외 없이 끝나야 한다(G1.4-26).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { registerPlugin } from "../registry.js";

const pluginId = "fixture-stale-layout";

test("a held layout draw survives the close of a card it contains", { timeout: 5000 }, async (t) => {
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
  // 판의 크기. JSDOM 은 배치를 계산하지 않으므로 쪼갤 공간이 있는 크기를 준다.
  const planeEl = document.getElementById("plane");
  Object.defineProperty(planeEl, "clientWidth", { value: 800 });
  Object.defineProperty(planeEl, "clientHeight", { value: 600 });
  // 앱 스타일시트가 카드에 주는 테두리 폭과 접힌 사이드바 폭. JSDOM 은 app.css 를 불러오지 않는다.
  const style = document.createElement("style");
  style.textContent = ".card { --bw: 1px; --divider: 1px; }";
  document.head.appendChild(style);

  // 호스트 브리지가 없는 페이지. 보고는 검사가 읽도록 기록한다.
  const reports = [];
  const actualHost = await import("../host.js");
  t.mock.module("../host.js", { exports: { ...actualHost, report: (line) => reports.push(line) } });
  // 표면 모듈을 불러오지 않는다. 이 검사는 판의 그리기만 다룬다. 마운트한 표면은 기록한다.
  const mounts = [];
  t.mock.module("../surface-modules.js", { exports: {
    mountSurface: (slot, surface) => { mounts.push(surface.surfaceId); return Promise.resolve(); },
    disposeSurface: () => Promise.resolve(), focusSurface: () => true, placePluginPlaceholder: () => {},
  } });
  // 새 스페이스의 배치: 닫을 수 없는 카드 하나.
  t.mock.module("../environment.js", { exports: {
    environment: () => ({ workspace: { focus: "main", grid: {
      xs: [0, 1], ys: [0, 1],
      cards: [{ id: "main", c0: 0, c1: 1, r0: 0, r1: 1, tabs: [{ plugin: pluginId, title: "main" }] }],
    } } }),
    pluginUnits: () => [{ id: pluginId, name: "Fixture", description: "검사용 표면.", surface: true, sections: [] }],
  } });
  registerPlugin({
    id: pluginId, name: "Fixture", mark: "f", svg: "<path/>", ink: null, background: null, diagnostics: null, drop: null,
    surface: (surfaceId) => ({ module: "/fixture.js", composition: { kind: "dom" }, surfaceId, pluginId,
      declarations: {}, sidecars: [] }),
  });

  // 카드 요소는 선언된 코어 명령에만 연결된다.
  const { registry } = await import("../exposure.js");
  registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
  const plane = await import("../plane.js");
  try {
    // 수신자는 그리기 함수를 보관하고 즉시 그리지 않는다. 네이티브 준비를 기다리는 페이지와 같다.
    let held = null;
    plane.onLayout((made, draw) => { held = { made, draw }; });
    plane.adopt(plane.fresh());
    held.draw();
    // 살아 있는 카드의 그리기는 그 탭의 표면을 마운트한다.
    const mainTab = plane.currentGrid().card("main").data.activeId;
    assert.ok(mounts.includes(mainTab), `the first draw did not mount the main tab ${mainTab}`);
    const { card, tab } = plane.splitCard("main", "x", pluginId);
    assert.ok(plane.currentGrid().card(card), "the split made no card");
    const stale = held;
    assert.ok(stale.made.has(card), "the held layout does not contain the split card");
    await plane.closeTabById(tab);
    assert.equal(plane.currentGrid().card(card), undefined, "closing the last tab left the card on the plane");
    mounts.length = 0;
    assert.doesNotThrow(() => stale.draw(), "drawing a layout held before the card closed must not throw");
    // 닫힌 탭의 표면은 이미 해제되었으므로 이전 배치를 그려도 다시 마운트하지 않는다.
    assert.ok(!mounts.includes(tab), `the closed tab ${tab} was mounted again by the stale draw`);
    assert.deepEqual(reports, []);
  } finally {
    dom.window.close();
  }
});
