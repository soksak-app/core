// 연결로만 만든 카드 사이드바가 명시 지정 없이 접기와 크기 명령을 받는지 검사한다. 창 검사와 그 검사기의
// 단위 검사가 이 함수를 같이 쓴다.
import assert from "node:assert/strict";

/** 세션 s 의 첫 활성 플러그인 카드에서 네 변의 연결 사이드바를 검사한다. name 은 진단에 쓰는 앱 이름이다. */
export async function checkLinkedPanels(s, t, name) {
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
      ["core.card.sidebar.toggle", {}, { collapsed: true, requestedCollapsed: true, autoCollapsed: false, collapseReason: null }],
      ["core.card.sidebar.size", { size: 260 }, { size: 260, collapsed: true, requestedCollapsed: true, autoCollapsed: false, collapseReason: null }],
    ]) {
      const start = performance.now();
      t.diagnostic(`start ${name}/${side}/${command}`);
      try {
        await s.run(command, { card: card.id, side, ...extra });
        await s.until("core.grid", (value) => {
          const panel = value.cards.find((item) => item.id === card.id)?.sidebars?.[side];
          return panel?.set === set.id && Object.entries(expected).every(([key, val]) => panel[key] === val);
        }, `linked ${side} panel did not apply ${command}`);
        const layout=await s.get('core.layout');
        const saved=layout.state.cards.find(item=>item.id===card.id).data.sidebars[side];
        assert.equal(Object.hasOwn(saved,'set'),false,`${command} made the ${side} derived set explicit`);
        assert.equal(saved.collapsed,true,`${command} did not retain the saved ${side} manual fold`);
        if(command==='core.card.sidebar.size')assert.equal(saved.size,260,`${side} resized presentation was not saved`);
        t.diagnostic(`saved ${name}/${side}/${command}: ${JSON.stringify(saved)}`);
        t.diagnostic(`pass ${name}/${side}/${command} ${Math.round(performance.now() - start)}ms`);
      } catch (error) {
        const failure = `${name}/${side}/${command}: ${error.message}`;
        failures.push(failure);
        t.diagnostic(`fail ${failure} ${Math.round(performance.now() - start)}ms`);
      }
    }
  }
  assert.deepEqual(failures, [], "linked panels must accept fold and size without an explicit assignment");
}
