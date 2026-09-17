// 셸 표면의 입력이 셸 사이드카를 거쳐 같은 표면의 출력으로 돌아오는지 검사한다.
import assert from "node:assert/strict";
import { mkdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { APPS, fresh, open, shellReady } from "./app.mjs";

/**
 * 셸 입력 칸을 네이티브 입력으로 누르고 한 줄을 입력한다. 출력에 expected 줄이 나타날 때까지
 * 알림으로 기다린 뒤 출력 줄을 반환한다.
 */
async function typeLine(s, shell, line, expected) {
  const field = await s.rect("shell.input", undefined, shell);
  await s.click(field.document.x + field.x + field.width / 2, field.document.y + field.y + field.height / 2);
  await s.press("a", { text: line });
  await s.press("Enter");
  return s.until("shell.output", (lines) => lines.includes(expected),
    `shell ${shell} did not print ${expected}`, { surface: shell });
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: shell input returns shell output through the shell sidecar`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const root = realpathSync((await s.get("core.project")).root);
    const [shell] = await shellReady(s);
    // 활성 탭이 아닌 셸은 보이지 않으므로 core.surfaces 에 없고, 배치의 탭으로 찾는다.
    const tabs = (await s.get("core.grid")).cards.flatMap((card) => card.tabs).filter((tab) => tab.plugin === "shell");
    assert.ok(tabs.length >= 2, `expected two shell tabs: ${JSON.stringify(tabs)}`);

    const marker = `sidecar-${process.pid}-${Date.now()}`;
    const echoed = await typeLine(s, shell.surface, `echo ${marker}`, marker);
    assert.equal(echoed.filter((line) => line === marker).length, 1, "the shell output appears once");
    const directory = await typeLine(s, shell.surface, "pwd", root);
    assert.ok(directory.includes(root), "the shell runs in the project directory");

    // 다른 셸 표면은 이 표면의 출력을 받지 않는다.
    for (const other of tabs.filter((tab) => tab.id !== shell.surface)) {
      const lines = await s.get("shell.output", other.id);
      assert.ok(!lines.includes(marker), `surface ${other.id} received this surface's output`);
    }

    // 보이는 줄에 마지막 출력이 있다.
    const screen = await s.get("shell.screen", shell.surface);
    assert.ok(screen.rows > 0 && screen.lines.includes(root), `shell.screen = ${JSON.stringify(screen)}`);
  });

  test(`${app.name}: shell commands run, report the directory, interrupt, and clear`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const root = realpathSync((await s.get("core.project")).root);
    const [shell] = await shellReady(s);
    const at = { surface: shell.surface };
    const inner = join(root, `shell-${process.pid}`);
    mkdirSync(inner);
    t.after(() => rmSync(inner, { recursive: true, force: true }));

    await s.until("shell.cwd", (dir) => dir !== null && realpathSync(dir) === root,
      "the session did not report the project directory", at);

    const failed = await s.run("shell.run", { command: "echo out; echo err >&2; exit 7" }, shell.surface);
    assert.deepEqual(failed, { output: "out\nerr\n", exit: 7 });

    // 입력한 cd 는 세션의 디렉터리를 바꾸고, 이후 shell.run 은 그 디렉터리에서 실행된다.
    await typeLine(s, shell.surface, `cd ${inner}`, `$ cd ${inner}`);
    await s.until("shell.cwd", (dir) => dir !== null && realpathSync(dir) === inner,
      "the session did not report the changed directory", at);
    const here = await s.run("shell.run", { command: "pwd -P" }, shell.surface);
    assert.deepEqual(here, { output: `${inner}\n`, exit: 0 });

    // 중단 단추는 실행 중인 세션 명령과 shell.run 명령을 끝낸다.
    await typeLine(s, shell.surface, "sh -c 'echo started; exec sleep 30'", "started");
    const long = s.run("shell.run", { command: "sleep 30" }, shell.surface);
    // 실행 요청이 사이드카에 전달된 뒤에 누른 중단은 그 명령에 도달한다.
    await s.until("shell.runs", (count) => count === 1, "the run was not delivered", at);
    const button = await s.rect("shell.interrupt", undefined, shell.surface);
    const began = Date.now();
    await s.click(button.document.x + button.x + button.width / 2, button.document.y + button.y + button.height / 2);
    const stopped = await long;
    assert.notEqual(stopped.exit, 0, "the interrupted run reports a failure");
    assert.ok(Date.now() - began < 10_000, "the interrupt ended the run");
    const after = `after-interrupt-${process.pid}`;
    await typeLine(s, shell.surface, `echo ${after}`, after);

    await s.run("shell.clear", {}, shell.surface);
    await s.until("shell.output", (lines) => lines.length === 0, "the output was not cleared", at);
    const cleared = await s.get("shell.screen", shell.surface);
    assert.deepEqual(cleared.lines, []);
  });
}
