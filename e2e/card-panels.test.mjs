// 카드 사방 지정 검사: 저장 세트와 공간에 따른 표시를 구분하고 탭 전환 뒤에도 유지한다.
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import test from "node:test";

import { APPS, fresh, keepCommonSettings, open } from "./app.mjs";
import { checkLinkedPanels } from "./linked-panels.mjs";
import { gripInk, requireCleared, tabSwitchPair } from "./card-panel-checks.mjs";
import { readPng } from "./png.mjs";
const geometry=grid=>grid.cards.map(({id,x,y,w,h})=>({id,x,y,w,h})).sort((a,b)=>a.id.localeCompare(b.id));

for (const app of Object.values(APPS)) {
  test(`${app.name}: assigned left and right panels reduce the actual native surface width`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    assert.ok(s, `${app.binary} is not built`);
    await fresh(s);
    const card = (await s.get("core.grid")).cards.find((item) => item.tabs?.length);
    assert.ok(card, "no content card to measure");
    const set = (await s.get("core.settings")).values.sets[0];
    for (const side of ["left", "right"]) {
      await s.run("core.card.sidebar.set", { card: card.id, side, set: set.id });
    }
    const grid = await s.get("core.grid");
    const measuredCard = grid.cards.find((item) => item.id === card.id);
    const surface = (await s.surfaces()).find((item) => item.surface === measuredCard.active);
    assert.ok(surface?.applied, `no applied native surface for ${JSON.stringify(measuredCard)}`);
    // 카드 보더 1포인트씩을 제외하고 좌우 190포인트만 한 번씩 차지해야 한다.
    const drawn = await s.get("core.sidebars");
    for (const side of ["left", "right"]) {
      assert.equal(drawn.filter((item) => item.sidebar === `${card.id}:${side}`).length, 1,
        `card must have exactly one ${side} region`);
    }
    assert.equal(drawn.filter((item) => item.sidebar === card.id || item.sidebar === `${card.id}:inset`).length, 0,
      "obsolete inset region remained mounted");
    const expectedWidth = measuredCard.w - 380 - 2;
    assert.ok(Math.abs(surface.applied.w - expectedWidth) <= 1,
      `two sides must reserve exactly 380 points without a second inset left: ${JSON.stringify({ expectedWidth, card: measuredCard, surface })}`);
    assert.equal(measuredCard.w, card.w, "assigning panels resized the card");
    for (const side of ["top", "bottom"]) {
      await s.run("core.card.sidebar.set", { card: card.id, side, set: set.id });
    }
    for (const side of ["top", "bottom", "left", "right"]) {
      await s.run("core.card.sidebar.toggle", { card: card.id, side });
    }
    await s.presented();
    for (let index = 0; index < 4; index++) {
      const grip = await s.rect("core.card.sidebar.grip", index);
      assert.ok(grip.width > 0 && grip.height > 0, `folded divider ${index} has no input area: ${JSON.stringify(grip)}`);
    }
    const foldedSurface = (await s.surfaces()).find((item) => item.surface === measuredCard.active);
    assert.ok(Math.abs(foldedSurface.applied.w - (measuredCard.w - 12 - 2)) <= 1,
      `folded sidebars must reserve only two 6-point dividers: ${JSON.stringify(foldedSurface)}`);
    // 접힌 면은 카드 사이 divider 와 같은 길이(라이브러리 grip 길이 24 CSS 픽셀)의 짧은 grip 만 그린다. 카드 폭이나
    // 높이 전체의 선은 경계선이 하나 더 있는 것처럼 보인다.
    const still = (await s.request("diagnostics.capture.still", {})).path;
    const image = readPng(still);
    rmSync(dirname(still), { recursive: true, force: true });
    const ratio = image.width / (await s.get("host.window")).content.width;
    for (let index = 0; index < 4; index++) {
      const grip = await s.rect("core.card.sidebar.grip", index);
      const ink = gripInk(image, grip, ratio);
      assert.ok(ink.longest > 0 && ink.longest <= 24 * ratio + 2 && ink.total === ink.longest,
        `folded divider ${index} must show one grip of at most 24 points: ${JSON.stringify({ grip, ink })}`);
    }
  });

  // 사용자 release 에서 셸 카드에 left/right/top 을 190 포인트씩 지정했는데 native 표면이 카드 폭과 거의 같았다
  // (V5-116-4-11-2). 같은 지정에서 native 사각형, grip 등록, DOM 과 native 의 일치를 함께 잰다.
  test(`${app.name}: left, right and top panels on the terminal card reserve their space in the native surface`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    assert.ok(s, `${app.binary} is not built`);
    await fresh(s);
    const card = (await s.get("core.grid")).cards.find((item) => item.id === "terminal");
    assert.ok(card, "the fixture has no terminal card");
    const set = (await s.get("core.settings")).values.sets[0];
    for (const side of ["left", "right", "top"]) {
      await s.run("core.card.sidebar.set", { card: card.id, side, set: set.id });
      await s.run("core.card.sidebar.size", { card: card.id, side, size: 190 });
    }
    await s.presented();
    const grid = await s.get("core.grid");
    const measured = grid.cards.find((item) => item.id === card.id);
    const surface = (await s.surfaces()).find((item) => item.surface === measured.active);
    assert.ok(surface?.applied, `no applied native surface for ${JSON.stringify(measured)}`);
    const band = (side) => (measured.sidebars[side] ? (measured.sidebars[side].collapsed ? 6 : measured.sidebars[side].size) : 0);
    const expected = {
      x: grid.plane.x + measured.x + 1 + band("left"),
      y: grid.plane.y + measured.y + 1 + 32 + band("top"),
      w: measured.w - 2 - band("left") - band("right"),
      h: measured.h - 2 - 32 - 22 - band("top") - band("bottom"),
    };
    const off = Object.keys(expected).filter((key) => Math.abs(surface.applied[key] - expected[key]) > 1);
    assert.deepEqual(off, [], `the native surface does not leave the panel space: ${JSON.stringify({ expected,
      applied: surface.applied, card: measured, sidebars: measured.sidebars })}`);
    const drawn = (await s.get("core.sidebars")).filter((item) => item.sidebar.startsWith(`${card.id}:`));
    assert.deepEqual(drawn.map((item) => item.sidebar).sort(), ["terminal:left", "terminal:right", "terminal:top"],
      "the terminal card does not draw exactly its three assigned panels");
    // 카드 패널마다 grip 하나가 입력 영역을 가진다.
    const panels = (await s.get("core.sidebars")).filter((item) => /:(left|right|top|bottom)$/.test(item.sidebar));
    for (let index = 0; index < panels.length; index++) {
      const grip = await s.rect("core.card.sidebar.grip", index);
      assert.ok(grip.width > 0 && grip.height > 0, `grip ${index} of ${panels.length} has no input area: ${JSON.stringify(grip)}`);
    }
    const failed = (await s.get("core.verify")).rows.filter((row) => !row.ok);
    assert.deepEqual(failed, [], "DOM and native geometry disagree");
    t.diagnostic(`terminal panels ${JSON.stringify({ expected, applied: surface.applied })}`);
  });

  // 끌기는 소수 크기를 넘긴다. 카드 테두리, divider, 준비한 표면 사각형은 장치 pixel 격자를 쓴다
  // (docs/spec/native-surfaces.md). 격자 밖의 크기도 표시는 격자 위에 있고, 선언과 적용이 같아야 한다(V5-115-1-3).
  test(`${app.name}: fractional panel sizes place the native surface on the device-pixel grid`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    assert.ok(s, `${app.binary} is not built`);
    await fresh(s);
    const card = (await s.get("core.grid")).cards.find((item) => item.id === "terminal");
    assert.ok(card, "the fixture has no terminal card");
    const set = (await s.get("core.settings")).values.sets[0];
    const scale = (await s.get("host.window")).scale;
    const sizes = { left: 120.5, top: 130.25, right: 140.75 };
    for (const [side, size] of Object.entries(sizes)) {
      await s.run("core.card.sidebar.set", { card: card.id, side, set: set.id });
      await s.run("core.card.sidebar.size", { card: card.id, side, size });
    }
    await s.presented();
    const measured = (await s.get("core.grid")).cards.find((item) => item.id === card.id);
    for (const [side, size] of Object.entries(sizes)) assert.equal(measured.sidebars[side].size, size, `${side} size was not kept`);
    const surface = (await s.surfaces()).find((item) => item.surface === measured.active);
    assert.ok(surface?.applied, "the terminal surface is not presented");
    const onGrid = (value) => Math.abs(value * scale - Math.round(value * scale)) < 1e-6;
    const edges = { left: surface.applied.x, top: surface.applied.y, right: surface.applied.x + surface.applied.w,
      bottom: surface.applied.y + surface.applied.h };
    assert.deepEqual(Object.entries(edges).filter(([, value]) => !onGrid(value)).map(([key]) => key), [],
      `native surface edges are off the ${scale}x device-pixel grid: ${JSON.stringify(surface)}`);
    const failed = (await s.get("core.verify")).rows.filter((row) => !row.ok);
    assert.deepEqual(failed, [], `DOM and native geometry disagree at ${scale}x with fractional panel sizes`);
    t.diagnostic(`fractional panels at ${scale}x ${JSON.stringify({ declared: surface.declared, applied: surface.applied })}`);
  });

  // 보고된 상태: 높이 342pt 카드의 위·아래 패널. 공간 부족으로 접힌 면은 클릭으로 열리고, 접힌 면을 끌면 포인터가
  // 최소 크기에 닿을 때 그 자리에서 열린다(docs/spec/example-model.md).
  test(`${app.name}: a click opens a side folded for lack of space and a drag opens a folded side under the pointer`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    assert.ok(s, `${app.binary} is not built`);
    await fresh(s);
    await keepCommonSettings(s);
    const card = (await s.get("core.grid")).cards.find((item) => item.tabs?.some((tab) => tab.plugin === "terminal"));
    assert.ok(card, "no terminal card");
    const set = (await s.get("core.settings")).values.sets[0];
    for (const side of ["top", "bottom"]) await s.run("core.card.sidebar.set", { card: card.id, side, set: set.id });
    const panelsOf = (grid) => grid.cards.find((item) => item.id === card.id).sidebars;
    let grid = await s.until("core.grid", (value) => panelsOf(value).bottom?.autoCollapsed === true,
      "the bottom panel did not fold for lack of space");
    const room = grid.cards.find((item) => item.id === card.id).h - 2 - 54 - 96;
    assert.ok(room < 380 && room - 6 >= 120, `the fixture card must fit one 190-point side but not two: room ${room}`);
    assert.equal(panelsOf(grid).top.collapsed, false, "the top panel must open while the bottom folds");
    await s.presented();
    // core.card.sidebar.grip 은 그린 순서(위, 아래)의 손잡이다.
    const gripOf = async (side) => {
      const grips = [];
      for (let index = 0; index < 2; index++) grips.push(await s.rect("core.card.sidebar.grip", index));
      grips.sort((a, b) => a.y - b.y);
      return side === "top" ? grips[0] : grips[1];
    };
    const bottom = await gripOf("bottom");
    await s.click(bottom.x + bottom.width / 2, bottom.y + bottom.height / 2);
    grid = await s.until("core.grid", (value) => panelsOf(value).bottom.collapsed === false,
      "a click on the bottom panel folded for lack of space did not open it");
    const opened = panelsOf(grid);
    assert.ok(Math.abs(opened.bottom.shownSize - Math.min(190, room - 6)) <= 1.5, `bottom shown size ${opened.bottom.shownSize}`);
    assert.equal(opened.top.autoCollapsed, true, "the top panel must fold when the clicked bottom panel opens");
    assert.equal(opened.top.size, 190, "the stored size changed");
    await s.presented();
    // 접힌 위를 30pt 끌면 최소 크기에 닿지 않으므로 접힌 채 있고, 150pt 끌면 6 + 150 = 156pt 로 열린다.
    const top = await gripOf("top");
    const x = top.x + top.width / 2, y = top.y + top.height / 2;
    await s.pointer(x, y, "down");
    for (const dy of [10, 20, 30]) await s.pointer(x, y + dy, "drag");
    await s.presented();
    assert.equal(panelsOf(await s.get("core.grid")).top.collapsed, true, "a drag shorter than the minimum opened the top panel");
    for (const dy of [60, 90, 120, 150]) await s.pointer(x, y + dy, "drag");
    await s.pointer(x, y + 150, "up");
    // 끌기는 여러 크기 명령을 차례로 보내므로 마지막 포인터 위치의 크기까지 기다린다.
    grid = await s.until("core.grid", (value) => panelsOf(value).top.collapsed === false && Math.abs(panelsOf(value).top.size - 156) <= 1,
      "a drag past the minimum did not open the top panel at the pointer");
    const dragged = panelsOf(grid);
    assert.ok(Math.abs(dragged.top.size - 156) <= 1 && Math.abs(dragged.top.shownSize - 156) <= 1,
      `the top edge must follow the pointer at 156 points: ${JSON.stringify(dragged.top)}`);
    t.diagnostic(`room ${room}; click: ${JSON.stringify(opened)}; drag: ${JSON.stringify(dragged)}`);
  });

  test(`${app.name}: a card carries assigned panels on all four sides regardless of the active tab`, {timeout:60000}, async (t) => {
    const s = await open(t, app);
    assert.ok(s, `${app.binary} is not built; four-side assignment was not observed`);
    t.diagnostic(`tested endpoint: ${JSON.stringify(s.client.endpoint)}`);
    await fresh(s);
    const settings = await s.get("core.settings");
    const set = settings.values.sets[0];
    assert.ok(set, "the fixture has no set to assign");

    const grid0 = await s.get("core.grid");
    let card0 = grid0.cards.find((item) => item.tabs.length);
    assert.ok(card0, "no content card to hold panels");
    // 탭 전환 검사는 항상 다른 플러그인의 탭으로 한다. 카드에 없으면 다른 카드의 탭을 옮기지 않고 브라우저 탭을
    // 더한다. 옮기면 그 카드가 비어 사라지고 배치가 바뀐다.
    if (!card0.tabs.some((tab) => tab.plugin !== card0.tabs.find((item) => item.id === card0.active).plugin)) {
      const { tab } = await s.run("core.card.add-tab", { card: card0.id, plugin: "browser" });
      s.cleanup(() => s.run("core.tab.close", { tab }));
      await s.run("core.tab.select", { tab: card0.active });
    }
    card0 = (await s.get("core.grid")).cards.find((item) => item.id === card0.id);
    const { original, other } = tabSwitchPair(card0, [card0]);

    // 사방 지정 — 카드 데이터이므로 어떤 카드든 받는다.
    for (const side of ["top", "bottom", "left", "right"]) {
      await s.run("core.card.sidebar.set", { card: card0.id, side, set: set.id });
    }
    const grid = await s.until("core.grid",
      (value) => value.cards.find((item) => item.id === card0.id)?.sidebars
        && Object.keys(value.cards.find((item) => item.id === card0.id).sidebars).length === 4,
      "the four panels did not appear in core.grid");
    const panels = grid.cards.find((item) => item.id === card0.id).sidebars;
    const assigned=grid.cards.find(item=>item.id===card0.id);
    assert.ok(assigned.h-56-380<96,'the normal fixture must have insufficient height for two 190-point sides');
    assert.ok(assigned.w-2-380>=96,'the normal fixture must retain sufficient width for two 190-point sides');
    const saved=(await s.get('core.layout')).state.cards.find(item=>item.id===card0.id).data.sidebars;
    // 높이에는 190 두 개가 최소 크기로도 들어가지 않으므로, 조작 전 우선인 위가 들어가는 크기로 열리고 아래만 접힌다
    // (docs/spec/example-model.md). 높이 공간은 카드 높이에서 테두리 2, 머리와 발 54, 내용 최소 96 을 뺀 값이다.
    const room=assigned.h-2-54-96;
    for (const side of ["top", "bottom", "left", "right"]) {
      const autoCollapsed=side==='bottom';
      const shownSize=side==='top'?Math.min(190,room-6):side==='bottom'?null:190;
      // 그린 카드 높이는 장치 픽셀 격자에 놓이므로 보이는 크기는 1pt 안에서 비교한다.
      const { shownSize: shown, ...panel } = panels[side];
      assert.deepEqual(panel, { set: set.id, size: 190, collapsed: autoCollapsed,
        requestedCollapsed:false,autoCollapsed,collapseReason:autoCollapsed?'insufficient-height':null },
        `side ${side} did not take the assignment with the default size`);
      assert.ok(shownSize===null?shown===null:Math.abs(shown-shownSize)<=1, `side ${side} shown size ${shown}, expected ${shownSize}`);
      assert.equal(saved[side].set,set.id,`${side} assignment was not saved`);
      assert.equal(Object.hasOwn(saved[side],'autoCollapsed'),false,'automatic presentation was saved');
    }

    // 연동 차단: 활성 탭을 다른 플러그인으로 바꿔도 지정 세트는 그대로다.
    await s.run("core.tab.select", { tab: other.id });
    await s.until("core.grid", (value) => value.cards.find((item) => item.id === card0.id)?.active === other.id,
      "the tab did not switch");
    const afterGrid=await s.get('core.grid');
    assert.deepEqual(geometry(afterGrid),geometry(grid),'tab selection changed internal or external card geometry');
    assert.deepEqual(afterGrid.cards.find(item=>item.id===card0.id).sidebars,panels,'tab selection changed assigned sets or presentation');
    assert.deepEqual((await s.get('core.layout')).state.cards.find(item=>item.id===card0.id).data.sidebars,saved,'tab selection changed saved assignments');
    // 전환한 탭의 native 표면도 같은 자리에 앉는다(V7a/V7b/V7c).
    await s.presented();
    assert.deepEqual((await s.get("core.verify")).rows.filter((row) => !row.ok), [], "tab selection left DOM and native geometry apart");
    t.diagnostic(`normal card ${assigned.w}x${assigned.h}; top opens at the room, bottom auto-folds, left/right open; different-plugin tabs ${original.plugin}/${other.plugin} preserve all geometry`);

    // 패널은 core.sidebars 에 카드:변 아이디로 보고된다(스펙: 사이드바 식별).
    const drawn = await s.until("core.sidebars",
      (value) => ["top", "bottom", "left", "right"].every((side) =>
        value.some((item) => item.sidebar === `${card0.id}:${side}` && item.set === set.id)),
      "the drawn panels did not appear in core.sidebars");
    assert.ok(drawn.length >= 4, "core.sidebars reports the four panels");

    // 열려 보이는 위를 누르면 접힘을 저장한다.
    const beforeLayout = (await s.get("core.grid")).cards.find((item) => item.id === card0.id);
    await s.run("core.card.sidebar.toggle", { card: card0.id, side: "top" });
    const folded = await s.until("core.grid",
      (value) => value.cards.find((item) => item.id === card0.id)?.sidebars?.top?.requestedCollapsed === true,
      "the top panel did not fold");
    assert.equal(folded.cards.find((item) => item.id === card0.id).sidebars.top.size, 190,
      "folding keeps the stored size");
    assert.equal(folded.cards.find(item=>item.id===card0.id).sidebars.top.autoCollapsed,false,'manual fold remained classified as automatic');
    assert.equal((await s.get('core.layout')).state.cards.find(item=>item.id===card0.id).data.sidebars.top.collapsed,true,'manual fold was not saved');
    await s.run("core.card.sidebar.size", { card: card0.id, side: "right", size: 260 });
    const resized = await s.until("core.grid",
      (value) => value.cards.find((item) => item.id === card0.id)?.sidebars?.right?.size === 260,
      "the right panel did not take the new size");
    assert.deepEqual(
      ["x", "y", "w", "h"].map((key) => resized.cards.find((item) => item.id === card0.id)[key]),
      ["x", "y", "w", "h"].map((key) => beforeLayout[key]),
      "panels changed the card itself — panels live inside the card");
    await assert.rejects(s.run("core.card.sidebar.size", { card: card0.id, side: "right", size: 60 }), /120 to 480/);
    await assert.rejects(s.run("core.card.sidebar.set", { card: card0.id, side: "middle", set: set.id }), /invalid params/);

    // 해지: 그 변만 사라진다.
    await s.run("core.card.sidebar.set", { card: card0.id, side: "top", set: "off" });
    const cleared = await s.until("core.grid",
      (value) => value.cards.find((item) => item.id === card0.id)?.sidebars
        && !("top" in value.cards.find((item) => item.id === card0.id).sidebars),
      "the turned-off panel did not disappear");
    assert.ok("right" in cleared.cards.find((item) => item.id === card0.id).sidebars,
      "turning off one side removed another");
    // off는 기본 세트를 따르지 않고 해당 변을 명시적으로 끈다.
    for (const side of ["bottom", "left", "right"]) {
      await s.run("core.card.sidebar.set", { card: card0.id, side, set: "off" });
    }
    // 카드가 남아 있고 패널이 하나도 없어야 한다. 카드가 사라진 것은 정리가 아니다.
    const clearedAll = await s.until("core.grid", (value) => {
      const item = value.cards.find((candidate) => candidate.id === card0.id);
      return Boolean(item) && Object.keys(item.sidebars).length === 0;
    }, "the card sidebars did not clear");
    requireCleared(clearedAll.cards.find((item) => item.id === card0.id).sidebars);
  });
}

// 새 카드 위치는 공개된 연결 명령의 입력 계약에서도 허용되어야 한다(V5-116-4).
for (const app of Object.values(APPS)) {
  test(`${app.name}: sidebar link commands accept all four card places`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    assert.ok(s, `${app.binary} is missing; sidebar link behavior was not observed`);
    t.diagnostic(`tested endpoint: ${JSON.stringify(s.client.endpoint)}`);
    await fresh(s);
    await keepCommonSettings(s);
    const { values } = await s.get("core.settings");
    const card = (await s.get("core.grid")).cards.find((item) => item.tabs?.some((tab) => tab.id === item.active && tab.plugin));
    assert.ok(card, "no card with a declared active plugin");
    const plugin = card.tabs.find((tab) => tab.id === card.active).plugin;
    const set = values.sets[0]?.id;
    assert.ok(set, "no sidebar set in the fixture");
    const failures = [];
    for (const place of ["card-left", "card-right", "card-top", "card-bottom"]) {
      const start = performance.now();
      t.diagnostic(`start ${app.name}/${place}/core.settings.link`);
      try {
        await s.run("core.settings.link", { place, plugin, set, scope: "common" });
        await s.until("core.settings", (value) => !value.saving && value.values.links.some((link) =>
          link.place === place && link.plugin === plugin && link.set === set), `link ${place} was not saved`);
        t.diagnostic(`pass ${app.name}/${place}/core.settings.link ${Math.round(performance.now() - start)}ms`);
      } catch (error) {
        const failure = `${app.name}/${place}/core.settings.link: ${error.message}`;
        failures.push(failure);
        t.diagnostic(`fail ${failure} ${Math.round(performance.now() - start)}ms`);
      }
    }
    assert.deepEqual(failures, [], "the public link command must accept all four declared card places");
  });
}

// 연결 기본 패널도 같은 접기·크기 명령을 받는다(V5-116-4).
for (const app of Object.values(APPS)) {
  test(`${app.name}: linked card panels accept fold and size without an explicit assignment`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    assert.ok(s, `${app.binary} is missing; linked-panel behavior was not observed`);
    t.diagnostic(`tested endpoint: ${JSON.stringify(s.client.endpoint)}`);
    await fresh(s);
    await keepCommonSettings(s);
    await checkLinkedPanels(s, t, app.name);
  });
}
