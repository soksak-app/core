// 모달의 표시 순서, 배경, 입력, 이동, 크기 변경 및 제거를 검사한다.
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, ask, nativeProbe } from "./app.mjs";

const renders = (log, id) =>
  log.split("\n").filter((line) => line.endsWith(`observe: modal rendered ${id}`)).length;

const nativeState = (binary, from = false) => nativeProbe(binary, { op: "state" }, from);
const evaluate = (binary, match, script) => nativeProbe(binary, { op: "eval", match, script });

function transparent(view) {
  assert.equal(view.drawsBackground, false, "the native webview must not paint a background before its DOM");
  assert.equal(view.backgroundAlpha, 0, "the under-page background must also be transparent");
}

function settingsAboveSurfaces(state) {
  const modal = state.views.findIndex((view) => view.url.includes("overlay.html?id=settings"));
  assert.ok(modal > 0, "the settings webview must exist in the main window");
  assert.equal(state.views[modal].hidden, false);
  assert.equal(modal, state.views.length - 1,
    `a native surface covers settings: ${JSON.stringify(state.views)}`);
  assert.equal(state.children, 0, "settings must not create a child OS window");
  transparent(state.views[modal]);
  const view = state.views[modal];
  assert.deepEqual([view.x, view.y, view.w, view.h], [0, 0, state.w, state.h],
    "the settings webview must cover background native content");
}

async function background(binary, state, enabled) {
  for (const [index, view] of state.views.entries()) {
    if (view.url.includes("overlay.html")) continue;
    const match = index === 0 ? "main" : view.url;
    const until = Date.now() + 10_000;
    for (;;) {
      const document = await evaluate(binary, match, '[location.href, document.readyState]');
      if (document[0] !== "about:blank" && document[1] !== "loading") break;
      assert.ok(Date.now() < until, `${view.url}: the document did not load`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(await evaluate(binary, match, 'getComputedStyle(document.documentElement).filter'),
      enabled ? "blur(3px)" : "none", `${view.url}: background blur must match dialog visibility`);
  }
}

async function until(read, accept, message) {
  const end = Date.now()+10000;
  let value;
  do {
    value = await read();
    if (accept(value)) return value;
    await new Promise(resolve=>setTimeout(resolve,20));
  } while (Date.now()<end);
  assert.fail(`${message}: ${JSON.stringify(value)}`);
}

async function openCompositing(binary) {
  const log = await ask(binary, 'click button.act[title="설정"]', text=>renders(text,'settings')>=1);
  if (!log) return null;
  await evaluate(binary,'overlay.html', `document.querySelector('[data-key="nav:compositing"]').click(); null`);
  await until(()=>evaluate(binary,'overlay.html',`Boolean(document.querySelector('[data-key="press:build"]'))`),Boolean,'settings content did not update');
  return true;
}

for (const [name, binary] of Object.entries(APPS)) {
  test(`${name}: an open modal's document receives the content the page updates`, async (t) => {
    if (!await openCompositing(binary)) return t.skip(`${binary} is not built`);
    assert.equal(await evaluate(binary, "overlay.html", 'getComputedStyle(document.documentElement).filter'),
      "none", "settings navigation must not copy the background blur into the dialog");
    assert.equal(await evaluate(binary, "overlay.html", 'getComputedStyle(document.body).backgroundColor'),
      "rgba(0, 0, 0, 0.5)", "settings navigation must preserve one 50% backdrop");
  });

  test(`${name}: rebuilding the layout from settings keeps settings above new surfaces`, async (t) => {
    if (!await openCompositing(binary)) return t.skip(`${binary} is not built`);
    const before = await nativeState(binary);
    settingsAboveSurfaces(before);
    await ask(binary, ['transcript on', 'click button[data-key="press:build"]'],
      (text) => renders(text, "settings") >= 1 && /host presentSurfaces .*"settled":true.* ->/.test(text),
      { from: false });
    const old = new Set(before.views.filter(v=>v.url.includes("terminal.html")).map(v=>v.url));
    const after = await until(()=>nativeState(binary), state=>state.views.some(v=>!v.hidden&&v.url.includes("terminal.html")&&!old.has(v.url)),
      "the layout rebuild did not display new native surfaces");
    assert.notDeepEqual(after.views.filter((v) => v.url.includes("terminal.html")).map((v) => v.url),
      before.views.filter((v) => v.url.includes("terminal.html")).map((v) => v.url),
      "the layout rebuild must create new native surfaces");
    settingsAboveSurfaces(after);
  });

  test(`${name}: reloading the main document removes its settings webview`, async (t) => {
    const opened = await ask(binary, 'click button.act[title="설정"]',
      (text) => renders(text, "settings") >= 1);
    if (!opened) return t.skip(`${binary} is not built`);
    settingsAboveSurfaces(await nativeState(binary));
    const reloaded = await nativeState(binary, true);
    assert.equal(reloaded.views.some((view) => view.url.includes("overlay.html")), false,
      "the old document's overlay survives after its owning DOM is gone");
    await background(binary, reloaded, false);
  });

  test(`${name}: settings blocks background input and closes only through its close button`, async (t) => {
    const opened = await ask(binary, ['transcript on', 'click button.act[title="설정"]'],
      (text) => renders(text, "settings") >= 1);
    if (!opened) return t.skip(`${binary} is not built`);
    const before = await nativeState(binary);
    settingsAboveSurfaces(before);
    await background(binary, before, true);
    const browser = before.views.find((view) => view.url.startsWith("https:"));
    const point = { x: browser.x + browser.w - 4, y: browser.y + browser.h / 2 };
    const hit = await nativeProbe(binary, { op: "hit", ...point });
    assert.ok(hit.url.includes("overlay.html?id=settings"), "native input must reach the settings webview");
    await evaluate(binary, "overlay.html", 'document.body.dispatchEvent(new KeyboardEvent("keydown", {key:"Escape", bubbles:true})); null');
    const remains = await evaluate(binary, "main", `
      document.querySelector('.set-scrim').dispatchEvent(new PointerEvent('pointerdown', {bubbles:true}));
      document.body.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}));
      !!document.querySelector('#settings');
    `);
    assert.equal(remains, true, "background clicks and Escape must not dismiss settings");
    settingsAboveSurfaces(await nativeState(binary));
    assert.deepEqual(await evaluate(binary, "overlay.html", `[
      document.querySelector('[data-native-modal]').dataset.nativeModal,
      getComputedStyle(document.documentElement).backgroundColor,
      getComputedStyle(document.body).backgroundColor
    ]`), ["dialog", "rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0.5)"]);
    await ask(binary, 'click .set-card__head .act[data-key="close"]',
      (text) => text.includes("host overlayHide"), { from: false });
    const closed = await nativeState(binary);
    await background(binary, closed, false);
    assert.equal(closed.views.some((view) => view.url.includes("overlay.html")), false);
    assert.equal((await nativeProbe(binary, { op: "hit", ...point })).url, browser.url,
      "closing settings must restore native browser input");
  });

  test(`${name}: add and split menus are transparent and have no backdrop`, async (t) => {
    for (const action of ["add", "x", "y"]) {
      const opened = await ask(binary, ['transcript on', `click .chrome__act[data-do="${action}"]`],
        (text) => renders(text, "picker") >= 1);
      if (!opened) return t.skip(`${binary} is not built`);
      const state = await nativeState(binary);
      const menu = state.views.at(-1);
      assert.ok(menu.url.includes("overlay.html?id=picker"));
      transparent(menu);
      await background(binary, state, false);
      assert.equal(await evaluate(binary, "overlay.html", 'getComputedStyle(document.body).backgroundColor'),
        "rgba(0, 0, 0, 0)", `${action} must not shade the background`);
      await ask(binary, 'native ' + JSON.stringify({ op: "eval", match: "overlay.html", script:
        'document.body.dispatchEvent(new KeyboardEvent("keydown", {key:"Escape", bubbles:true})); null' }),
        (text) => text.includes("host overlayHide"), { from: false });
      assert.equal((await nativeState(binary)).views.some((v) => v.url.includes("overlay.html")), false,
        `${action} must retain Escape cancellation`);
    }
  });

  test(`${name}: moving settings and resizing the parent preserves its native coverage`, async (t) => {
    const opened = await ask(binary, ['transcript on', 'click button.act[title="설정"]'],
      (text) => renders(text, "settings") >= 1);
    if (!opened) return t.skip(`${binary} is not built`);
    const rect = 'document.querySelector("#settings").getBoundingClientRect().toJSON()';
    const before = await evaluate(binary, "main", rect);
    await ask(binary, 'native ' + JSON.stringify({ op: "eval", match: "overlay.html", script: `
      document.querySelector('[data-grip]').dispatchEvent(new MouseEvent('mousedown', {bubbles:true, button:0, screenX:100, screenY:100}));
      window.dispatchEvent(new MouseEvent('mousemove', {screenX:170, screenY:130, buttons:1}));
      window.dispatchEvent(new MouseEvent('mouseup'));
      null;
    ` }), (text) => text.includes("host overlayPlace"), { from: false });
    const moved = await evaluate(binary, "main", rect);
    assert.deepEqual([moved.x - before.x, moved.y - before.y], [70, 30]);
    assert.deepEqual(await evaluate(binary, "overlay.html",
      'document.querySelector("[data-native-modal]").getBoundingClientRect().toJSON()'), moved);
    settingsAboveSurfaces(await nativeState(binary));
    await ask(binary, 'size 1000,620', (text) => text.includes("host overlayPlace"), { from: false });
    const state = await nativeState(binary);
    settingsAboveSurfaces(state);
    const resized = await evaluate(binary, "main", rect);
    assert.ok(resized.left >= 0 && resized.top >= 0 && resized.right <= state.w && resized.bottom <= state.h);
    assert.deepEqual(await evaluate(binary, "overlay.html",
      'document.querySelector("[data-native-modal]").getBoundingClientRect().toJSON()'), resized);
    await background(binary, state, true);
  });
}
