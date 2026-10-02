import assert from "node:assert/strict";
import test from "node:test";
import { checkLinkedPanels } from "../linked-panels.mjs";

// 연결 사이드바 검사기에 선언된 상태·명령 경계의 잘못된 결과를 주입한다.
async function check(fault) {
  const sides = ["top", "bottom", "left", "right"];
  const card = { id: "card", active: "tab", tabs: [{ id: "tab", plugin: "fixture" }], sidebars: {} };
  const saved = {};
  const values = { sets: [{ id: "fixture-set" }], links: [] };
  const state = { cards: [{ id: card.id, data: { sidebars: saved } }] };
  const s = {
    client: { endpoint: { application: "fixture" } },
    get: async (name) => {
      if (name === "core.grid") return { cards: [card] };
      if (name === "core.settings") return { values };
      if (name === "core.layout") return { state };
      throw new Error("unexpected status " + name);
    },
    run: async (name, params) => {
      if (name === "core.card.sidebar.set") {
        assert.equal(params.set, "inherit");
        saved[params.side] = {};
        return;
      }
      if (name === "core.settings.set") {
        values.links = params.patch.links;
        for (const side of sides)
          if (values.links.some((link) => link.place === `card-${side}`))
            card.sidebars[side] ??= {
              set: "fixture-set",
              size: 190,
              collapsed: true,
              requestedCollapsed: false,
              autoCollapsed: true,
              collapseReason: side === "top" || side === "bottom" ? "insufficient-height" : "insufficient-width",
            };
        return;
      }
      const panel = card.sidebars[params.side],
        own = saved[params.side];
      if (name === "core.card.sidebar.toggle") {
        // 클릭은 보이는 상태를 뒤집어 저장한다. 공간 부족으로 접혀 보이는 면은 펼침을 저장한다.
        if (fault !== "noop-fold") {
          const stored = !panel.collapsed;
          Object.assign(panel, { requestedCollapsed: stored, collapsed: stored || panel.autoCollapsed });
          own.collapsed = stored;
        }
      } else if (name === "core.card.sidebar.size") {
        // 끌기는 크기와 펼침을 저장한다.
        panel.size = params.size;
        Object.assign(panel, { requestedCollapsed: false, collapsed: panel.autoCollapsed });
        own.collapsed = false;
        if (fault !== "unsaved-size") own.size = params.size;
      } else throw new Error("unexpected command " + name);
      if (fault === "explicit-set") own.set = panel.set;
      if (fault === "unsaved-fold") delete own.collapsed;
    },
    until: async (name, predicate, message) => {
      const value = await s.get(name);
      if (!predicate(value)) throw new Error(message);
      return value;
    },
  };
  await checkLinkedPanels(s, { diagnostic: () => {} }, "fixture");
}
for (const fault of ["noop-fold", "explicit-set", "unsaved-fold", "unsaved-size"])
  test(`linked window checker rejects ${fault}`, async () => {
    await assert.rejects(check(fault), /linked panels must accept/);
  });
test("linked window checker accepts saved derived fold and size results", async () => {
  await check(null);
});
