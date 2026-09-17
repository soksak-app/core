// 터미널 표면의 입력이 셸 사이드카를 거쳐 같은 표면의 출력으로 돌아오는지 검사한다.
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import test from "node:test";

import { APPS, fresh, open, terminalReady } from "./app.mjs";

/**
 * 터미널 입력 칸을 네이티브 입력으로 누르고 한 줄을 입력한다. 출력에 expected 줄이 나타날 때까지
 * 알림으로 기다린 뒤 출력 줄을 반환한다.
 */
async function typeLine(s, terminal, line, expected) {
  const field = await s.rect("terminal.input", undefined, terminal);
  await s.click(field.document.x + field.x + field.width / 2, field.document.y + field.y + field.height / 2);
  await s.press("a", { text: line });
  await s.press("Enter");
  return s.until("terminal.output", (lines) => lines.includes(expected),
    `terminal ${terminal} did not print ${expected}`, { surface: terminal });
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: terminal input returns shell output through the shell sidecar`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const root = realpathSync((await s.get("core.project")).root);
    const [terminal] = await terminalReady(s);
    // 활성 탭이 아닌 터미널은 보이지 않으므로 core.surfaces 에 없고, 배치의 탭으로 찾는다.
    const tabs = (await s.get("core.grid")).cards.flatMap((card) => card.tabs).filter((tab) => tab.plugin === "terminal");
    assert.ok(tabs.length >= 2, `expected two terminal tabs: ${JSON.stringify(tabs)}`);

    const marker = `sidecar-${process.pid}-${Date.now()}`;
    const echoed = await typeLine(s, terminal.surface, `echo ${marker}`, marker);
    assert.equal(echoed.filter((line) => line === marker).length, 1, "the shell output appears once");
    const directory = await typeLine(s, terminal.surface, "pwd", root);
    assert.ok(directory.includes(root), "the shell runs in the project directory");

    // 다른 터미널 표면은 이 표면의 출력을 받지 않는다.
    for (const other of tabs.filter((tab) => tab.id !== terminal.surface)) {
      const lines = await s.get("terminal.output", other.id);
      assert.ok(!lines.includes(marker), `surface ${other.id} received this surface's output`);
    }
  });
}
