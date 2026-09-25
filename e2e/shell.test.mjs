// 셸 표면의 입력이 셸 사이드카를 거쳐 같은 표면의 출력으로 돌아오는지 검사한다.
import assert from "node:assert/strict";
import { mkdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { APPS, fresh, open } from "./app.mjs";

/**
 * 셸 입력 칸을 네이티브 입력으로 누르고 한 줄을 입력한다. 출력에 expected 줄이 나타날 때까지
 * 알림으로 기다린 뒤 출력 줄을 반환한다.
 */
async function typeLine(s, shell, line, expected) {
  const field = await s.rect("shell.input", undefined, shell);
  const x = field.document.x + field.x + field.width / 2;
  const y = field.document.y + field.y + field.height / 2;
  const before = (await s.get("core.surface.input", shell) ?? []).at(-1)?.sequence ?? 0;
  const fresh = (events) => Array.isArray(events) ? events.filter((event) => event.sequence > before) : [];
  const down = s.until("core.surface.input", (events) => fresh(events).some((event) =>
    event.type === "pointerdown"), `shell ${shell} did not receive the input press`, { surface: shell });
  await s.pointer(x, y, "down");
  await down;
  const click = s.until("core.surface.input", (events) => fresh(events).some((event) =>
    event.type === "click"), `shell ${shell} did not receive the input click`, { surface: shell });
  await s.pointer(x, y, "up");
  await click;
  await s.press("a", { text: line });
  await s.press("Enter");
  return s.until("shell.output", (lines) => lines.includes(expected),
    `shell ${shell} did not print ${expected}`, { surface: shell });
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: shell input returns shell output through the shell sidecar`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    const shell = await fresh(s);
    const root = realpathSync((await s.get("core.project")).root);
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
      await s.run("core.tab.select", { tab: other.id });
      const mounted = await freshSurface(s, other.id);
      const lines = await s.get("shell.output", mounted);
      assert.ok(!lines.includes(marker), `surface ${other.id} received this surface's output`);
    }
    await s.run("core.tab.select", { tab: shell.surface });
    await freshSurface(s, shell.surface);

    // 보이는 줄에 마지막 출력이 있다.
    const screen = await s.get("shell.screen", shell.surface);
    assert.ok(screen.rows > 0 && screen.lines.includes(root), `shell.screen = ${JSON.stringify(screen)}`);
  });

  test(`${app.name}: remounted shell surface replays its live directory and accepts input`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    const shell = await fresh(s);
    const root = realpathSync((await s.get("core.project")).root);
    const at = { surface: shell.surface };

    await s.until("shell.cwd", (dir) => dir !== null && realpathSync(dir) === root,
      "the remounted session did not replay its project directory", at);
    const marker = `reattach-${process.pid}-${Date.now()}`;
    const lines = await typeLine(s, shell.surface, `echo ${marker}`, marker);
    assert.equal(lines.filter((line) => line === marker).length, 1,
      "the remounted session did not return input output exactly once");
  });

  test(`${app.name}: shell commands run, report the directory, interrupt, and clear`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    const shell = await fresh(s);
    const root = realpathSync((await s.get("core.project")).root);
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
    const long = s.run("shell.run", { command: "sleep 30" }, shell.surface, { timeout: 40_000 });
    // 실행 요청이 사이드카에 전달된 뒤에 누른 중단은 그 명령에 도달한다.
    await s.until("shell.runs", (count) => count === 1, "the run was not delivered", at);
    const button = await s.rect("shell.interrupt", undefined, shell.surface);
    const began = Date.now();
    const clickX = button.document.x + button.x + button.width / 2;
    const clickY = button.document.y + button.y + button.height / 2;
    const inputBefore = (await s.get("core.surface.input", shell.surface) ?? []).at(-1)?.sequence ?? 0;
    const freshInput = (events) => Array.isArray(events) ?
      events.filter((event) => event.sequence > inputBefore) : [];
    const down = s.until("core.surface.input", (events) => freshInput(events).some((event) =>
      event.type === "pointerdown"), "the interrupt press was not dispatched", at);
    await s.pointer(clickX, clickY, "down");
    await down;
    const clickEvent = s.until("core.surface.input", (events) => freshInput(events).some((event) =>
      event.type === "click"), "the interrupt click was not dispatched", at);
    await s.pointer(clickX, clickY, "up");
    await clickEvent;
    await s.until("shell.runs", (count) => count === 0,
      "the interrupt click did not clear the running shell command", at);
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

async function freshSurface(s, expected) {
  await s.until("core.surfaces", (all) => all.some((x) =>
    x.surface === expected && x.visible && x.exposes.includes("status shell.output") &&
    x.exposes.includes("dom shell.input")), `shell ${expected} did not mount its output and input`);
  const current = (await s.surfaces("shell")).find((x) => x.surface === expected && x.visible &&
    x.exposes.includes("status shell.output") && x.exposes.includes("dom shell.input"));
  assert.ok(current, `shell ${expected} was not visible after selection`);
  return current.surface;
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: the shell surface is drawn in the card color of every theme and mode`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    const shell = await fresh(s);
    s.cleanup(() => s.run("core.settings.theme", { name: "midnight", mode: "dark", scope: "common" }));
    const { THEMES } = await import("../packages/workbench/settings.js");
    const { frames, pixel, readFrame } = await import("./frame.mjs");
    const { rmSync: remove } = await import("node:fs");
    for (const { name } of THEMES) {
      for (const mode of ["dark", "light"]) {
        await s.run("core.settings.theme", { name, mode, scope: "common" });
        await s.until("core.surface.document", (value) => value?.themed, "the shell page did not apply the theme", { surface: shell.surface });
        // 출력 칸의 빈 오른쪽 아래를 잰다. 셸 표면의 배경은 카드 색(--card)이다.
        const out = await s.rect("shell.output", undefined, shell.surface);
        const { displayed } = await s.presented();
        await s.request("diagnostics.capture.start", {});
        const result = await s.request("diagnostics.capture.stop", { after: displayed });
        let sample;
        try {
          const frame = readFrame(frames(result.frames).at(-1));
          sample = pixel(frame, Math.round((out.document.x + out.x + out.width - 8) * frame.scale),
            Math.round((out.document.y + out.y + out.height - 8) * frame.scale));
        } finally {
          remove(result.frames, { recursive: true, force: true });
        }
        const card = THEMES.find((item) => item.name === name)[mode].card;
        const expected = [1, 3, 5].map((at) => parseInt(card.slice(at, at + 2), 16));
        assert.ok(sample.every((value, index) => Math.abs(value - expected[index]) <= 2),
          `${name} ${mode}: the shell surface pixel is rgb(${sample}), the card color is ${card}`);
      }
    }
  });
}
