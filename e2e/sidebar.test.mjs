// 사이드바 위치 inset: 사이드바가 카드 안 표면 왼쪽에 서고, 접기와 폭 변경이 카드 크기를 바꾸지 않는지 검사한다.
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, fresh, open } from "./app.mjs";

/** 손잡이는 사이드바 테두리 위에 겹치므로 표면은 사이드바 바로 뒤에서 시작한다. */
const GRIP = 0;
/** 접은 사이드바의 폭(pt). */
const FOLDED = 28;

for (const app of Object.values(APPS)) {
  test(`${app.name}: an inset sidebar stands inside its card and folds or resizes without changing the card`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    s.cleanup(() => s.run("core.settings.reset", { key: "rail" }));
    const railed = (grid) => grid.cards.filter((card) => card.id.startsWith("rail"));
    await s.run("core.settings.change", { key: "rail", value: "inset", scope: "common" });
    const grid = await s.until("core.grid", (value) => railed(value).length === 0 && value.cards.some((card) => card.sidebar),
      "no card holds an inset sidebar");
    const card = grid.cards.find((item) => item.sidebar);
    assert.deepEqual(card.sidebar, { width: 190, collapsed: false });
    const surfaceOf = async () => (await s.get("core.surfaces")).find((item) => item.surface === card.active);
    // 표면 위치는 판의 원점과 카드 테두리(1pt)를 더한 문서 좌표다.
    const origin = grid.plane.x + card.x + 1;
    const surfaceAt = async (inside) => s.until("core.surfaces", (surfaces) => {
      const surface = surfaces.find((item) => item.surface === card.active);
      return surface && Math.abs(surface.applied.x - (origin + inside)) <= 1;
    }, `the surface did not start ${inside} pt into the card`);
    await surfaceAt(190 + GRIP);
    const before = await surfaceOf();

    await s.run("core.card.sidebar.toggle", { card: card.id });
    const folded = await s.until("core.grid", (value) => value.cards.find((item) => item.id === card.id)?.sidebar?.collapsed === true,
      "the sidebar did not fold");
    const same = folded.cards.find((item) => item.id === card.id);
    assert.deepEqual([same.x, same.w, same.h], [card.x, card.w, card.h], "folding changed the card");
    await surfaceAt(FOLDED + GRIP);

    await s.run("core.card.sidebar.toggle", { card: card.id });
    await s.run("core.card.sidebar.size", { card: card.id, width: 260 });
    const resized = await s.until("core.grid", (value) => value.cards.find((item) => item.id === card.id)?.sidebar?.width === 260,
      "the sidebar did not take the new width");
    const kept = resized.cards.find((item) => item.id === card.id);
    assert.deepEqual([kept.x, kept.w, kept.h], [card.x, card.w, card.h], "resizing the sidebar changed the card");
    await surfaceAt(260 + GRIP);
    await assert.rejects(s.run("core.card.sidebar.size", { card: card.id, width: 60 }), /120 to 480/);
    assert.ok(before, "the surface was measured");
    // 접기 단추를 네이티브 클릭으로 누르면 접힌다.
    const fold = await s.rect("core.card.sidebar.fold", 0);
    await s.click(fold.x + fold.width / 2, fold.y + fold.height / 2);
    await s.until("core.grid", (value) => value.cards.find((item) => item.id === card.id)?.sidebar?.collapsed === true,
      "a click on the fold button did not fold the sidebar");
  });
}
