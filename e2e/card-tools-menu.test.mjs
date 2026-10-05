// 좁은 카드 머리: 왼쪽 탭 목록, 가운데 현재 탭 제목, 오른쪽 도구 메뉴(docs/features.md F81).
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";

const card = (grid, id) => grid.cards.find((item) => item.id === id);

for (const app of Object.values(APPS)) {
  test(`${app.name}: a narrow card folds its tools into a menu that runs them and keeps its title`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    assert.ok(s, `${app.binary} is not built`);
    await fresh(s);
    const born = (await s.run("core.card.split", { card: "terminal", side: "right", plugin: "browser" })).card;
    await s.until("core.grid", (grid) => card(grid, born), "the split did not add a card");
    const layout = await s.get("core.layout");
    const own = layout.state.cards.find((item) => item.id === "terminal");
    const grid = await s.get("core.grid");
    // 터미널 카드를 130pt 로 좁힌다. 도구 다섯 개와 제목이 한 줄에 들어가지 않는 폭이다.
    await s.run("core.boundary.move", { axis: "x", line: own.c1, position: grid.lines.x[own.c0] + 136 });
    const narrow = await s.until("core.grid", (value) => card(value, "terminal").w <= 140 && card(value, "terminal").acts?.tools === "menu",
      "the narrow card did not fold its tools into the menu");
    const acts = card(narrow, "terminal").acts;
    assert.equal(acts.fit, "one", `the narrow card does not keep its title: ${JSON.stringify(acts)}`);

    // 도구 메뉴 버튼을 네이티브로 누르면 메뉴가 열리고, 그 항목이 도구의 명령을 실행한다.
    const index = narrow.cards.filter((item) => item.pane !== null).findIndex((item) => item.id === "terminal");
    const button = await s.rect("core.card.tools", index);
    assert.ok(button.width > 0 && button.height > 0, `the tool menu button is not shown: ${JSON.stringify(button)}`);
    await s.click((button.document?.x ?? 0) + button.x + button.width / 2, (button.document?.y ?? 0) + button.y + button.height / 2);
    const menu = await s.until("core.picker", (picker) => picker.open, "the tool menu did not open");
    const keys = menu.items.map((item) => item.key);
    for (const key of ["add", "fullscreen", "close"]) assert.ok(keys.includes(key), `the tool menu lacks ${key}: ${JSON.stringify(keys)}`);
    await s.run("core.picker.pick", { index: keys.indexOf("close") });
    await s.until("core.grid", (value) => !card(value, "terminal"), "the close item did not close the card");
  });
}
