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
    new Map([["card", { id: "surface", dim: false, inset: { left: 2, top: 30, width: 4, height: 50 } }]]));
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
    new Map([["card", { id: "replacement", dim: false, inset: null }]]));
  assert.equal(typeof replacement?.then, "function", "replacing content must prepare the existing native view before drawing");
  assert.equal(prepared.surfaces[0].visible, false, "content with no matching future slot must be hidden before its card changes");
  answer();
  await replacement;

  // 다음 배치에 카드가 없는 표면도 숨긴다. 호스트는 visible 을 불리언으로 요구한다.
  const removed = publishAhead(new Map(), new Map());
  assert.strictEqual(prepared.surfaces[0].visible, false, "content whose card leaves the layout must be hidden with a boolean");
  answer();
  await removed;
  const resizedSidebar = publishAhead(new Map([["card", { x: 20, y: 0, w: 400, h: 150 }]]),
    new Map([["card", { id: "surface", dim: false, inset: { left: 192, top: 30, width: 194, height: 50 } }]]));
  assert.deepEqual(prepared.surfaces[0].declared, { x: 212, y: 30, w: 206, h: 100 },
    "native preparation reused the old sidebar width instead of the captured future inset");
  answer();
  await resizedSidebar;
  dom.window.close();
});

test("a surface in a hidden fullscreen sibling stays mounted and becomes invisible", async () => {
  const dom = new JSDOM(`<div id="plane"><div data-card-id="hidden-card" hidden>
    <div data-native-surface data-native-surface-id="hidden-surface" data-native-plugin="fullscreen-probe" data-native-layer="0"></div>
  </div></div>`, { pretendToBeVisual: true });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  const { registerPlugin } = await import("../registry.js");
  registerPlugin({ id: "fullscreen-probe", surface: () => ({ module: "probe.js", composition: { kind: "dom" } }) });
  const slot = document.querySelector("[data-native-surface]");
  let width = 100, height = 100;
  slot.getBoundingClientRect = () => ({left:0,top:0,width,height});
  const compositor = await import("../compositor.js?fullscreen-sibling");
  let record;
  compositor.onCommit((value) => { record = value; return value.surfaces.map((surface) => ({ id: surface.id, ...surface.applied })); });
  try {
    await compositor.publish();
    assert.equal(record.surfaces.length, 1, "hidden state removed the live surface");
    assert.equal(record.surfaces[0].visible, false, "a hidden card still presents its native surface");
    assert.ok(document.querySelector('[data-native-surface-id="hidden-surface"][data-native-surface]'));
    document.querySelector('[data-card-id="hidden-card"]').hidden = false;
    await compositor.publish();
    assert.equal(record.surfaces[0].visible, true, "restoring the card did not restore its native visibility");
    width = 0;
    await compositor.publish();
    assert.equal(record.surfaces[0].visible, false, "a zero-area slot presents its retained native frame");
    assert.equal(record.surfaces.length, 1, "a zero-area slot disposed its live surface");
    width = 100;
    await compositor.publish();
    assert.equal(record.surfaces[0].visible, true, "restoring the slot area did not restore visibility");
    height = 0;
    await compositor.publish();
    assert.equal(record.surfaces[0].visible, false, "a zero-height slot presents its retained native frame");
    assert.equal(record.surfaces.length, 1, "a zero-height slot disposed its live surface");
    height = 100;
    await compositor.publish();
    assert.equal(record.surfaces[0].visible, true, "restoring the slot height did not restore visibility");
  } finally { dom.window.close(); }
});
