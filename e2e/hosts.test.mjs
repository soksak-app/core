// 두 호스트의 최종 요청과 표시 좌표를 비교한다.
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, drag, fresh, open } from "./app.mjs";

const PLAN = { axis: "x", line: 2, dx: -120, dy: 0, ms: 48, times: 2 };

const LINE = /^host (\w+) (\{.*\}|\[.*\]|null) -> (.*)$/;

/** 전사 줄을 호출 이름별 요청과 응답 목록으로 정리한다. 창마다 다른 id 는 순서 이름으로 바꾼다. */
function transcript(lines) {
  const names = new Map();
  const same = (text) =>
    text.replace(/"ticket":\d+,/g, "").replace(/(prj|spc|tab)-[a-z0-9]+/g, (id, kind) => {
      if (!names.has(id)) names.set(id, `${kind}-${names.size}`);
      return names.get(id);
    });
  const calls = new Map();
  for (const line of lines) {
    const found = LINE.exec(line);
    if (!found) continue;
    const [, name, request, answer] = found;
    if (!calls.has(name)) calls.set(name, []);
    calls.get(name).push({ request: same(request), answer: same(answer) });
  }
  return calls;
}

const atRest = (calls) => {
  const prepared = [...(calls.get("syncSurfaces") ?? [])].reverse().find((c) => /"settled":true/.test(c.request));
  const presented = [...(calls.get("presentSurfaces") ?? [])].reverse().find((c) => /"settled":true/.test(c.request));
  return prepared && presented && { request: prepared.request, answer: presented.answer };
};

const SIZE = { width: 1000, height: 620 };

/** 전사에서 확정된 배치 요청마다 첫 표면의 x. */
const settledX = (lines) => (transcript(lines).get("syncSurfaces") ?? [])
  .filter((call) => /"settled":true/.test(call.request)).map((call) => JSON.parse(call.request).surfaces[0]?.x);

/** 페이지가 확정된 배치를 표시했다는 줄. */
const settled = (lines) => lines.some((line) => /^host presentSurfaces .*"settled":true.* ->/.test(line));

/** 호스트 결과를 비교할 때 콘텐츠 크기와 레이아웃 입력을 기록한다. */
async function layoutState(s) {
  const [window, document, settings] = await Promise.all([
    s.get("host.window"), s.get("core.window.document"), s.get("core.settings"),
  ]);
  const values = settings.values;
  return {
    window: {
      frame: window.frame, content: window.content, scale: window.scale,
      maximized: window.maximized, active: window.active, occluded: window.occluded,
      surfaces: window.surfaces.map(({ id, frame, visible, order }) => ({ id, frame, visible, order })),
    },
    document,
    settings: Object.fromEntries([
      "rail", "left", "right", "sidebarMinWidth", "sidebarMaxWidth", "sidebarWidth", "links",
    ].map((key) => [key, values[key]])),
    project: settings.project,
    overridden: settings.overridden,
  };
}

/** 두 앱에 모두 연결한다. 한쪽이 빌드되지 않았으면 null 이다. */
async function both(t) {
  const sessions = {};
  for (const app of Object.values(APPS)) {
    const s = await open(t, app);
    if (!s) return null;
    sessions[app.name] = s;
  }
  return sessions;
}

test("both hosts answer the same page the same way", async (t) => {
  const sessions = await both(t);
  if (!sessions) return t.skip("both hosts must be built");
  const dragged = {};
  const results = {};
  const logs = {};
  const states = {};
  for (const [name, s] of Object.entries(sessions)) {
    await fresh(s);
    states[name] = { fresh: await layoutState(s) };
    // 끌기의 확정 배치는 설정 모달을 열기 전에 기록을 멈춰 얻는다. 모달은 창 전체의 오버레이로 다음 배치를
    // 바꾸며, 그 배치가 기록에 들어오는 시점은 호스트마다 다르다.
    const start = (await s.get("host.window")).surfaces.find((item) => item.frame.width > 0)?.frame.x;
    const dragLog = await s.transcript();
    results[name] = await drag(t, s, PLAN);
    // 끌기 도중 멈춘 순간에도 확정 배치가 생긴다. 끌기는 제자리로 돌아오므로, 마지막 확정 배치가 끌기 전
    // 배치와 같아질 때까지 기다린다.
    try {
      await dragLog.until((lines) => {
        const xs = settledX(lines);
        const lastSync = lines.findLastIndex((line) => /^host syncSurfaces .*"settled":true/.test(line));
        const lastPresent = lines.findLastIndex((line) => /^host presentSurfaces .*"settled":true.* ->/.test(line));
        return xs.length > 0 && xs.at(-1) === start && lastPresent > lastSync;
      }, "the drag did not end with a settled commit at its start position");
    } catch (error) {
      const now = await s.get("host.window");
      const grid = await s.get("core.grid");
      error.message += `\nstart x ${start}; drag result boundary ${JSON.stringify(results[name].boundary)}, steps ` +
        `${results[name].steps}, took ${results[name].took}; surfaces now ` +
        `${JSON.stringify(now.surfaces.map((item) => [item.frame.x, item.frame.width]))}; grid ${JSON.stringify(grid).slice(0, 600)}`;
      throw error;
    }
    dragged[name] = await dragLog.stop();
    states[name].afterDrag = await layoutState(s);
    const log = await s.transcript();
    await s.run("core.settings.open");
    const { controls } = await s.until("core.settings-modal", (modal) => modal.open, "settings did not open");
    assert.ok(controls.some((c) => c.key === "nav:sidebars"), "settings must have a sidebars section");
    await s.run("core.settings-modal.nav", { section: "sidebars" });
    await log.until((lines) => lines.some((line) => line.startsWith("host overlayPlace")), "settings were not placed");
    logs[name] = await log.stop();
    await s.run("core.settings.close");
  }

  const restedWails = atRest(transcript(dragged.wailsv3));
  const restedTauri = atRest(transcript(dragged.tauriv2));
  assert.ok(restedWails, `the Wails host recorded no settled commit:\n${dragged.wailsv3.join("\n")}`);
  assert.ok(restedTauri, `the Tauri host recorded no settled commit:\n${dragged.tauriv2.join("\n")}`);
  // 실패하면 호스트마다 확정된 배치의 첫 표면 x 순서와 끌기 결과의 경계를 적는다.
  const boundary = (result) => result.boundary && [result.boundary[0], result.boundary.at(-1)];
  const stateReport = `window, document, and layout settings by host: ${JSON.stringify(states)}`;
  assert.equal(restedTauri.request, restedWails.request, "the two hosts give the page a different plane to lay out " +
    `after the drag:\nWails ${restedWails.request}\nTauri ${restedTauri.request}\n` +
    `settled first-surface x: Wails ${JSON.stringify(settledX(dragged.wailsv3))}, Tauri ${JSON.stringify(settledX(dragged.tauriv2))}; ` +
    `drag boundary first and last: Wails ${JSON.stringify(boundary(results.wailsv3))}, Tauri ${JSON.stringify(boundary(results.tauriv2))}; ` +
    stateReport);
  assert.equal(restedTauri.answer, restedWails.answer,
    `the two hosts place the same surfaces differently; ${stateReport}`);
  const wails = transcript([...dragged.wailsv3, ...logs.wailsv3]);
  const tauri = transcript([...dragged.tauriv2, ...logs.tauriv2]);
  const onlyWails = [...wails.keys()].filter((name) => !tauri.has(name));
  const onlyTauri = [...tauri.keys()].filter((name) => !wails.has(name));
  assert.deepEqual({ onlyWails, onlyTauri }, { onlyWails: [], onlyTauri: [] },
    "the two hosts were asked for different things");
  for (const name of wails.keys()) {
    if (name === "syncSurfaces" || name === "presentSurfaces") continue;
    const mine = wails.get(name).at(-1);
    const theirs = tauri.get(name).at(-1);
    assert.equal(theirs.request, mine.request, `${name} was asked differently`);
    assert.equal(theirs.answer, mine.answer, `${name} was answered differently`);
  }
});

test("both hosts lay out the same page the same way after a resize", async (t) => {
  const sessions = await both(t);
  if (!sessions) return t.skip("both hosts must be built");
  const rested = {};
  for (const [name, s] of Object.entries(sessions)) {
    await fresh(s);
    const log = await s.transcript();
    await s.run("host.window.resize", SIZE);
    await s.until("host.window", (w) => w.content.width === SIZE.width && w.content.height === SIZE.height,
      "the window did not resize");
    await s.until("core.window.document", (doc) => doc.width === SIZE.width && doc.height === SIZE.height,
      "the main document did not take the new size");
    const lines = await log.until(settled, "the resize did not end with a settled commit").then(() => log.stop());
    const found = atRest(transcript(lines));
    assert.ok(found, `${name} recorded no settled commit after the resize:\n${lines.join("\n")}`);
    rested[name] = found;
  }
  assert.equal(rested.tauriv2.request, rested.wailsv3.request,
    `the two hosts give the page a different plane at ${SIZE.width}x${SIZE.height}`);
  assert.equal(rested.tauriv2.answer, rested.wailsv3.answer,
    `the two hosts place the same surfaces differently at ${SIZE.width}x${SIZE.height}`);
});

for (const app of Object.values(APPS)) {
  test(`${app.name}: the application menu does not zoom or reload the whole webview`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    const menus = await s.get("host.menu");
    const view = menus.find((menu) => menu.title === "View");
    assert.ok(view, `the application menu has no View menu: ${JSON.stringify(menus.map((menu) => menu.title))}`);
    // 배치와 네이티브 표면은 웹뷰 확대를 따르지 않고, 다시 읽기는 메인 페이지 상태를 바꾼다.
    // View 메뉴에는 전체 화면과 글자 크기 항목만 있다(docs/spec/text-size.md). macOS 는 F 키의 전체
    // 화면 항목을 스스로 더한다.
    const text = view.items.filter((item) => item.title.startsWith("글자 "));
    assert.deepEqual(text, [
      { title: "글자 크게", key: "cmd+=" }, { title: "글자 작게", key: "cmd+-" }, { title: "글자 기본 크기", key: "cmd+0" },
    ], `the View menu must have the text size items: ${JSON.stringify(view.items)}`);
    assert.ok(view.items.every((item) => /Full Screen/.test(item.title) || text.includes(item)),
      `the View menu must have only full screen and text size items: ${JSON.stringify(view.items)}`);
    const forbidden = menus.flatMap((menu) => menu.items)
      .filter((item) => /zoom in|zoom out|actual size|reload/i.test(item.title));
    assert.deepEqual(forbidden, [], "no menu item zooms or reloads the whole webview");
  });
}
