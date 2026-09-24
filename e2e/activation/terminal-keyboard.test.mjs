// 활성화 등급 창 검사: 네이티브 키로 세 터미널에 명령을 입력하고 편집하고 실행한다.
//
// 터미널 그림 영역은 일반 문자를 입력기(입력 컨텍스트)로 넘긴다. OS 입력기는 활성 애플리케이션의 키 창에만
// 답하고, 애플리케이션이 한 번 활성화된 뒤에는 그 밖의 창에 온 문자 키에 답하지 않는다. 그래서 이 검사는
// 앱을 활성화해 사용자 포커스를 가져간다. 기본 창 검사(pnpm -F @soksak/e2e verify)에 포함하지 않고,
// 사용자가 승인한 실행에서 pnpm -F @soksak/e2e verify:activation 으로만 실행한다.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { APPS, fresh, open } from "../app.mjs";
import { ensureTerminals, readScreenUntil, textLines } from "../terminal-screen.mjs";

const ABC = "com.apple.keylayout.ABC";

// 입력 컨텍스트는 문서마다 입력 소스를 기억하고, 포커스를 받으면 그 입력 소스로 바꿀 수 있다.
// 그래서 영문 명령을 입력하기 전에, 포커스를 준 뒤 영문 자판을 고른다.
async function selectABC(session) {
  const selected = await session.request("diagnostics.input.source", { select: ABC });
  assert.equal(selected.current, ABC, `input source ${ABC} was not selected`);
}

async function clickAndExecute(session, surface, marker) {
  const view = await session.rect("terminal.view", undefined, surface);
  await session.click(view.document.x + view.x + view.width / 2, view.document.y + view.y + view.height / 2);
  await session.until("host.window", (host) => host.active === true && host.regions.some((region) =>
    region.surface === surface && region.focused), `${surface} did not receive native focus in the active window`);
  await selectABC(session);
  for (const ch of `echo ${marker}`) await session.press(ch === " " ? "Space" : ch);
  await session.press("Enter");
  await readScreenUntil(session, surface, (lines) => lines.includes(marker),
    `${surface} did not execute its first post-context command`);
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: native keyboard edits and executes independently in three terminals`, { timeout: 180000 }, async (t) => {
    const s = await open(t, app);
    assert.ok(s, `${app.binary} is not built`);
    await fresh(s);
    const tab = (await s.get("core.grid")).cards.flatMap((card) => card.tabs).find((tab) => tab.plugin === "terminal");
    assert.ok(tab, "the fixture has no terminal tab");
    await s.run("core.tab.select", { tab: tab.id });
    const terminals = await ensureTerminals(s, 3);
    assert.equal(terminals.length, 3);
    await s.presented();
    // 입력기는 활성 애플리케이션의 키 창에만 답하므로 앱을 활성화한다. 키 창은 포인터 위치를 이동으로 받으므로
    // 창을 포인터 밖에 둔다.
    await s.keepPointerOutside();
    const first = await s.rect("terminal.view", undefined, terminals[0].surface);
    await s.pointer(first.document.x + first.x + first.width / 2, first.document.y + first.y + first.height / 2,
      "move", { activate: true });
    // 검사가 끝나면 이전 입력 소스로 되돌린다.
    await s.selectInputSource(ABC);
    for (const [index, terminal] of terminals.entries()) {
      await t.test(`terminal ${index + 1}`, { timeout: 30000 }, async () => {
        const surface = terminal.surface;
        t.diagnostic(`${app.name}: START terminal ${index + 1} prompt`);
        await readScreenUntil(s, surface, (lines) => lines.some((line) => line.includes("$")), "shell prompt missing");
        t.diagnostic(`${app.name}: PASS terminal ${index + 1} prompt`);
        const others = await Promise.all(terminals.filter((item) => item.surface !== surface)
          .map(async (item) => [item.surface, await s.get("terminal.screen", item.surface)]));
        const view = await s.rect("terminal.view", undefined, surface);
        t.diagnostic(`${app.name}: START terminal ${index + 1} pointer focus`);
        try {
          await s.click(view.document.x + view.x + view.width / 2, view.document.y + view.y + view.height / 2);
        } catch (error) {
          t.diagnostic(`${app.name}: terminal ${index + 1} click failure host=${JSON.stringify(await s.get("host.window"))}`);
          t.diagnostic(`${app.name}: terminal ${index + 1} click failure input=${JSON.stringify(await s.get("core.surface.input", surface))}`);
          throw error;
        }
        t.diagnostic(`${app.name}: PASS terminal ${index + 1} pointer focus`);
        await s.until("host.window", (host) => host.active === true &&
          host.regions.some((region) => region.surface === surface && region.focused),
        `terminal ${index + 1} did not receive keyboard focus in the active window`);
        await selectABC(s);
        t.diagnostic(`${app.name}: PASS terminal ${index + 1} native focus`);
        const marker = `typed${index}`;
        const line = `echo ${marker}`;
        for (const ch of `${line}x`) await s.press(ch === " " ? "Space" : ch);
        t.diagnostic(`${app.name}: PASS terminal ${index + 1} typed line`);
        const sessionAfterTyping = await s.get("terminal.session", surface);
        const screenAfterTyping = await s.get("terminal.screen", surface);
        assert.equal(sessionAfterTyping.error, undefined,
          `terminal ${index + 1} must not report a selection/input error after focus click: ${sessionAfterTyping.error}`);
        t.diagnostic(`${app.name}: terminal ${index + 1} session after typing ` +
          `${JSON.stringify({ sessionId: sessionAfterTyping.sessionId, error: sessionAfterTyping.error })}`);
        t.diagnostic(`${app.name}: terminal ${index + 1} screen after typing ` +
          `${JSON.stringify(textLines({ lines: screenAfterTyping }).filter(Boolean))}`);
        await readScreenUntil(s, surface, (lines) => lines.some((row) => row.endsWith(`${line}x`)), "native characters were not delivered");
        const focusedAfterFirstInput = await s.get("host.window");
        assert.ok(focusedAfterFirstInput.regions.some((region) => region.surface === surface && region.focused),
          `terminal ${index + 1} lost native focus before its first command completed`);
        await s.press("Backspace");
        await readScreenUntil(s, surface, (lines) => lines.some((row) => row.endsWith(line)), "native Backspace was not delivered");
        await s.press("u", { modifiers: ["control"] });
        await readScreenUntil(s, surface, (lines) => lines.some((row) => row.endsWith("$")) && !lines.some((row) => row.includes(marker)),
          "native Ctrl+U did not clear the input line");
        t.diagnostic(`${app.name}: PASS terminal ${index + 1} editing`);
        for (const ch of line) await s.press(ch === " " ? "Space" : ch);
        await s.press("Enter");
        const output = await readScreenUntil(s, surface, (lines) => lines.includes(marker), "native Enter did not execute the command");
        assert.equal(output.filter((row) => row === marker).length, 1, "command output must occur once");
        t.diagnostic(`${app.name}: PASS terminal ${index + 1} command`);
        const continued = `continued${index}`;
        for (const ch of `echo ${continued}`) await s.press(ch === " " ? "Space" : ch);
        await s.press("Enter");
        const next = await readScreenUntil(s, surface, (lines) => lines.includes(continued),
          "typing after output required another click");
        assert.equal(next.filter((row) => row === continued).length, 1, "continued input must execute once without refocusing");
        t.diagnostic(`${app.name}: PASS terminal ${index + 1} continued input`);
        // 화살표 키: Left 두 번 뒤 입력은 줄 가운데에 들어가고, Up 은 앞 명령을 다시 불러온다.
        const arrowed = `a${index}q${index}bc`;
        for (const ch of `echo a${index}${index}bc`) await s.press(ch === " " ? "Space" : ch);
        for (let step = 0; step < 3; step++) await s.press("ArrowLeft");
        await s.press("q");
        await s.press("Enter");
        await readScreenUntil(s, surface, (lines) => lines.includes(arrowed), "native Left did not move the insertion point");
        await s.press("ArrowUp");
        await s.press("Enter");
        const recalled = await readScreenUntil(s, surface, (lines) => lines.filter((row) => row === arrowed).length === 2,
          "native Up did not recall the previous command");
        assert.equal(recalled.filter((row) => row === arrowed).length, 2, "the recalled command must run once more");
        // Ctrl+C 는 실행 중인 명령을 끊는다. 셸 내장 read 는 자식 프로세스 없이 실행되므로, Ctrl+C 가 명령 시작
        // 전후 어느 때 도착해도 셸이 프롬프트로 돌아온다. Ctrl+C 가 도착하지 않으면 다음 줄은 read 의 입력이 된다.
        for (const ch of "read x") await s.press(ch === " " ? "Space" : ch);
        await s.press("Enter");
        await s.press("c", { modifiers: ["control"] });
        const interrupted = `interrupted${index}`;
        for (const ch of `echo ${interrupted}`) await s.press(ch === " " ? "Space" : ch);
        await s.press("Enter");
        await readScreenUntil(s, surface, (lines) => lines.includes(interrupted), "native Ctrl+C did not interrupt the running command");
        t.diagnostic(`${app.name}: PASS terminal ${index + 1} arrows and interrupt`);
        for (const [other, before] of others) assert.deepEqual(await s.get("terminal.screen", other), before,
          `typing in ${surface} changed ${other}`);
      });
    }

    const terminalTab = (await s.get("core.grid")).cards.flatMap((card) => card.tabs)
      .find((tab) => tab.plugin === "terminal");
    const browserTab = (await s.get("core.grid")).cards.flatMap((card) => card.tabs)
      .find((tab) => tab.plugin === "browser");
    assert.ok(terminalTab && browserTab, "the focus context test requires terminal and browser tabs");
    t.diagnostic(`${app.name}: START focus after browser tab`);
    await s.run("core.tab.select", { tab: browserTab.id });
    await s.until("core.surfaces", (surfaces) => surfaces.some((item) => item.visible && item.plugin === "browser"),
      "browser tab did not become visible before returning to the terminal");
    await s.run("core.tab.select", { tab: terminalTab.id });
    await s.until("core.surfaces", (surfaces) => surfaces.some((item) =>
      item.visible && item.plugin === "terminal" && item.exposes.includes("status terminal.session")),
    "terminal did not return after browser tab switching");
    await s.presented();
    const returnedTerminal = (await s.get("core.surfaces")).find((item) =>
      item.visible && item.plugin === "terminal" && item.exposes.includes("status terminal.session"));
    await clickAndExecute(s, returnedTerminal.surface, "afterbrowser");
    t.diagnostic(`${app.name}: PASS focus after browser tab`);

    t.diagnostic(`${app.name}: START focus after resize`);
    const beforeResize = await s.get("terminal.session", returnedTerminal.surface);
    await s.run("host.window.resize", { width: 800, height: 920 });
    await s.until("host.window", (host) => host.content.width === 800, "window did not resize for focus test");
    await s.keepPointerOutside();
    await s.until("terminal.session", (state) => state.cols < beforeResize.cols,
      "terminal did not resize before focus was tested again", { surface: returnedTerminal.surface });
    await clickAndExecute(s, returnedTerminal.surface, "afterresize");
    t.diagnostic(`${app.name}: PASS focus after resize`);

    t.diagnostic(`${app.name}: START focus after modal close`);
    await s.run("core.settings.open");
    await s.until("core.settings-modal", (modal) => modal.open, "settings modal did not open for focus test");
    await s.run("core.settings.close");
    await s.until("core.settings-modal", (modal) => !modal.open, "settings modal did not close for focus test");
    await s.presented();
    await clickAndExecute(s, returnedTerminal.surface, "aftermodal");
    t.diagnostic(`${app.name}: PASS focus after modal close`);

    t.diagnostic(`${app.name}: START focus after project return`);
    const project = await s.get("core.project");
    await s.run("core.projects.browse");
    await s.until("core.screen", (screen) => screen.screen === "library", "project library did not open for focus test");
    await s.run("core.library.open", { id: project.id });
    await s.until("core.surfaces", (surfaces) => surfaces.some((item) =>
      item.visible && item.plugin === "terminal" && item.exposes.includes("status terminal.session")),
    "terminal did not return after project navigation");
    await s.presented();
    const restoredTerminal = (await s.get("core.surfaces")).find((item) =>
      item.visible && item.plugin === "terminal" && item.exposes.includes("status terminal.session"));
    await clickAndExecute(s, restoredTerminal.surface, "afterproject");
    t.diagnostic(`${app.name}: PASS focus after project return`);

    t.diagnostic(`${app.name}: START focus after window switch`);
    const temporaryProject = mkdtempSync(join(tmpdir(), "soksak-terminal-focus-"));
    s.cleanup(() => rmSync(temporaryProject, { recursive: true, force: true }));
    await s.run("core.settings.set", { patch: { projectOpening: "windows" }, scope: "common" });
    const opened = await s.run("core.project.open", { root: temporaryProject, color: "#7fe3b0" });
    const child = s.on((await s.windows(2, "focus test project window did not open"))
      .find((window) => window.window !== s.window).window);
    await child.until("core.grid", (grid) => grid.cards.length > 0, "focus test project window did not render");
    const childTerminalTab = (await child.get("core.grid")).cards.flatMap((card) => card.tabs)
      .find((tab) => tab.plugin === "terminal");
    assert.ok(childTerminalTab, `opened project ${opened.id} has no terminal tab`);
    await child.run("core.tab.select", { tab: childTerminalTab.id });
    await child.until("core.surfaces", (surfaces) => surfaces.some((item) =>
      item.visible && item.plugin === "terminal" && item.exposes.includes("status terminal.session")),
    "focus test child window terminal did not become visible");
    await child.presented();
    const childTerminal = (await child.get("core.surfaces")).find((item) =>
      item.visible && item.plugin === "terminal" && item.exposes.includes("status terminal.session"));
    await child.keepPointerOutside();
    await clickAndExecute(child, childTerminal.surface, "afterwindow");
    await child.close();
    await s.windows(1, "focus test child window did not close");
    t.diagnostic(`${app.name}: PASS focus after window switch`);
  });
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: a character key to a terminal outside the key window reports an input method error`, { timeout: 30000 }, async (t) => {
    const s = await open(t, app);
    assert.ok(s, `${app.binary} is not built`);
    await fresh(s);
    const [terminal] = await ensureTerminals(s, 1);
    const surface = terminal.surface;
    await readScreenUntil(s, surface, (lines) => lines.some((line) => line.includes("$")), "shell prompt missing");
    await s.keepPointerOutside();
    const view = await s.rect("terminal.view", undefined, surface);
    const x = view.document.x + view.x + view.width / 2;
    const y = view.document.y + view.y + view.height / 2;
    await s.pointer(x, y, "move", { activate: true });
    await s.selectInputSource(ABC);
    await s.click(x, y);
    await s.until("host.window", (host) => host.active === true &&
      host.regions.some((region) => region.surface === surface && region.focused),
    "the terminal did not receive native focus in the active window");

    // 다른 프로젝트 창이 키 창이 되면 첫 창의 터미널은 첫 응답자로 남지만 입력기의 답을 받지 못한다.
    const project = mkdtempSync(join(tmpdir(), "soksak-terminal-key-window-"));
    s.cleanup(() => rmSync(project, { recursive: true, force: true }));
    await s.run("core.settings.set", { patch: { projectOpening: "windows" }, scope: "common" });
    await s.run("core.project.open", { root: project, color: "#7fe3b0" });
    const child = s.on((await s.windows(2, "the second project window did not open"))
      .find((window) => window.window !== s.window).window);
    await child.until("host.window", (host) => host.active === true && host.key === true,
      "the second project window did not become the key window");
    await s.until("host.window", (host) => host.key === false && host.regions.some((region) =>
      region.surface === surface && region.focused), "the first window lost its terminal responder");

    await s.press("e");
    const state = await s.until("terminal.session", (session) => typeof session.error === "string",
      "a character key outside the key window was dropped without an error", { surface });
    assert.match(state.error, /input method did not answer native keyCode=14 outside the key window of the active application/);
    await child.close();
    await s.windows(1, "the second project window did not close");
  });
}
