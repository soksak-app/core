import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

test("a layout published before drawing waits for the host's placement answer", async () => {
  const dom = new JSDOM(`<div id="plane"><div data-card-id="card">
    <div data-native-surface data-native-surface-id="surface" data-native-plugin="probe" data-native-layer="0"></div>
  </div></div>`, { url: "https://example.test/", pretendToBeVisual: true });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.location = dom.window.location;
  // compositor 는 배치 답 뒤의 다음 프레임에 페인트 클립을 갱신하므로 페이지의 rAF 를 제공한다.
  globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  const card = document.querySelector("[data-card-id]");
  const slot = document.querySelector("[data-native-surface]");
  card.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 150 });
  slot.getBoundingClientRect = () => ({ left: 2, top: 30, width: 196, height: 100 });
  const { registerPlugin } = await import("../registry.js");
  registerPlugin({ id: "probe", surface: () => ({ module: "probe.js", composition: { kind: "dom" } }) });
  const { onCommit, placementPending, publishAhead } = await import("../compositor.js");
  let answer, prepared;
  onCommit((record) => new Promise((resolve) => {
    prepared = record;
    answer = () => resolve(record.surfaces.map((surface) => ({ id: surface.id, ...surface.applied })));
  }));

  const pending = publishAhead(new Map([["card", { x: 20, y: 0, w: 180, h: 150 }]]),
    new Map([["card", { id: "surface", dim: false }]]));
  assert.equal(typeof pending?.then, "function", "the caller needs the host's promise before it draws");
  assert.equal(placementPending(), true, "the current DOM commit is waiting for the host placement answer");
  let drawn = false;
  pending.then(() => { drawn = true; });
  await Promise.resolve();
  assert.equal(drawn, false, "the DOM must wait while the native placement is outstanding");
  // 준비는 창의 레이어 트랜잭션 안에서 적용되어 커밋 전에는 화면에 나오지 않는다. 위치를 잰 표면을 숨기면
  // 화면에는 보이는 표면이 그동안 입력을 받지 못한다(docs/spec/native-surfaces.md).
  assert.equal(prepared.surfaces[0].visible, true,
    "native preparation keeps a surface whose future slot was measured visible at its new rectangle");
  assert.deepEqual(prepared.surfaces[0].declared, { x: 22, y: 30, w: 176, h: 100 });
  answer();
  assert.deepEqual(await pending, [{ id: "surface", x: 22, y: 30, w: 176, h: 100 }]);
  assert.equal(drawn, true);
  assert.equal(placementPending(), false, "the host answer seats the current commit");

  const replacement = publishAhead(new Map([["card", { x: 20, y: 0, w: 180, h: 150 }]]),
    new Map([["card", { id: "replacement", dim: false }]]));
  assert.equal(typeof replacement?.then, "function", "replacing content must prepare the existing native view before drawing");
  assert.equal(prepared.surfaces[0].visible, false, "content with no matching future slot must be hidden before its card changes");
  answer();
  await replacement;

  // 다음 배치에 카드가 없는 표면도 숨긴다. 호스트는 visible 을 불리언으로 요구한다.
  const removed = publishAhead(new Map(), new Map());
  assert.strictEqual(prepared.surfaces[0].visible, false, "content whose card leaves the layout must be hidden with a boolean");
  answer();
  await removed;
  dom.window.close();
});
