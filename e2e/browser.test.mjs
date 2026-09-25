// 브라우저 표면의 문서 영역이 검사가 띄운 로컬 HTTP 서버의 문서를 열고, 기록을 이동하고, 네이티브
// 입력을 받고, 표면을 따라 배치되고, 표면과 함께 닫히는지 검사한다.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { rmSync } from "node:fs";
import test from "node:test";

import { APPS, fresh, open } from "./app.mjs";
import { frames, pixel, readFrame } from "./frame.mjs";

/** block 문서의 왼쪽 위에 놓는 CSS 크기 120×60 의 빨간 블록. 페이지 확대만큼 픽셀이 커진다. */
const BLOCK = '<div style="position:absolute;left:0;top:0;width:120px;height:60px;background:rgb(220,30,30)"></div>';

/** 문서 영역에서 빨간 블록의 픽셀 폭과 높이를 잰다. */
async function blockSize(s, surface) {
  const { rect } = await placed(s, surface, "block document");
  const { displayed } = await s.presented();
  await s.request("diagnostics.capture.start", {});
  const result = await s.request("diagnostics.capture.stop", { after: displayed });
  try {
    const files = frames(result.frames);
    assert.ok(files.length > 0, "block capture produced no frames");
    const frame = readFrame(files.at(-1));
    const scale = frame.scale;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let y = Math.round(rect.y * scale); y < Math.round((rect.y + rect.height) * scale) && y < frame.height; y++) {
      for (let x = Math.round(rect.x * scale); x < Math.round((rect.x + rect.width) * scale) && x < frame.width; x++) {
        const [r, g, b] = pixel(frame, x, y);
        if (r >= 180 && g <= 80 && b <= 80) {
          minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        }
      }
    }
    assert.ok(maxX >= minX, "the red block was not found in the document pixels");
    return { width: maxX - minX + 1, height: maxY - minY + 1, rect };
  } finally {
    rmSync(result.frames, { recursive: true, force: true });
  }
}

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
    </style>${name === "scheme" ? "<script>document.title = matchMedia('(prefers-color-scheme: dark)').matches ? 'scheme-dark' : 'scheme-light'</script>" : ""}<body>${name === "block" ? BLOCK : ""}<div style="height:6000px">${name}</div>`);
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
async function documentPixel(t, s, surface, at = (rect) => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 })) {
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
  const point = at(rect);
  const x = Math.floor(point.x);
  const y = Math.floor(point.y);
  assert.ok(x >= 0 && y >= 0 && x < frame.width && y < frame.height,
    `document sample ${x},${y} is outside ${frame.width}×${frame.height}`);
  const value = pixel(frame, x, y);
  rmSync(result.frames, { recursive: true, force: true });
  return value;
}

const nearColour = (actual, expected) => actual.every((value, index) => Math.abs(value - expected[index]) <= 3);

/** 보이는 브라우저 표면이 browser.location 을 등록할 때까지 기다리고 활성 표면들을 반환한다. */
async function browsers(s) {
  await s.until("core.surfaces",
    (list) => list.some((x) => x.visible && x.plugin === "browser" && x.exposes.includes("status browser.location")),
    "no visible browser surface registered browser.location");
  const active = new Set((await s.get("core.grid")).cards.map((card) => card.active).filter(Boolean));
  const current = await s.get("core.surfaces");
  const selected = current.filter((x) => x.visible && x.plugin === "browser" && active.has(x.surface));
  assert.ok(selected.length > 0, "current grid has no active visible browser surface");
  // 주소가 없는 표면은 문서 영역을 숨기므로 영역의 표시는 각 검사가 주소를 연 뒤에 확인한다.
  return selected;
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
    // 주소가 없는 두 번째 표면은 문서 영역을 숨긴다.
    assert.equal(other.url, "", `surface ${tab} has an address: ${other.url}`);
    await s.until("host.window", (w) => w.documents.some((d) => d.surface === tab && d.document === "page" && !d.visible),
      "the second browser without an address shows its document region");

    // 표면을 닫으면 문서 영역도 닫힌다.
    await s.run("core.tab.close", { tab: surface });
    await s.until("host.window", (w) => !w.documents.some((d) => d.surface === surface),
      "the document region stayed after its surface closed");
    await s.until("host.window", (w) => w.documents.some((d) => d.surface === tab),
      "closing one surface closed another surface's document region");
  });

  test(`${app.name}: a browser without an address hides its document region and shows the empty state`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const base = await serve(t);
    const [browser] = await browsers(s);
    const surface = browser.surface;
    assert.equal((await s.get("browser.location", surface)).url, "", "the fresh browser surface already has an address");

    // 주소가 없으면 문서 영역은 보이지 않고 빈 상태가 문서 자리를 차지한다.
    await s.presented();
    const hidden = await s.until("host.window", (w) => w.documents.some((d) => d.surface === surface && d.document === "page"),
      "the browser surface has no document region");
    const region = hidden.documents.find((d) => d.surface === surface && d.document === "page");
    assert.equal(region.visible, false, `the document region is visible without an address: ${JSON.stringify(region)}`);
    const empty = await s.rect("browser.empty", undefined, surface);
    assert.ok(empty.width > 0 && empty.height > 0, `the empty state is not shown: ${JSON.stringify(empty)}`);

    // 빈 상태를 누르면 주소창이 초점을 받아 입력한 주소를 연다.
    const point = { x: empty.document.x + empty.x + empty.width / 2, y: empty.document.y + empty.y + empty.height / 2 };
    assert.deepEqual(await s.run("host.hit", point), { kind: "page" },
      "the empty state point does not belong to the page");
    await s.click(point.x, point.y);
    await s.press("a", { text: `${base}/empty` });
    await s.press("Enter");
    await loaded(s, surface, `${base}/empty`);
    await placed(s, surface, "after the first address");
    const shown = await s.rect("browser.empty", undefined, surface);
    assert.equal(shown.width * shown.height, 0, `the empty state stayed after a load: ${JSON.stringify(shown)}`);
  });

  test(`${app.name}: the address field shows each loaded address and keeps text being typed`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const base = await serve(t);
    const [browser] = await browsers(s);
    const surface = browser.surface;
    const at = (path) => `${base}/${path}`;

    // 입력한 주소를 연 뒤에도 주소창은 초점을 유지한다.
    const field = await s.rect("browser.address", undefined, surface);
    await s.click(field.document.x + field.x + field.width / 2, field.document.y + field.y + field.height / 2);
    await s.press("a", { text: at("typed") });
    await s.press("Enter");
    await loaded(s, surface, at("typed"));
    await s.until("browser.address.text", (text) => text.focused && text.value === at("typed"),
      "the typed address is not in the focused address field", { surface });

    // 입력에서 오지 않은 이동은 주소창에 연 주소를 보인다.
    await s.run("browser.navigate", { url: at("other") }, surface);
    await loaded(s, surface, at("other"));
    await s.until("browser.address.text", (text) => text.value === at("other"),
      "the address field does not show the address opened by browser.navigate", { surface });

    // 입력 중인 글자는 문서 상태가 바뀌어도 바뀌지 않는다.
    await s.press("a", { text: "partial" });
    const typing = await s.until("browser.address.text", (text) => text.focused && text.value.endsWith("partial"),
      "the typed text did not reach the address field", { surface });
    const { rect } = await placed(s, surface, "while typing");
    await s.pointer(rect.x + rect.width / 2, rect.y + rect.height / 2, "scroll", { deltaY: 120 });
    await s.until("browser.location", (value) => value.scroll.y >= 120,
      "the document did not scroll while the address was being typed", { surface });
    assert.equal((await s.get("browser.address.text", surface)).value, typing.value,
      "a document state change replaced the text being typed");
  });

  test(`${app.name}: the browser history buttons draw the core icons at the card header button size`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const [browser] = await browsers(s);
    const surface = browser.surface;
    const buttons = [];
    for (const name of ["browser.back", "browser.forward", "browser.reload"]) {
      const rect = await s.rect(name, undefined, surface);
      assert.deepEqual([rect.width, rect.height], [20, 20], `${name} is not a 20×20 card header button: ${JSON.stringify(rect)}`);
      buttons.push({ name, x: rect.document.x + rect.x, y: rect.document.y + rect.y });
    }

    /** 단추 안의 픽셀 중 단추 모서리 픽셀과 다른 것의 수와 모서리 픽셀. */
    const ink = async ({ x, y }) => {
      const { displayed } = await s.presented();
      await s.request("diagnostics.capture.start", {});
      const result = await s.request("diagnostics.capture.stop", { after: displayed });
      try {
        const files = frames(result.frames);
        assert.ok(files.length > 0, "button capture produced no frames");
        const frame = readFrame(files.at(-1));
        const k = frame.scale;
        const corner = pixel(frame, Math.round((x + 1) * k), Math.round((y + 1) * k));
        let count = 0;
        for (let py = Math.round((y + 3) * k); py < Math.round((y + 17) * k); py++) {
          for (let px = Math.round((x + 3) * k); px < Math.round((x + 17) * k); px++) {
            const value = pixel(frame, px, py);
            if (value.some((c, i) => Math.abs(c - corner[i]) > 20)) count++;
          }
        }
        return { count, corner, scale: k };
      } finally {
        rmSync(result.frames, { recursive: true, force: true });
      }
    };
    for (const button of buttons) {
      const measured = await ink(button);
      // 14px 셰브런의 두 획은 길이 약 12 CSS 픽셀, 굵기 약 1 CSS 픽셀이다.
      assert.ok(measured.count >= 12 * measured.scale ** 2, `${button.name} draws ${measured.count} icon pixels: ${JSON.stringify(measured)}`);
    }
  });

  test(`${app.name}: a card focus keeps a shown document visible while its placement is prepared`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const base = await serve(t);
    const [browser] = await browsers(s);
    const surface = browser.surface;
    await s.run("browser.navigate", { url: `${base}/focus` }, surface);
    await loaded(s, surface, `${base}/focus`);
    await placed(s, surface, "focus document");
    await s.run("core.card.focus", { card: "shell" });
    await s.presented();

    // 준비 요청은 창의 레이어 트랜잭션 안에서 적용되어 커밋 전에는 화면에 나오지 않는다. 그동안 화면에 보이는
    // 표면이 숨으면 그 자리의 누름은 표면 대신 페이지로 간다. 위치가 그대로인 카드 포커스는 표면을 숨기지 않는다.
    const log = await s.transcript();
    for (const card of ["browser", "shell", "browser"]) {
      await s.run("core.card.focus", { card });
      await s.presented();
    }
    const lines = await log.stop();
    const requests = lines.map((line) => /^host syncSurfaces (\{.*\}) ->/.exec(line)).filter(Boolean)
      .map((found) => JSON.parse(found[1]));
    assert.ok(requests.length >= 3, `the card focus changes made ${requests.length} placement requests`);
    const hiding = requests.filter((request) => request.surfaces.some((item) => item.id === surface && item.visible === false));
    assert.equal(hiding.length, 0, `a placement request hid the shown browser surface: ${JSON.stringify(hiding[0])}`);
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
    // 앱 밝은 모드에서 문서 영역이 받는 prefers-color-scheme 을 로컬 문서의 제목으로 잰다.
    await s.run("core.settings.set", { patch: { mode: "light" } });
    await s.until("core.settings", (value) => value.values.mode === "light" && !value.saving, "host did not settle light theme");
    const base = await serve(t);
    await s.run("browser.navigate", { url: `${base}/scheme` }, surface);
    const scheme = (await s.until("browser.location", (value) => value.url === `${base}/scheme` && !value.loading &&
      /^scheme-(dark|light)$/.test(value.title), "the scheme document did not report its color scheme", { surface })).title;
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
    // 실패하면 표본 점과 모서리의 픽셀, 점의 소유자, 문서 영역, 앱 모드와 문서 상태를 함께 알린다.
    const rect = await regionRect(s, surface);
    const sample = { x: Math.floor(rect.x + rect.width / 2), y: Math.floor(rect.y + rect.height / 2) };
    const measuredLight = { light, scheme, sample, hit: await s.run("host.hit", sample),
      corner: await documentPixel(t, s, surface, (r) => ({ x: r.x + 4, y: r.y + 4 })),
      region: (await s.get("host.window")).documents.find((d) => d.surface === surface),
      mode: (await s.get("core.settings")).values.mode,
      location: await s.get("browser.location", surface) };
    await s.run("core.settings.set", { patch: { mode: "dark" } });
    await s.until("core.settings", (value) => value.values.mode === "dark" && !value.saving,
      "host did not settle dark theme for Google");
    const dark = await documentPixel(t, s, surface);
    // 문서 저장소는 검사 설정 폴더와 달리 실행 사이에 남으므로 Google 이 기억한 자기 모양은 실행마다 다를 수 있다.
    // 계약은 앱 모드가 그 모양을 바꾸지 않는 것이고, 문서 영역의 prefers-color-scheme 은 앱 모드를 따른다.
    assert.equal(scheme, "scheme-light", `the region did not receive the light color scheme: ${JSON.stringify(measuredLight)}`);
    assert.deepEqual(dark, light,
      `Google's site preference was overwritten by the host theme: ${JSON.stringify({ ...measuredLight, dark })}`);
    assert.equal((await s.get("browser.location", surface)).url, location.url,
      "host theme change must not change Google's site location");
  });
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: the browser document zoom follows the pressed card's text size`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const base = await serve(t);
    const [browser] = await browsers(s);
    const surface = browser.surface;
    const url = `${base}/block`;
    await s.run("browser.navigate", { url }, surface);
    await loaded(s, surface, url);
    // 브라우저 카드를 누르면 그 카드가 범위다. 누르면 포커스가 바뀌어 배치도 바뀌므로 그 뒤에 잰다.
    const address = await s.rect("browser.address", undefined, surface);
    await s.click(address.document.x + address.x + address.width / 2, address.document.y + address.y + address.height / 2);
    await s.until("core.text", (value) => value.scope.kind === "card", "pressing the browser card did not make it the scope");
    const before = await blockSize(s, surface);
    // 두 단계 뒤 배율은 1.25 다.
    await s.run("host.menu.select", { menu: "View", title: "글자 크게" });
    await s.run("host.menu.select", { menu: "View", title: "글자 크게" });
    const card = (await s.get("core.grid")).cards.find((item) => item.tabs.some((tab) => tab.id === surface));
    await s.until("core.text", (value) => value.cards[card.id] === 1.25, "the browser card did not reach factor 1.25");
    const after = await blockSize(s, surface);
    assert.ok(Math.abs(after.width / before.width - 1.25) <= 0.05 && Math.abs(after.height / before.height - 1.25) <= 0.05,
      `the document block must grow by the factor: ${JSON.stringify(before)} → ${JSON.stringify(after)}`);
    // blockSize 는 영역이 자기 요소의 사각형에 놓일 때까지 기다린 뒤 잰다. 카드 글자가 커지면 주소창도
    // 커지므로 요소의 높이는 줄 수 있다.
  });
}
