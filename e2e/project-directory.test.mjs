// 프로젝트에서 새로 연 터미널이 프로젝트의 정규 루트에서 시작하는지 검사한다(docs/spec/projects.md).
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";
import { readScreenUntil } from "./terminal-screen.mjs";

/** 브라우저 카드에 plugin 탭을 더하고 그 표면을 반환한다. 브라우저 탭은 디렉터리를 알리지 않으므로 origin 이 없다. */
async function addTab(s, plugin) {
  const { tab } = await s.run("core.card.add-tab", { card: "browser", plugin });
  s.cleanup(() => s.run("core.tab.close", { tab }));
  await s.until("core.surfaces", (surfaces) => surfaces.some((item) =>
    item.surface === tab && item.visible && item.status.phase === "ready"),
  `the new ${plugin} tab did not become ready`);
  return tab;
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: a new terminal in a project starts in the project root`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    // 검사 프로젝트는 $TMPDIR 아래에 있고 /private 를 거쳐 해석되므로 정규 경로로 비교한다.
    const root = realpathSync((await s.get("core.project")).root);

    const terminal = await addTab(s, "terminal");
    await s.until("terminal.session", (state) => Boolean(state?.sessionId), "the new terminal has no session", { surface: terminal });
    // 긴 경로는 화면 폭에서 다음 행으로 이어지므로 표지 사이의 경로를 이어 붙인 행에서 읽는다.
    await s.run("terminal.input", { bytes: "printf 'DIR<%s>DIR\\n' \"$PWD\"\r" }, terminal);
    const printedIn = (rows) => /DIR<(\/[^>]*)>DIR/.exec(rows.join(""))?.[1];
    const lines = await readScreenUntil(s, terminal, (rows) => printedIn(rows) !== undefined,
      "the new terminal printed no directory");
    const printed = printedIn(lines);
    assert.equal(realpathSync(printed), root, `the new terminal started in ${printed}`);
  });
}
