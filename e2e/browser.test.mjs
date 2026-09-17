// 브라우저 표면의 문서 영역이 검사가 띄운 로컬 HTTP 서버의 문서를 열고, 기록을 이동하고, 네이티브
// 입력을 받고, 표면을 따라 배치되고, 표면과 함께 닫히는지 검사한다.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { APPS, fresh, open } from "./app.mjs";

/** 경로 이름을 제목으로 갖는 긴 문서를 주는 루프백 서버. 검사가 끝나면 닫는다. */
async function serve(t) {
  const server = createServer((request, response) => {
    const name = new URL(request.url, "http://127.0.0.1").pathname.slice(1) || "index";
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(`<!doctype html><title>${name}</title><body style="margin:0"><div style="height:6000px">${name}</div>`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

/** 보이는 브라우저 표면이 browser.location 을 등록할 때까지 기다리고 그 표면들을 반환한다. */
async function browsers(s) {
  const all = await s.until("core.surfaces",
    (list) => list.some((x) => x.visible && x.plugin === "browser" && x.exposes.includes("status browser.location")),
    "no visible browser surface registered browser.location");
  return all.filter((x) => x.visible && x.plugin === "browser");
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
}
