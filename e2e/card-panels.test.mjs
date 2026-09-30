// 카드 사방 패널 검사(V5-115): 지정한 세트가 사방에 서고, 활성 탭을 바꿔도 유지되며,
// 상하 패널은 카드 전체 폭을 가지고, 연동 사이드바와 공존한다(docs/spec/example-model.md).
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, fresh, keepCommonSettings, open } from "./app.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: a card carries assigned panels on all four sides regardless of the active tab`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const settings = await s.get("core.settings");
    const set = settings.values.sets[0];
    assert.ok(set, "the fixture has no set to assign");

    const grid0 = await s.get("core.grid");
    const card0 = grid0.cards.find((item) => !item.id.startsWith("rail") && item.tabs?.length);
    assert.ok(card0, "no content card to hold panels");

    // 사방 지정 — 카드 데이터이므로 어떤 카드든 받는다.
    for (const side of ["top", "bottom", "left", "right"]) {
      await s.run("core.card.panel.set", { card: card0.id, side, set: set.id });
    }
    const grid = await s.until("core.grid",
      (value) => value.cards.find((item) => item.id === card0.id)?.panels
        && Object.keys(value.cards.find((item) => item.id === card0.id).panels).length === 4,
      "the four panels did not appear in core.grid");
    const panels = grid.cards.find((item) => item.id === card0.id).panels;
    for (const side of ["top", "bottom", "left", "right"]) {
      assert.deepEqual(panels[side], { set: set.id, size: 190, collapsed: false },
        `side ${side} did not take the assignment with the default size`);
    }

    // 연동 차단: 활성 탭을 다른 플러그인으로 바꿔도 지정 세트는 그대로다.
    const other = card0.tabs.find((tab) => tab.id !== card0.active);
    if (other) {
      await s.run("core.tab.select", { tab: other.id });
      await s.until("core.grid", (value) => value.cards.find((item) => item.id === card0.id)?.active === other.id,
        "the tab did not switch");
      const after = (await s.get("core.grid")).cards.find((item) => item.id === card0.id).panels;
      for (const side of ["top", "bottom", "left", "right"]) {
        assert.equal(after[side].set, set.id, `side ${side} followed the active tab — panels are assigned, not derived`);
      }
    }

    // 패널은 core.sidebars 에 카드:변 아이디로 보고된다(스펙: 사이드바 식별).
    const drawn = await s.until("core.sidebars",
      (value) => ["top", "bottom", "left", "right"].every((side) =>
        value.some((item) => item.sidebar === `${card0.id}:${side}` && item.set === set.id)),
      "the drawn panels did not appear in core.sidebars");
    assert.ok(drawn.length >= 4, "core.sidebars reports the four panels");

    // 접기·크기: 좌측 inset 사이드바와 같은 상태 기계.
    await s.run("core.card.panel.toggle", { card: card0.id, side: "top" });
    const folded = await s.until("core.grid",
      (value) => value.cards.find((item) => item.id === card0.id)?.panels?.top?.collapsed === true,
      "the top panel did not fold");
    assert.equal(folded.cards.find((item) => item.id === card0.id).panels.top.size, 190,
      "folding keeps the stored size");
    await s.run("core.card.panel.size", { card: card0.id, side: "right", size: 260 });
    const resized = await s.until("core.grid",
      (value) => value.cards.find((item) => item.id === card0.id)?.panels?.right?.size === 260,
      "the right panel did not take the new size");
    assert.deepEqual(
      ["x", "w", "h"].map((key) => resized.cards.find((item) => item.id === card0.id)[key]),
      ["x", "w", "h"].map((key) => grid.cards.find((item) => item.id === card0.id)[key]),
      "panels changed the card itself — panels live inside the card");
    await assert.rejects(s.run("core.card.panel.size", { card: card0.id, side: "right", size: 60 }), /120 to 480/);
    await assert.rejects(s.run("core.card.panel.set", { card: card0.id, side: "middle", set: set.id }), /unknown panel side/);

    // 해지: 그 변만 사라진다.
    await s.run("core.card.panel.set", { card: card0.id, side: "top", set: "off" });
    const cleared = await s.until("core.grid",
      (value) => value.cards.find((item) => item.id === card0.id)?.panels
        && !("top" in value.cards.find((item) => item.id === card0.id).panels),
      "the turned-off panel did not disappear");
    assert.ok("right" in cleared.cards.find((item) => item.id === card0.id).panels,
      "turning off one side removed another");
    // 정리: 사방 모두 해지. 해지는 명시 지정을 지운다 — 그 변에 플러그인 연결 기본이
    // 있으면 기본이 다시 선다(V5-116-2). 남은 것은 기본뿐임을 확인한다.
    for (const side of ["bottom", "left", "right"]) {
      await s.run("core.card.panel.set", { card: card0.id, side, set: "off" });
    }
    const fullyCleared = await s.until("core.grid",
      (value) => Object.keys(value.cards.find((item) => item.id === card0.id)?.panels ?? {}).length === 0,
      "the panels did not clear").then(() => true, () => false);
    if (!fullyCleared) {
      const rest = (await s.get("core.grid")).cards.find((item) => item.id === card0.id).panels;
      for (const side of Object.keys(rest)) {
        assert.equal(rest[side].collapsed, false, `side ${side} kept an explicit fold — it must be a fresh default`);
      }
    }
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
    for (const side of ["top", "bottom", "right"]) {
      await s.run("core.card.panel.set", { card: card.id, side, set: "off" });
      // 전체 설정 쓰기는 파일에 저장한 연결과 같은 독립된 공개 입력 경로다.
      const links = (await s.get("core.settings")).values.links.filter((link) =>
        !(link.place === `card-${side}` && link.plugin === plugin));
      links.push({ place: `card-${side}`, plugin, set: set.id });
      await s.run("core.settings.set", { patch: { links }, scope: "common" });
      await s.until("core.grid", (value) =>
        value.cards.find((item) => item.id === card.id)?.panels?.[side]?.set === set.id,
      `linked ${side} panel did not appear`);
      // 한 명령의 실패로 다른 명령의 관측을 생략하지 않는다. 오류는 모두 보고하고 끝에서 실패한다.
      for (const [command, extra, expected] of [
        ["core.card.panel.toggle", {}, { collapsed: true }],
        ["core.card.panel.size", { size: 260 }, { size: 260 }],
      ]) {
        const start = performance.now();
        t.diagnostic(`start ${app.name}/${side}/${command}`);
        try {
          await s.run(command, { card: card.id, side, ...extra });
          await s.until("core.grid", (value) => {
            const panel = value.cards.find((item) => item.id === card.id)?.panels?.[side];
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
