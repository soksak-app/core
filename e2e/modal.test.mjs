// 모달의 표시 순서, 배경, 입력, 이동, 크기 변경 및 제거를 검사한다.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { APPS, fresh, open } from "./app.mjs";

/** 빈 문서 하나를 주는 루프백 서버의 주소. 검사가 끝나면 닫는다. */
async function serveDocument(t) {
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end("<!doctype html><title>modal</title>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}/modal`;
}

/** 모달 웹뷰가 자기 배경을 칠하지 않는지 확인한다. */
function transparent(modal) {
  assert.equal(modal.background.draws, false, "the native webview must not paint a background before its DOM");
  assert.equal(modal.background.alpha, 0, "the under-page background must also be transparent");
}

/** 설정 모달이 모든 네이티브 표면 위에서 창 전체를 덮는지 확인한다. */
function settingsAboveSurfaces(state) {
  const { modal } = state;
  assert.ok(modal && modal.id === "settings" && modal.shown, `settings must be shown: ${JSON.stringify(modal)}`);
  for (const surface of state.surfaces) {
    assert.ok(modal.order > surface.order, `native surface ${surface.id} covers settings: ${JSON.stringify(state.surfaces)}`);
  }
  for (const region of state.documents) {
    assert.ok(modal.order > region.order, `document region ${region.surface}/${region.document} covers settings`);
  }
  assert.equal(state.children, 0, "settings must not create a child OS window");
  transparent(modal);
  assert.deepEqual(modal.frame, { x: 0, y: 0, width: state.content.width, height: state.content.height },
    "the settings webview must cover background native content");
}

/** 배경 흐림이 메인 문서와 보이는 플러그인 표면 문서에 enabled 대로 적용되었는지 확인한다. */
async function background(s, enabled) {
  await s.until("core.window.document", (doc) => doc.background === enabled,
    `the main document background state must be ${enabled}`);
  for (const surface of await s.surfaces()) {
    if (!surface.exposes.includes("status core.surface.document")) continue;
    await s.until("core.surface.document", (doc) => doc.readyState !== "loading"
      && doc.filter === (enabled ? "blur(3px)" : "none"),
    `${surface.surface}: background blur must match dialog visibility`, { surface: surface.surface });
  }
}

/** 설정 모달을 열고 문서가 렌더를 보고할 때까지 기다린다. */
async function openSettings(s) {
  await s.run("core.settings.open");
  return s.until("core.modal", (modal) => modal?.id === "settings" && modal.document !== null,
    "settings did not render");
}

/** 이름과 키로 설정 모달 컨트롤을 찾는다. */
async function control(s, name, key) {
  const { controls } = await s.until("core.settings-modal",
    (modal) => modal.controls.some((c) => c.name === name && c.key === key), `settings control ${key} did not appear`);
  return controls.find((c) => c.name === name && c.key === key);
}

async function openSidebars(s) {
  await openSettings(s);
  await control(s, "core.settings-modal.nav", "nav:sidebars");
  await s.run("core.settings-modal.nav", { section: "sidebars" });
  await control(s, "core.settings-modal.create", "sets:create");
}

/** 모달 문서의 사각형이 메인 문서의 카드 사각형과 같아질 때까지 기다린다. */
async function modalAt(s, card) {
  return s.until("core.modal", (modal) => ["x", "y", "width", "height"].every((k) => modal?.document?.rect[k] === card[k]),
    `the modal document did not move to ${JSON.stringify(card)}`);
}

const rectOf = ({ x, y, width, height }) => ({ x, y, width, height });

for (const app of Object.values(APPS)) {
  test(`${app.name}: an open modal's document receives the content the page updates`, { timeout: 30000 }, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    await openSidebars(s);
    const { document } = await s.get("core.modal");
    assert.equal(document.filter, "none", "settings navigation must not copy the background blur into the dialog");
    assert.equal(document.bodyBackground, "rgba(0, 0, 0, 0)", "the modal body must remain transparent");
    assert.equal(document.scrimBackground, "rgba(0, 0, 0, 0.5)", "settings must draw one 50% scrim");
  });

  test(`${app.name}: a first modal answer that arrives after later changes keeps the moved position`, { timeout: 30000 }, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    await s.request("diagnostics.modal.hold", { on: true });
    s.cleanup(() => s.request("diagnostics.modal.hold", { on: false }));
    await s.run("core.settings.open");
    await s.request("diagnostics.modal.held");
    // 첫 응답을 붙잡은 동안 내용 이벤트가 모달을 그리고 위치 이벤트가 모달을 옮긴다.
    await s.run("core.settings-modal.nav", { section: "sidebars" });
    const shown = await s.until("core.modal", (modal) => modal?.document?.loaded === false,
      "the content event did not render the modal before its first answer");
    await s.run("core.settings-modal.move", { dx: 40, dy: 20 });
    const moved = await s.until("core.settings-modal",
      (modal) => modal.card.x === shown.document.rect.x + 40 && modal.card.y === shown.document.rect.y + 20,
      "core.settings-modal.move did not move the card by 40,20");
    await s.until("core.modal", (modal) => modal.document.rect.x === moved.card.x && modal.document.rect.y === moved.card.y,
      "the position event did not move the modal document");
    await s.request("diagnostics.modal.hold", { on: false });
    const loaded = await s.until("core.modal", (modal) => modal.document.loaded, "the modal document did not handle its first answer");
    assert.deepEqual([loaded.document.rect.x, loaded.document.rect.y], [moved.card.x, moved.card.y],
      "the first answer moved the modal document back");
    await s.run("core.settings.close");
  });

  test(`${app.name}: a card split while settings are open keeps settings above new surfaces`, { timeout: 30000 }, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    await openSidebars(s);
    await s.presented();
    const before = await s.get("host.window");
    settingsAboveSurfaces(before);
    const old = new Set(before.surfaces.map((x) => x.id));
    await s.run("core.card.split", { card: "shell", side: "right", plugin: "browser" });
    const after = await s.until("host.window",
      (state) => state.surfaces.some((x) => x.visible && !old.has(x.id)) && state.modal?.shown,
      "the split did not display a new native surface");
    assert.ok(after.surfaces.some((x) => !old.has(x.id)), "the split must create a new native surface");
    await s.presented();
    settingsAboveSurfaces(await s.get("host.window"));
  });

  test(`${app.name}: reloading the main document removes its settings webview`, { timeout: 30000 }, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    await openSettings(s);
    await s.presented();
    settingsAboveSurfaces(await s.get("host.window"));
    const origin = (await s.get("core.window.document")).timeOrigin;
    await s.run("host.window.reload");
    await s.until("core.window.document", (doc) => doc.timeOrigin !== origin && doc.readyState === "complete",
      "the main document did not reload");
    await s.until("host.window", (state) => state.modal === null,
      "the old document's overlay survives after its owning DOM is gone");
    await background(s, false);
  });

  test(`${app.name}: settings blocks background input and closes only through its close button`, { timeout: 30000 }, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const [browser] = await s.surfaces("browser");
    assert.ok(browser, "a browser surface must be visible");
    // 주소가 없는 브라우저는 문서 영역을 숨기므로 주소를 열어 문서 영역을 보이게 한다.
    const url = await serveDocument(t);
    await s.run("browser.navigate", { url }, browser.surface);
    await s.until("browser.location", (at) => at.url === url && !at.loading, `the browser did not load ${url}`, { surface: browser.surface });
    await s.until("host.window", (w) => w.documents.some((d) => d.surface === browser.surface && d.document === "page" && d.visible),
      "the browser document region is not visible after the load");
    await openSettings(s);
    await s.presented();
    settingsAboveSurfaces(await s.get("host.window"));
    await background(s, true);
    // 브라우저 표면의 가운데 오른쪽은 그 표면의 문서 영역이다.
    const frame = browser.applied;
    const point = { x: frame.x + frame.w - 4, y: frame.y + frame.h / 2 };
    const modalHit = await s.run("host.hit", point);
    assert.equal(modalHit.kind, "native", "native input must reach the settings webview");
    assert.equal(modalHit.identifier, "modal:settings", "native input must identify the settings webview");
    assert.ok(modalHit.view?.class, `the settings hit view must report its class: ${JSON.stringify(modalHit)}`);
    assert.ok(modalHit.view.frame.x <= point.x && point.x < modalHit.view.frame.x + modalHit.view.frame.width &&
      modalHit.view.frame.y <= point.y && point.y < modalHit.view.frame.y + modalHit.view.frame.height,
    `the settings hit view frame must contain ${JSON.stringify(point)}: ${JSON.stringify(modalHit.view)}`);

    // 모달 안을 눌러 키보드 초점을 모달 문서에 둔 뒤 Escape 를 보낸다.
    const card = await s.rect("core.settings-modal.card");
    await s.click(card.x + card.width / 2, card.y + card.height - 8);
    await s.press("Escape");
    await s.act("core.settings-modal.scrim", "dispatch", { event: { type: "pointerdown" } });
    await s.act("core.settings-modal.scrim", "dispatch", { event: { type: "keydown", key: "Escape" } });
    await s.presented();
    assert.equal((await s.get("core.settings-modal")).open, true, "background clicks and Escape must not dismiss settings");
    settingsAboveSurfaces(await s.get("host.window"));
    const { document } = await s.get("core.modal");
    assert.deepEqual([document.mode, document.htmlBackground, document.bodyBackground, document.scrimBackground],
      ["dialog", "rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0.5)"]);

    await s.act("core.settings-modal.close", "click");
    await s.until("host.window", (state) => state.modal === null, "settings did not close");
    await background(s, false);
    await s.presented();
    assert.deepEqual(await s.run("host.hit", point), { kind: "document", surface: browser.surface, document: "page" },
      "closing settings must restore native input to the browser document");
  });

  test(`${app.name}: add and split menus are transparent and have no backdrop`, { timeout: 30000 }, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const card = (await s.get("core.grid")).cards.find((c) => c.pane === 0).id;
    for (const menu of ["add", "split-x", "split-y"]) {
      const name = `core.card.${menu}`;
      await s.run("core.card.menu", { card, menu });
      const state = await s.until("host.window", (w) => w.modal?.id === "picker" && w.modal.shown,
        `${name} did not show its menu`);
      transparent(state.modal);
      await background(s, false);
      const { document } = await s.until("core.modal", (modal) => modal?.id === "picker" && modal.document !== null,
        `${name} menu did not render`);
      assert.equal(document.bodyBackground, "rgba(0, 0, 0, 0)", `${name} must not shade the background`);
      // 메뉴는 열릴 때 키보드 초점을 받으므로 네이티브 Escape 가 메뉴 문서에 도달한다.
      await s.press("Escape");
      await s.until("host.window", (w) => w.modal === null, `${name} must retain Escape cancellation`);
    }
  });

  test(`${app.name}: moving settings and resizing the parent preserves its native coverage`, { timeout: 30000 }, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    await openSettings(s);
    await s.presented();
    const before = await s.rect("core.settings-modal.card");
    await modalAt(s, rectOf(before));
    const grip = await s.rect("core.settings-modal.grip");
    const from = { x: grip.x + grip.width / 2, y: grip.y + grip.height / 2 };
    await s.pointer(from.x, from.y, "down");
    await s.pointer(from.x + 35, from.y + 15, "drag");
    await s.pointer(from.x + 70, from.y + 30, "drag");
    await s.pointer(from.x + 70, from.y + 30, "up");
    const moved = await s.until("core.modal",
      (modal) => modal.document.rect.x === before.x + 70 && modal.document.rect.y === before.y + 30,
      "dragging the settings header by 70,30 did not move the card by the same distance");
    assert.deepEqual(rectOf(await s.rect("core.settings-modal.card")), moved.document.rect);
    await s.presented();
    settingsAboveSurfaces(await s.get("host.window"));

    await s.run("host.window.resize", { width: 1000, height: 620 });
    const state = await s.until("host.window", (w) => w.content.width === 1000 && w.content.height === 620
      && w.modal?.frame?.width === 1000 && w.modal.frame.height === 620, "the window and settings did not resize");
    settingsAboveSurfaces(state);
    await s.until("core.window.document", (doc) => doc.width === 1000 && doc.height === 620,
      "the main document did not take the new size");
    await s.presented();
    const resized = rectOf(await s.rect("core.settings-modal.card"));
    assert.ok(resized.x >= 0 && resized.y >= 0 && resized.x + resized.width <= 1000 && resized.y + resized.height <= 620,
      `settings must stay inside the window: ${JSON.stringify(resized)}`);
    await modalAt(s, resized);
    await background(s, true);
  });
}
