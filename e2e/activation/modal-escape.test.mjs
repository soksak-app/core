// 활성 키 창의 네이티브 Escape 가 선택기 문서에 도착하는지 검사한다.
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "../fixture.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: an active key window closes its add picker with native Escape`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const card = (await s.get("core.grid")).cards.find((item) => item.pane === 0).id;
    await s.run("core.card.menu", { card, menu: "add" });
    const window = await s.until("host.window", (state) => state.modal?.id === "picker" && state.modal.shown,
      "the add picker did not appear");
    const rect = window.modal.frame;
    await s.pointer(rect.x + rect.width / 2, rect.y + rect.height / 2, "move", { activate: true });
    await s.until("host.window", (state) => state.active && state.key,
      "the picker window did not become the active key window");
    await s.press("Escape");
    await s.until("host.window", (state) => state.modal === null,
      "native Escape did not close the add picker in the active key window");
  });
}
