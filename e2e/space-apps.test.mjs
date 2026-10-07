// 전체 화면 카드의 스페이스 앱 목록과 전환(docs/spec/example-model.md#card-fullscreen).
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";

const card = (grid, id) => grid.cards.find((item) => item.id === id);
const panes = (grid) => grid.cards.filter((item) => item.pane !== null);

for (const app of Object.values(APPS)) {
  test(`${app.name}: a fullscreen card lists the apps of the space by card and switches to a picked one`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    assert.ok(s, `${app.binary} is not built`);
    await fresh(s);
    // A | (B / C) 배치에 B 의 탭을 하나 더한다. A 는 fixture 의 terminal 카드다.
    const start = panes(await s.get("core.grid"));
    for (const extra of start.filter((item) => item.id !== "terminal")) await s.run("core.card.close", { card: extra.id });
    const b = (await s.run("core.card.split", { card: "terminal", side: "right", plugin: "browser" })).card;
    const c = (await s.run("core.card.split", { card: b, side: "bottom", plugin: "browser" })).card;
    await s.run("core.card.add-tab", { card: b, plugin: "terminal" });
    const grid = await s.until("core.grid", (value) => card(value, b)?.tabs.length === 2 && card(value, c),
      "the arrangement A | (B / C) did not appear");

    await s.run("core.card.fullscreen", { card: "terminal" });
    await s.until("core.grid", (value) => value.fullscreen === "terminal", "the card did not become fullscreen");
    // 단추는 전체 화면 카드 머리의 맨 앞에 있다.
    const index = panes(grid).findIndex((item) => item.id === "terminal");
    const button = await s.rect("core.card.space-apps", index);
    const tab = await s.rect("core.card.tab", 0);
    assert.ok(button.width > 0 && button.x < tab.x, `the space apps button is not at the front: ${JSON.stringify({ button, tab })}`);
    await s.click((button.document?.x ?? 0) + button.x + button.width / 2, (button.document?.y ?? 0) + button.y + button.height / 2);
    const menu = await s.until("core.picker", (picker) => picker.open, "the space apps list did not open");
    assert.match(menu.title, /^스페이스 앱 4개$/);
    assert.deepEqual(menu.items.map((item) => item.group), ["terminal", b, b, c],
      `the groups do not follow the arrangement: ${JSON.stringify(menu.items)}`);
    assert.equal(menu.items.find((item) => item.active)?.group, "terminal");

    // C 의 탭을 고르면 전체 화면이 C 로 옮겨 가고 그 탭을 보인다.
    const target = menu.items.findIndex((item) => item.group === c);
    await s.run("core.picker.pick", { index: target });
    const moved = await s.until("core.grid", (value) => value.fullscreen === c, "fullscreen did not move to the picked card");
    assert.equal(card(moved, c).active, menu.items[target].key.split("/")[1]);
    for (const item of panes(moved)) assert.equal(item.fullscreen, item.id === c, `${item.id} fullscreen ${item.fullscreen}`);

    await s.run("core.card.fullscreen", { card: c });
    await s.until("core.grid", (value) => value.fullscreen === null, "fullscreen did not end");
  });
}
