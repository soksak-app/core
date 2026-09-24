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

/** 페이지가 확정된 배치를 표시했다는 줄. */
const settled = (lines) => lines.some((line) => /^host presentSurfaces .*"settled":true.* ->/.test(line));

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
  const logs = {};
  for (const [name, s] of Object.entries(sessions)) {
    await fresh(s);
    const log = await s.transcript();
    await drag(t, s, PLAN);
    await log.until(settled, "the drag did not end with a settled commit");
    await s.run("core.settings.open");
    const { controls } = await s.until("core.settings-modal", (modal) => modal.open, "settings did not open");
    assert.ok(controls.some((c) => c.key === "nav:compositing"), "settings must have a compositing section");
    await s.run("core.settings-modal.nav", { section: "compositing" });
    await log.until((lines) => lines.some((line) => line.startsWith("host overlayPlace")), "settings were not placed");
    logs[name] = await log.stop();
    await s.run("core.settings.close");
  }

  const wails = transcript(logs.wailsv3);
  const tauri = transcript(logs.tauriv2);
  const restedWails = atRest(wails);
  const restedTauri = atRest(tauri);
  assert.ok(restedWails, `the Wails host recorded no settled commit:\n${logs.wailsv3.join("\n")}`);
  assert.ok(restedTauri, `the Tauri host recorded no settled commit:\n${logs.tauriv2.join("\n")}`);
  assert.equal(restedTauri.request, restedWails.request, "the two hosts give the page a different plane to lay out");
  assert.equal(restedTauri.answer, restedWails.answer, "the two hosts place the same surfaces differently");
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
