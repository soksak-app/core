// 브라우저 표면의 문서 영역이 검사가 띄운 로컬 HTTP 서버의 문서를 열고, 기록을 이동하고, 네이티브
// 입력을 받고, 표면을 따라 배치되고, 표면과 함께 닫히는지 검사한다.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { rmSync } from "node:fs";
import test from "node:test";

import { APPS, fresh, open } from "./app.mjs";
import { frames, pixel, readFrame } from "./frame.mjs";

/** 경로 이름을 제목으로 갖는 긴 문서를 주는 루프백 서버. 검사가 끝나면 닫는다. */
async function serve(t) {
  const server = createServer((request, response) => {
    const name = new URL(request.url, "http://127.0.0.1").pathname.slice(1) || "index";
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(`<!doctype html><title>${name}</title><style>
      :root, body { width:100%; height:100%; margin:0; }
      body { background:rgb(231,233,238); color:rgb(20,24,32); }
      @media (prefers-color-scheme: dark) {
        body { background:rgb(21,28,42); color:rgb(235,238,245); }
      }
    </style><body><div style="height:6000px">${name}</div>`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

const LIGHT_DOCUMENT = [231, 233, 238];
const DARK_DOCUMENT = [21, 28, 42];

/** 현재 문서 영역 중앙의 실제 창 픽셀을 캡처해 읽는다. */
async function documentPixel(t, s, surface) {
  const rect = await regionRect(s, surface);
  const capture = await s.request("diagnostics.capture.start", {});
  let stopped = false;
  t.after(async () => {
    if (!stopped) await s.request("diagnostics.capture.stop", { after: 0 });
    rmSync(capture.frames, { recursive: true, force: true });
  });
  const { displayed } = await s.presented();
  const result = await s.request("diagnostics.capture.stop", { after: displayed });
  stopped = true;
  const files = frames(result.frames);
  assert.ok(files.length > 0, "document pixel capture produced no frames");
  const frame = readFrame(files.at(-1));
  const x = Math.floor(rect.x + rect.width / 2);
  const y = Math.floor(rect.y + rect.height / 2);
  assert.ok(x >= 0 && y >= 0 && x < frame.width && y < frame.height,
    `document sample ${x},${y} is outside ${frame.width}×${frame.height}`);
  const value = pixel(frame, x, y);
  rmSync(result.frames, { recursive: true, force: true });
  return value;
}

const nearColour = (actual, expected) => actual.every((value, index) => Math.abs(value - expected[index]) <= 3);

/** 보이는 브라우저 표면이 browser.location 을 등록할 때까지 기다리고 그 표면들을 반환한다. */
async function browsers(s) {
  await s.until("core.surfaces",
    (list) => list.some((x) => x.visible && x.plugin === "browser" && x.exposes.includes("status browser.location")),
    "no visible browser surface registered browser.location");
  const active = new Set((await s.get("core.grid")).cards.map((card) => card.active).filter(Boolean));
  const current = await s.get("core.surfaces");
  const selected = current.filter((x) => x.visible && x.plugin === "browser" && active.has(x.surface));
  assert.ok(selected.length > 0, "current grid has no active visible browser surface");
  const ids = new Set(selected.map((x) => x.surface));
  await s.until("host.window", (window) => window.documents.some((document) =>
    ids.has(document.surface) && document.document === "page" && document.visible &&
    document.frame.width > 0 && document.frame.height > 0),
  "active browser surface has no visible native document");
  const settled = await s.get("core.surfaces");
  return settled.filter((x) => x.visible && x.plugin === "browser" && ids.has(x.surface));
}

/** 문서 영역이 url 을 다 읽고 제목을 알릴 때까지 기다린다. 제목은 읽기가 끝난 뒤에 올 수 있다. */
function loaded(s, surface, url) {
  const title = new URL(url).pathname.slice(1);
  return s.until("browser.location", (at) => at.url === url && !at.loading && at.error === null && at.title === title,
    `surface ${surface} did not load ${url} with the title ${title}`, { surface });
}

/** browser.document 요소의 창 좌표 사각형. */
async function regionRect(s, surface) {
  const rect = await s.rect("browser.document", undefined, surface);
  return { x: rect.document.x + rect.x, y: rect.document.y + rect.y, width: rect.width, height: rect.height };
}

/** 네이티브 프레임은 장치 픽셀 단위이고 요소의 사각형은 CSS 픽셀이므로 한 장치 픽셀까지 허용한다. */
const DEVICE_PIXEL = 0.5;

const near = (a, b) => ["x", "y", "width", "height"].every((key) => Math.abs(a[key] - b[key]) <= DEVICE_PIXEL);

/** host.window 의 문서 영역 프레임이 요소의 사각형과 같아질 때까지 기다린다. */
async function placed(s, surface, message) {
  await s.presented();
  const rect = await regionRect(s, surface);
  const state = await s.until("host.window", (w) => w.documents.some((d) =>
    d.surface === surface && d.document === "page" && d.visible && near(d.frame, rect)),
  `${message}: the document region did not take ${JSON.stringify(rect)}`);
  return { rect, state };
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: the browser document region navigates, takes native input, and follows its surface`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const base = await serve(t);
    const [browser] = await browsers(s);
    const surface = browser.surface;
    const at = (path) => `${base}/${path}`;

    await s.run("browser.navigate", { url: at("one") }, surface);
    await loaded(s, surface, at("one"));
    await s.run("browser.navigate", { url: at("two") }, surface);
    const second = await loaded(s, surface, at("two"));
    assert.equal(second.canGoBack, true);
    assert.equal(second.canGoForward, false);

    assert.equal(await s.run("browser.back", {}, surface), true);
    assert.equal((await loaded(s, surface, at("one"))).canGoForward, true);
    assert.equal(await s.run("browser.forward", {}, surface), true);
    await loaded(s, surface, at("two"));

    // 주소창을 네이티브 입력으로 누르고 주소를 입력한다.
    const field = await s.rect("browser.address", undefined, surface);
    await s.click(field.document.x + field.x + field.width / 2, field.document.y + field.y + field.height / 2);
    await s.press("a", { text: at("three") });
    await s.press("Enter");
    const third = await loaded(s, surface, at("three"));
    assert.deepEqual(third.scroll, { x: 0, y: 0 });

    // 문서 영역은 요소 자리에 있고, 그 점의 소유자다.
    const { rect, state } = await placed(s, surface, "after loading");
    const center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    assert.deepEqual(await s.run("host.hit", center), { kind: "document", surface, document: "page" });

    // 네이티브 스크롤은 문서를 요청한 거리만큼 움직이고 앱을 활성화하지 않는다.
    await s.pointer(center.x, center.y, "scroll", { deltaY: 120 });
    // WebKit 은 휠 이벤트 하나를 여러 단계로 스크롤할 수 있으므로 요청한 거리에 도달할 때까지 기다린다.
    const scrolled = await s.until("browser.location", (value) => value.scroll.y >= 120,
      "the document did not scroll by the requested distance", { surface });
    assert.deepEqual(scrolled.scroll, { x: 0, y: 120 });
    assert.equal((await s.get("host.window")).active, state.active, "native input must not change application activation");

    // 표면이 옮겨지고 크기가 바뀌면 문서 영역이 따라간다.
    const grid = await s.get("core.grid");
    await s.run("core.boundary.move", { axis: "y", line: 1, position: grid.lines.y[1] + 40 });
    const moved = await placed(s, surface, "after the surface moved");
    assert.ok(moved.rect.y > rect.y, `the region did not move: ${rect.y} → ${moved.rect.y}`);
    await s.run("core.boundary.move", { axis: "x", line: 2, position: grid.lines.x[2] - 60 });
    const resized = await placed(s, surface, "after the surface resized");
    assert.ok(resized.rect.width < moved.rect.width, `the region did not shrink: ${moved.rect.width} → ${resized.rect.width}`);

    // 다른 브라우저 표면은 이 표면의 문서 상태를 받지 않는다.
    const { tab } = await s.run("core.card.split", { card: grid.cards.find((c) => c.tabs.some((x) => x.id === surface)).id,
      axis: "x", plugin: "browser" });
    await s.until("core.surfaces", (list) => list.some((x) => x.surface === tab && x.exposes.includes("status browser.location")),
      "the second browser surface did not register");
    const other = await s.get("browser.location", tab);
    assert.ok(!other.url.startsWith(base), `surface ${tab} received this surface's document: ${other.url}`);
    await placed(s, tab, "the second browser");

    // 표면을 닫으면 문서 영역도 닫힌다.
    await s.run("core.tab.close", { tab: surface });
    await s.until("host.window", (w) => !w.documents.some((d) => d.surface === surface),
      "the document region stayed after its surface closed");
    await s.until("host.window", (w) => w.documents.some((d) => d.surface === tab),
      "closing one surface closed another surface's document region");
  });

  test(`${app.name}: browser document focus and isolation`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const base = await serve(t);
    const [browser] = await browsers(s);
    const surface = browser.surface;
    const at = (path) => `${base}/${path}`;

    await s.run("browser.navigate", { url: at("focus") }, surface);
    await loaded(s, surface, at("focus"));
    const first = await placed(s, surface, "focus document");
    const firstPoint = { x: first.rect.x + first.rect.width / 2, y: first.rect.y + first.rect.height / 2 };
    await s.pointer(firstPoint.x, firstPoint.y, "down");
    await s.pointer(firstPoint.x, firstPoint.y, "up");
    await s.until("host.window", (window) => window.documents.some((document) =>
      document.surface === surface && document.document === "page" && document.focused),
    "one click did not give the browser document native focus");
    await s.until("core.grid", (grid) => grid.cards.some((card) =>
      card.focused && card.tabs.some((tab) => tab.id === surface)), "one click did not select the browser card");
    await s.until("host.window", (window) => window.documents.some((document) =>
      document.surface === surface && document.document === "page" && document.visible &&
      document.frame.width > 0 && document.frame.height > 0),
    "the focused browser document did not settle after card selection");
    // 카드 선택이 만든 배치가 모두 표시된 뒤 잰다. 준비 중인 배치는 표면을 숨긴다.
    await s.presented();
    assert.deepEqual(await s.run("host.hit", firstPoint), { kind: "document", surface, document: "page" },
      "the click coordinate stopped hitting the focused browser document");
    await s.pointer(firstPoint.x, firstPoint.y, "scroll", { deltaY: 120 });
    await s.until("browser.location", (value) => value.scroll.y >= 120,
      "scroll did not reach the focused browser document", { surface });
    const card = (await s.get("core.grid")).cards.find((item) => item.tabs.some((tab) => tab.id === surface));
    const { tab: other } = await s.run("core.card.split", { card: card.id, axis: "x", plugin: "browser" });
    await s.until("core.surfaces", (list) => list.some((item) => item.surface === other &&
      item.exposes.includes("status browser.location")), "the second browser surface did not register");
    await s.run("browser.navigate", { url: at("other") }, other);
    await loaded(s, other, at("other"));
    const second = await placed(s, other, "second focus document");
    const secondPoint = { x: second.rect.x + second.rect.width / 2, y: second.rect.y + second.rect.height / 2 };
    await s.pointer(secondPoint.x, secondPoint.y, "down");
    await s.pointer(secondPoint.x, secondPoint.y, "up");
    await s.until("host.window", (window) => {
      const documents = new Map(window.documents.map((document) => [document.surface, document]));
      return documents.get(other)?.focused === true && documents.get(surface)?.focused === false;
    }, "focus did not move exclusively to the second browser document");
  });

  test(`${app.name}: browser documents follow host theme pixels for existing, new, and reloaded documents`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const base = await serve(t);
    const [browser] = await browsers(s);
    const surface = browser.surface;
    const at = (path) => `${base}/${path}`;

    await s.run("browser.navigate", { url: at("theme-existing") }, surface);
    await loaded(s, surface, at("theme-existing"));
    await placed(s, surface, "initial themed document");
    await s.run("core.settings.set", { patch: { mode: "light" } });
    await s.until("core.settings", (value) => value.values.mode === "light" && !value.saving,
      "host did not settle light theme");
    assert.ok(nearColour(await documentPixel(t, s, surface), LIGHT_DOCUMENT),
      "existing document did not render the light host theme");

    await s.run("core.settings.set", { patch: { mode: "dark" } });
    await s.until("core.settings", (value) => value.values.mode === "dark" && !value.saving,
      "host did not settle dark theme");
    assert.ok(nearColour(await documentPixel(t, s, surface), DARK_DOCUMENT),
      "existing document did not render the dark host theme");

    await s.run("core.settings.set", { patch: { mode: "light" } });
    await s.until("core.settings", (value) => value.values.mode === "light" && !value.saving,
      "host did not settle light theme again");
    assert.ok(nearColour(await documentPixel(t, s, surface), LIGHT_DOCUMENT),
      "existing document did not return to the light host theme");

    const grid = await s.get("core.grid");
    const card = grid.cards.find((item) => item.tabs.some((tab) => tab.id === surface));
    const { tab: added } = await s.run("core.card.split", { card: card.id, axis: "x", plugin: "browser" });
    await s.until("core.surfaces", (list) => list.some((item) => item.surface === added && item.visible &&
      item.exposes.includes("status browser.location")), "new browser document did not register");
    await s.run("browser.navigate", { url: at("theme-new") }, added);
    await loaded(s, added, at("theme-new"));
    await placed(s, added, "new themed document");
    assert.ok(nearColour(await documentPixel(t, s, added), LIGHT_DOCUMENT),
      "new document did not inherit the light host theme");

    await s.run("core.settings.set", { patch: { mode: "dark" } });
    await s.until("core.settings", (value) => value.values.mode === "dark" && !value.saving,
      "host did not settle dark theme before reload");
    await s.run("host.window.reload");
    await s.until("core.window.document", (doc) => doc.readyState === "complete", "main document did not reload");
    const restored = await browsers(s);
    const restoredSurface = restored.find((item) => item.surface === surface)?.surface ?? restored[0]?.surface;
    assert.ok(restoredSurface, "reloaded browser document did not restore");
    await loaded(s, restoredSurface, at("theme-existing"));
    await placed(s, restoredSurface, "reloaded themed document");
    const restoredPixel = await documentPixel(t, s, restoredSurface);
    assert.ok(nearColour(restoredPixel, DARK_DOCUMENT),
      `reloaded document did not retain the dark host theme: ${JSON.stringify(restoredPixel)}`);
  });

  test(`${app.name}: Google site appearance remains independent of host theme`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const [browser] = await browsers(s);
    const surface = browser.surface;
    const google = "https://www.google.com/";
    await s.run("browser.navigate", { url: google }, surface);
    const location = await s.until("browser.location", (value) =>
      /^https:\/\/(www\.)?google\.[^/]+\//i.test(value.url) && !value.loading && value.error === null && value.title !== "",
    "Google did not load a successful document", { surface });
    assert.match(location.url, /^https:\/\/(www\.)?google\.[^/]+\//i);
    await placed(s, surface, "Google document");
    await s.run("core.settings.set", { patch: { mode: "light" } });
    await s.until("core.settings", (value) => value.values.mode === "light" && !value.saving,
      "host did not settle light theme for Google");
    const light = await documentPixel(t, s, surface);
    await s.run("core.settings.set", { patch: { mode: "dark" } });
    await s.until("core.settings", (value) => value.values.mode === "dark" && !value.saving,
      "host did not settle dark theme for Google");
    const dark = await documentPixel(t, s, surface);
    assert.deepEqual(light, [255, 255, 255], `Google site preference was not light in the disposable profile: ${JSON.stringify(light)}`);
    assert.deepEqual(dark, light,
      `Google's site preference was overwritten by the host theme: ${JSON.stringify({ light, dark })}`);
    assert.equal((await s.get("browser.location", surface)).url, location.url,
      "host theme change must not change Google's site location");
  });
}
