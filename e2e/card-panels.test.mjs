// 카드 사방 지정 검사: 저장 세트와 공간에 따른 표시를 구분하고 탭 전환 뒤에도 유지한다.
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, fresh, keepCommonSettings, open } from "./app.mjs";
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
    const original = card0.tabs.find((tab) => tab.id === card0.active);
    let other = card0.tabs.find((tab) => tab.plugin !== original.plugin);
    if (!other) {
      const source = grid0.cards.find((item) => item.tabs.some((tab) => tab.plugin !== original.plugin));
      assert.ok(source, "no different plugin exists for the required tab-switch fixture");
      other = source.tabs.find((tab) => tab.plugin !== original.plugin);
      await s.run("core.tab.move", { tab: other.id, card: card0.id, zone: "centre" });
    }
    card0 = (await s.get("core.grid")).cards.find((item) => item.id === card0.id);

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
    for (const side of ["top", "bottom", "left", "right"]) {
      const autoCollapsed=side==='top'||side==='bottom';
      assert.deepEqual(panels[side], { set: set.id, size: 190, collapsed: autoCollapsed,
        requestedCollapsed:false,autoCollapsed,collapseReason:autoCollapsed?'insufficient-height':null },
        `side ${side} did not take the assignment with the default size`);
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
    t.diagnostic(`normal card ${assigned.w}x${assigned.h}; top/bottom auto-fold, left/right open; different-plugin tabs ${original.plugin}/${other.plugin} preserve all geometry`);

    // 패널은 core.sidebars 에 카드:변 아이디로 보고된다(스펙: 사이드바 식별).
    const drawn = await s.until("core.sidebars",
      (value) => ["top", "bottom", "left", "right"].every((side) =>
        value.some((item) => item.sidebar === `${card0.id}:${side}` && item.set === set.id)),
      "the drawn panels did not appear in core.sidebars");
    assert.ok(drawn.length >= 4, "core.sidebars reports the four panels");

    // 이미 자동으로 접힌 상단도 명시적 수동 선택을 따로 저장해야 한다.
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
    await s.until("core.grid",
      (value) => Object.keys(value.cards.find((item) => item.id === card0.id)?.sidebars ?? {}).length === 0,
      "the card sidebars did not clear");
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
    const settings = await s.get("core.settings");
    const set = settings.values.sets[0];
    assert.ok(set, "no sidebar set in the fixture");
    const grid = await s.get("core.grid");
    const card = grid.cards.find((item) => item.tabs?.some((tab) => tab.id === item.active && tab.plugin));
    assert.ok(card, "no card with a declared active plugin");
    const plugin = card.tabs.find((tab) => tab.id === card.active).plugin;
    const failures = [];
    for (const side of ["top", "bottom", "left", "right"]) {
      await s.run("core.card.sidebar.set", { card: card.id, side, set: "inherit" });
      // 전체 설정 쓰기는 파일에 저장한 연결과 같은 독립된 공개 입력 경로다.
      const links = (await s.get("core.settings")).values.links.filter((link) =>
        !(link.place === `card-${side}` && link.plugin === plugin));
      links.push({ place: `card-${side}`, plugin, set: set.id });
      await s.run("core.settings.set", { patch: { links }, scope: "common" });
      await s.until("core.grid", (value) =>
        value.cards.find((item) => item.id === card.id)?.sidebars?.[side]?.set === set.id,
      `linked ${side} panel did not appear`);
      // 한 명령의 실패로 다른 명령의 관측을 생략하지 않는다. 오류는 모두 보고하고 끝에서 실패한다.
      for (const [command, extra, expected] of [
        ["core.card.sidebar.toggle", {}, { collapsed: true }],
        ["core.card.sidebar.size", { size: 260 }, { size: 260 }],
      ]) {
        const start = performance.now();
        t.diagnostic(`start ${app.name}/${side}/${command}`);
        try {
          await s.run(command, { card: card.id, side, ...extra });
          await s.until("core.grid", (value) => {
            const panel = value.cards.find((item) => item.id === card.id)?.sidebars?.[side];
            return panel?.set === set.id && Object.entries(expected).every(([key, val]) => panel[key] === val);
          }, `linked ${side} panel did not apply ${command}`);
          t.diagnostic(`pass ${app.name}/${side}/${command} ${Math.round(performance.now() - start)}ms`);
        } catch (error) {
          const failure = `${app.name}/${side}/${command}: ${error.message}`;
          failures.push(failure);
          t.diagnostic(`fail ${failure} ${Math.round(performance.now() - start)}ms`);
        }
      }
    }
    assert.deepEqual(failures, [], "linked panels must accept fold and size without an explicit assignment");
  });
}
