// 두 호스트의 최종 요청과 표시 좌표를 비교한다.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
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

/** Every visible settled surface frame in the last layout request. */
const settledFrames = (lines) => {
  const call = [...(transcript(lines).get("syncSurfaces") ?? [])].reverse()
    .find((entry) => /"settled":true/.test(entry.request));
  return call && JSON.parse(call.request).surfaces.filter((surface) => surface.visible)
    .map(({ x, y, w, h }) => ({ x, y, width: w, height: h }));
};

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
      "left", "right", "sidebarMinWidth", "sidebarMaxWidth", "sidebarWidth", "sets", "links",
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
    const expectedFrames = states[name].fresh.window.surfaces.filter((item) => item.visible).map((item) => item.frame);
    const dragLog = await s.transcript();
    results[name] = await drag(t, s, PLAN);
    // 끌기 도중 멈춘 순간에도 확정 배치가 생긴다. 끌기는 제자리로 돌아오므로, 마지막 확정 배치가 끌기 전
    // 배치와 같아질 때까지 기다린다.
    try {
      await dragLog.until((lines) => {
        const actualFrames = settledFrames(lines);
        const lastSync = lines.findLastIndex((line) => /^host syncSurfaces .*"settled":true/.test(line));
        const lastPresent = lines.findLastIndex((line) => /^host presentSurfaces .*"settled":true.* ->/.test(line));
        return actualFrames?.length === expectedFrames.length && actualFrames.every((frame, index) =>
          ["x", "y", "width", "height"].every((key) => Math.abs(frame[key] - expectedFrames[index][key]) < 0.5)) &&
          lastPresent > lastSync;
      }, "the drag did not end with a settled commit at its starting surface frames");
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
  const dragState = Object.fromEntries(Object.entries(results).map(([name, result]) => [name, {
    from: result.from, steps: result.steps, took: result.took, asked: result.asked,
    late: result.late, deepest: result.deepest, boundary: boundary(result),
  }]));
  const stateReport = `window, document, and layout settings by host: ${JSON.stringify(states)}`;
  assert.equal(restedTauri.request, restedWails.request, "the two hosts give the page a different plane to lay out " +
    `after the drag:\nWails ${restedWails.request}\nTauri ${restedTauri.request}\n` +
    `settled first-surface x: Wails ${JSON.stringify(settledX(dragged.wailsv3))}, Tauri ${JSON.stringify(settledX(dragged.tauriv2))}; ` +
    `drag measurements: ${JSON.stringify(dragState)}; ` +
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
    // 간헐적인 차이를 분류할 수 있도록 실패 메시지에 두 호스트의 요청과 응답을 모두 적는다.
    const answers = `\nWails ${mine.request} -> ${mine.answer}\nTauri ${theirs.request} -> ${theirs.answer}`;
    assert.equal(theirs.request, mine.request, `${name} was asked differently:${answers}`);
    assert.equal(theirs.answer, mine.answer, `${name} was answered differently:${answers}`);
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

/** 호스트 계약 명세의 메뉴 표. 선언이 곧 기준이므로 검사는 명세 파일에서 읽는다. */
async function menuContract() {
  const { specMenuTables } = await import("../scripts/check-host-parity.mjs");
  return specMenuTables(readFileSync(new URL("../docs/spec/host-contract.md", import.meta.url), "utf8"));
}

/** 계약표의 보기 메뉴에서 빌더가 만드는(title) 항목 제목의 수. 시스템 행은 이보다 많은 항목을 기다린다. */
function declaredViewTitles(contract) {
  return contract.items.filter(([menu, , source]) => menu === "view" && source === "title");
}

/** 관측된 메뉴에서 호스트마다 다른 값(앱 이름, 창 목록, 시스템이 더한 꼬리)을 정규화한다.
    계약표의 행 수만큼만 비교한다. 그 뒤의 항목(자동 완성·받아쓰기·이모지 대체키 등)은 macOS 가
    프레임워크 구성에 따라 제각각 더하므로 어느 호스트도 소유하지 않는다. */
function normalizeMenus(menus, names, windowTitles, declaredCounts) {
  // 이름은 긴 것부터 바꾼다(짧은 이름이 긴 이름의 앞부분이기 때문이다).
  const neutralize = (text) => [...names].sort((a, b) => b.length - a.length)
    .reduce((value, name) => value.replaceAll(name, "APP"), text);
  return menus.map((menu, index) => ({
    title: neutralize(menu.title),
    items: menu.items
      .filter((item) => !windowTitles.includes(item.title))
      .slice(0, declaredCounts?.[index] ?? menu.items.length)
      .map((item) => ({ title: neutralize(item.title), key: item.key })),
  }));
}

test("both hosts serve the declared application menu", async (t) => {
  const sessions = await both(t);
  if (!sessions) return t.skip("both hosts must be built");
  const contract = await menuContract();
  // 호스트가 보고한 활성 언어가 기준이다. 제목에서 추측하지 않는다(docs/spec/host-contract.md).
  // 보고된 언어는 표의 언어 열이어야 하고, 새 언어는 열을 추가해 선언된다.
  const columns = contract.languages;
  // 각 상위 메뉴에서 비교할 항목 수는 계약표의 행 수다(시스템 꼬리는 제외).
  const declaredCounts = contract.menus.map(([id]) => contract.items.filter(([menu]) => menu === id).length);
  const observed = {};
  for (const [name, s] of Object.entries(sessions)) {
    // 전체 화면 항목은 이제 호스트가 만든다(V5-112) — 시스템의 지연 삽입을 기다리던 메뉴
    // 막대 자동화는 버리고, 선언된 자릿수가 채워지기를 구조로 기다린다.
    const settled = await s.until("host.menu", (value) => {
      const view = value?.menus?.find((menu) => menu.title === "보기" || menu.title === "View");
      return view && view.items.length >= declaredCounts[contract.menus.findIndex(([id]) => id === "view")]
        && view.items[view.items.length - 1].title.length > 0;
    }, "the declared View menu items did not all arrive", { timeout: 5000 });
    const report = settled;
    assert.ok(typeof report?.language === "string" && columns.includes(report.language),
      `host.menu must report a declared language: ${JSON.stringify(report).slice(0, 200)}`);
    // 앱 이름은 메뉴 제목과 항목 제목에서 서로 다른 길이로 나타난다(예: soksak 과
    // soksak-tauriv2). 둘 다 앱 이름이므로 함께 지운다.
    const names = [...new Set([report.menus[0].title, `soksak-${name}`])];
    const titles = (await s.get("host.windows")).map((entry) => entry.title);
    observed[name] = { language: report.language, menus: normalizeMenus(report.menus, names, titles, declaredCounts) };
  }
  const languages = Object.values(observed).map((value) => value.language);
  assert.equal(new Set(languages).size, 1, `both hosts must serve the same menu language: ${JSON.stringify(languages)}`);
  const column = columns.indexOf(languages[0]) + 1;

  // 관측된 메뉴는 선언된 상위 메뉴 순서와 제목을 따른다. app 메뉴 제목은 정규화된 앱 이름이다.
  const [first, ...rest] = Object.values(observed).map((value) => value.menus);
  for (const menus of [first, ...rest]) {
    assert.equal(menus.length, contract.menus.length, `menu count differs: ${JSON.stringify(menus.map((m) => m.title))}`);
    contract.menus.forEach((row, index) => {
      const expected = row[column];
      assert.equal(menus[index].title, row[0] === "app" ? "APP" : expected,
        `menu ${row[0]} title differs: ${JSON.stringify(menus[index])}`);
    });
  }

  // 각 메뉴의 처음 항목들은 선언된 표와 같다. title 항목은 제목과 키까지 같아야 하고 system 항목은
  // 자리와 존재만 같으면 된다(제목은 프레임워크가 언어에 따라 정한다). 표 뒤의 항목들은 시스템이
  // 더한 것이므로 호스트 사이 같음만 확인한다.
  const declared = Object.fromEntries(contract.menus.map(([id]) => [id, []]));
  // app 메뉴의 about·hide·quit 제목은 앱 이름을 앞에 단다(관측 정규화가 앱 이름을 APP 로
  // 바꾸므로 기대값도 같은 꼴로 맞춘다).
  const appPrefixed = new Set(["about", "hide", "quit"]);
  for (const row of contract.items) {
    declared[row[0]].push({
      id: row[1], source: row[2], key: row.at(-1),
      title: row[0] === "app" && appPrefixed.has(row[1]) ? `APP ${row[column + 2]}` : row[column + 2],
    });
  }
  for (const menus of [first, ...rest]) {
    contract.menus.forEach(([id], index) => {
      declared[id].forEach((item, offset) => {
        const actual = menus[index].items[offset];
        assert.ok(actual, `menu ${id} item ${item.id} is missing: ${JSON.stringify(menus[index])}`);
        if (item.source === "title") {
          assert.deepEqual(actual, { title: item.title, key: item.key },
            `menu ${id} item ${item.id} differs from the table: ${JSON.stringify(actual)}`);
        } else {
          assert.ok(actual.title.length > 0, `menu ${id} system item ${item.id} is empty`);
        }
      });
    });
  }
  // system 항목의 제목과 단축키는 프레임워크가 정하므로 호스트 간 비교에서는 자리 표시로
  // 바꾼다(위의 표 대조가 이미 자리와 존재를 검사한다).
  const markSystemItems = (menus) => menus.map((menu, index) => {
    const rows = contract.items.filter(([rowMenu]) => rowMenu === contract.menus[index][0]);
    return {
      title: menu.title,
      items: menu.items.map((item, offset) => rows[offset]?.[2] === "system" ? { title: "system", key: "" } : item),
    };
  });
  assert.deepEqual(markSystemItems(first), markSystemItems(rest[0]),
    "the two hosts must serve the same application menu");

  // 배치와 네이티브 표면은 웹뷰 확대를 따르지 않고, 다시 읽기는 메인 페이지 상태를 바꾼다.
  const forbidden = Object.values(observed).flatMap(({ menus }) => menus.flatMap((menu) => menu.items))
    .filter((item) => /zoom in|zoom out|actual size|reload/i.test(item.title));
  assert.deepEqual(forbidden, [], "no menu item zooms or reloads the whole webview");
});
