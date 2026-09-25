// 프로젝트에서 새로 연 터미널과 셸이 프로젝트의 정규 루트에서 시작하는지 검사한다(docs/spec/projects.md).
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import test from "node:test";

import { APPS, fresh, open } from "./app.mjs";
import { readScreenUntil } from "./terminal-screen.mjs";

/** 브라우저 카드에 plugin 탭을 더하고 그 표면을 반환한다. 브라우저 탭은 디렉터리를 알리지 않으므로 origin 이 없다. */
async function addTab(s, plugin) {
  const { tab } = await s.run("core.card.add-tab", { card: "browser", plugin });
  s.cleanup(() => s.run("core.tab.close", { tab }));
  await s.until("core.surfaces", (surfaces) => surfaces.some((item) => item.surface === tab && item.visible),
    `the new ${plugin} tab did not show`);
  return tab;
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: a new terminal and a new shell in a project start in the project root`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    // 검사 프로젝트는 $TMPDIR 아래에 있고 /private 를 거쳐 해석되므로 정규 경로로 비교한다.
    const root = realpathSync((await s.get("core.project")).root);

    const shell = await addTab(s, "shell");
    await s.until("shell.cwd", (cwd) => typeof cwd === "string", "the new shell did not report its directory", { surface: shell });
    const ran = await s.run("shell.run", { command: "pwd" }, shell);
    assert.equal(realpathSync(ran.output.trim()), root, `the new shell started in ${ran.output.trim()}`);

    const terminal = await addTab(s, "terminal");
    await s.until("terminal.session", (state) => Boolean(state?.sessionId), "the new terminal has no session", { surface: terminal });
    await s.run("terminal.input", { bytes: "pwd\r" }, terminal);
    const lines = await readScreenUntil(s, terminal, (rows) => rows.some((row) => row.startsWith("/")),
      "the new terminal printed no directory");
    const printed = lines.find((row) => row.startsWith("/"));
    assert.equal(realpathSync(printed), root, `the new terminal started in ${printed}`);
  });
}
