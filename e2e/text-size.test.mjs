// 글자 크기 명령이 누른 카드나 프레임의 글자를 키우고, 판은 창 안에 남는지 검사한다(docs/spec/text-size.md).
// 명령은 애플리케이션 메뉴 항목으로 실행하므로 메뉴에서 페이지 명령까지의 경로도 함께 검사한다.
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, fresh, open } from "./app.mjs";

// 애플리케이션 메뉴는 하나의 ko/en 표로 만들어지므로 검사도 메뉴 언어를 따라간다.
const TITLES = {
  ko: { menu: "보기", larger: "글자 크게", reset: "글자 기본 크기" },
  en: { menu: "View", larger: "Bigger Text", reset: "Default Text Size" },
};
const menuTitles = async (s) => {
  const menu = await s.get("host.menu");
  return TITLES[menu.language] ?? TITLES.en;
};

// 글꼴의 줄 높이는 픽셀로 반올림되므로 요소 크기는 배율과 정확히 같게 커지지 않는다. 목표 배율의 5% 안이면
// 그 배율로 커진 것으로 본다.
const grew = (before, after, factor) => Math.abs(after / before - factor) <= factor * 0.05;

/** 문서 좌표 사각형의 가운데를 누른다. */
async function press(s, rect) {
  const x = (rect.document?.x ?? 0) + rect.x + rect.width / 2;
  const y = (rect.document?.y ?? 0) + rect.y + rect.height / 2;
  await s.click(x, y);
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: text size commands enlarge the pressed card or the frame and keep the plane in the window`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    s.cleanup(async () => {
      await s.run("core.settings.set", { patch: { textSize: 1 }, scope: "common" });
    });
    const grid = await s.get("core.grid");
    const terminalTab = grid.cards.flatMap((card) => card.tabs).find((tab) => tab.plugin === "terminal");
    assert.ok(terminalTab, "the fixture has no terminal tab");
    await s.run("core.tab.select", { tab: terminalTab.id });
    const session = await s.until("terminal.session", (value) => value?.sessionId && value.cellHeight > 0 ? value : null,
      "the terminal session did not start", { surface: terminalTab.id });
    const card = (await s.get("core.grid")).cards.find((item) => item.tabs.some((tab) => tab.id === terminalTab.id));
    await s.presented();

    // 카드를 누르면 그 카드가 범위이고, 메뉴 항목은 그 카드의 배율만 바꾼다.
    await press(s, await s.rect("terminal.view", undefined, terminalTab.id));
    await s.until("core.text", (value) => value.scope.kind === "card" && value.scope.card === card.id,
      "pressing the card did not make it the text size scope");
    const titles = await menuTitles(s);
    await s.run("host.menu.select", { menu: titles.menu, title: titles.larger });
    const cardText = await s.until("core.text", (value) => value.cards[card.id] === 1.1,
      "the menu item did not enlarge the pressed card");
    assert.equal(cardText.frame, 1, "enlarging a card must not change the frame factor");
    await s.presented();
    // 터미널은 13pt 에 배율을 곱한 글자 크기로 칸을 다시 잰다(docs/spec/text-size.md).
    const after = await s.until("terminal.session", (value) => value.cellHeight !== session.cellHeight ? value : null,
      "the terminal cell height did not change with the card factor", { surface: terminalTab.id });
    assert.ok(grew(session.cellHeight, after.cellHeight, 1.1),
      `the terminal cell height must grow by the card factor: ${session.cellHeight} → ${after.cellHeight}`);

    // 카드 배율은 레이아웃과 함께 저장되어 다시 읽은 뒤에도 남는다.
    const documentBefore = (await s.get("core.window.document")).timeOrigin;
    await s.run("host.window.reload");
    await s.until("core.window.document", (doc) => doc.timeOrigin !== documentBefore && doc.readyState === "complete",
      "the main document did not reload");
    await s.until("core.text", (value) => value.cards[card.id] === 1.1, "the card factor did not survive a reload");

    // 프레임을 누르면 프레임이 범위이고, 스페이스 줄이 커지며 판은 창 안에 남는다.
    const window = await s.get("host.window");
    const spaceTab = await s.rect("core.space-tab", 0);
    await press(s, spaceTab);
    await s.until("core.text", (value) => value.scope.kind === "frame", "pressing the frame did not make it the scope");
    // 1 에서 세 단계(1.1, 1.25, 1.5)를 올린다.
    for (let step = 0; step < 3; step++) await s.run("host.menu.select", { menu: titles.menu, title: titles.larger });
    await s.until("core.text", (value) => value.frame === 1.5, "three frame steps did not reach factor 1.5");
    await s.presented();
    const spaceAfter = await s.rect("core.space-tab", 0);
    assert.ok(grew(spaceTab.height, spaceAfter.height, 1.5),
      `the space tab height must grow by the frame factor: ${spaceTab.height} → ${spaceAfter.height}`);
    const cardRect = await s.rect("core.card", 0);
    assert.ok(cardRect.y + cardRect.height <= window.content.height + 0.5,
      `the plane must stay inside the window: card bottom ${cardRect.y + cardRect.height}, content ${window.content.height}`);

    // 기본 크기는 현재 범위(프레임)를 1 로 되돌린다.
    await s.run("host.menu.select", { menu: titles.menu, title: titles.reset });
    await s.until("core.text", (value) => value.frame === 1 && value.cards[card.id] === 1.1,
      "restoring the frame must not change the card factor");
  });
}
