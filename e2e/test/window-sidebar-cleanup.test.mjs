import assert from "node:assert/strict";
import test from "node:test";
import { turnOffCardSidebars } from "../card-sidebar-choices.mjs";

// 준비 중 실패를 주입하여 임시 off 선택의 복원을 검사한다.
test("turning off card sidebars restores the saved selections after setup fails", async () => {
  const original = {
    left: { set: "original" },
    right: { size: 144 },
    top: { set: "off" },
    bottom: { collapsed: true },
  };
  const saved = structuredClone(original),
    cleanups = [];
  let disabled = 0;
  const s = {
    cleanup: (fn) => cleanups.push(fn),
    presented: async () => {},
    get: async (name) => {
      assert.equal(name, "core.layout");
      return { state: { cards: [{ id: "card", data: { sidebars: structuredClone(saved) } }] } };
    },
    run: async (name, params) => {
      assert.equal(name, "core.card.sidebar.set");
      if (params.set === "inherit") delete saved[params.side].set;
      else saved[params.side].set = params.set;
      if (params.set === "off" && ++disabled === 4) throw new Error("fixture setup failure");
    },
  };
  await assert.rejects(turnOffCardSidebars(s, "card"), /fixture setup failure/);
  for (const cleanup of cleanups.reverse()) await cleanup();
  assert.deepEqual(saved, original, "temporary off selections remain after the window checker");
});
