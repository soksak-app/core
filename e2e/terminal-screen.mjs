// 창 검사가 터미널 표면을 준비하고 화면 글자를 읽는 도우미.
import assert from "node:assert/strict";

export function textLines(screen) {
  assert.ok(screen && Array.isArray(screen.lines), `invalid terminal screen: ${JSON.stringify(screen)}`);
  return screen.lines.map((row) => row.map((cell) => {
    assert.ok(Number.isInteger(cell.width) && cell.width >= 0, "cell width is required");
    return cell.ch === undefined ? " ".repeat(cell.width) : cell.ch;
  }).join("").trimEnd());
}

export async function readScreenUntil(session, surface, predicate, message) {
  // 현재 화면을 한 번 읽고 이후 출력은 알림으로 기다린다. 리사이즈도 이 읽기에 반영된다.
  await session.run("terminal.screen.read", {}, surface);
  const screen = await session.until("terminal.screen",
    (lines) => predicate(textLines({ lines })), message, { surface });
  return textLines({ lines: screen });
}

export async function ensureTerminals(session, count) {
  // The fixture starts with the shell tab active. Select the declared terminal
  // before measuring visible native terminal surfaces; waiting for an inactive
  // tab would turn a test setup mistake into a false runtime failure.
  const initialGrid = await session.get("core.grid");
  const terminalTab = initialGrid.cards.flatMap((card) => card.tabs)
    .find((tab) => tab.plugin === "terminal");
  assert.ok(terminalTab, "the fixture has no terminal tab");
  const owner = initialGrid.cards.find((card) => card.tabs.some((tab) => tab.id === terminalTab.id));
  if (owner?.active !== terminalTab.id) await session.run("core.tab.select", { tab: terminalTab.id });
  await session.until(
    "core.surfaces",
    (surfaces) => surfaces.some((item) => item.visible && item.plugin === "terminal"),
    "the fixture terminal did not register before splitting",
  );
  let terminals = (await session.surfaces("terminal")).length;
  while (terminals < count) {
    const grid = await session.get("core.grid");
    const card = grid.cards.find((item) =>
      item.active && item.tabs.some((tab) => tab.plugin === "terminal"));
    assert.ok(card, "a visible terminal card was not found for splitting");
    await session.run("core.card.split", { card: card.id, axis: "x", plugin: "terminal" });
    await session.until(
      "core.surfaces",
      (surfaces) => surfaces.filter((item) => item.visible && item.plugin === "terminal").length >= terminals + 1,
      `terminal count did not reach ${terminals + 1}`
    );
    terminals = (await session.get("core.surfaces"))
      .filter((item) => item.visible && item.plugin === "terminal").length;
  }
  await session.until(
    "core.surfaces",
    (surfaces) => {
      const visible = surfaces.filter((item) => item.visible && item.plugin === "terminal");
      return visible.length >= count && visible.every((item) =>
        item.exposes.includes("status terminal.session"));
    },
    `terminal native surfaces did not reach ${count} with terminal.session registered`
  );
  return session.surfaces("terminal");
}
