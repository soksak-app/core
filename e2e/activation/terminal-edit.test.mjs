// 활성화 등급 창 검사: 진단 키의 Command+C, Command+V 가 사람의 키처럼 Edit 메뉴를 실행하는지 검사한다.
//
// 진단 키는 NSApplication 의 분배를 거친다. 메뉴 키 대응의 동작은 활성 애플리케이션의 키 창으로 가므로 이 검사는
// 앱을 활성화한다. 사용자가 승인한 실행에서 pnpm -F @soksak/e2e verify:activation 으로만 실행한다.
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, fresh, open } from "../app.mjs";
import { ensureTerminals, readScreenUntil } from "../terminal-screen.mjs";
import { pasteboardText, writePasteboard } from "../pasteboard.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: injected Command+C and Command+V run the Edit menu like a person's keys`, { timeout: 90000 }, async (t) => {
    const s = await open(t, app);
    assert.ok(s, `${app.binary} is not built`);
    await fresh(s);
    const [terminal] = await ensureTerminals(s, 1);
    const surface = terminal.surface;
    await s.run("terminal.input", { bytes: "clear; printf 'EDITMENU\\n'\r" }, surface);
    const lines = await readScreenUntil(s, surface, (screen) => screen.includes("EDITMENU"), "the line did not render");
    const row = lines.indexOf("EDITMENU");
    const session = await s.get("terminal.session", surface);
    const view = await s.rect("terminal.view", undefined, surface);
    await s.keepPointerOutside();
    await s.pointer(view.document.x + view.x + 5, view.document.y + view.y + 5, "move", { activate: true });
    await s.until("host.window", (window) => window.active === true && window.key === true, "the window did not become key");

    // 끌어서 선택한 뒤 다른 앱이 클립보드를 바꾸면 Command+C 가 선택을 다시 복사한다.
    const cell = (column) => ({ x: view.document.x + view.x + (column + 0.5) * session.cellWidth,
      y: view.document.y + view.y + (row + 0.5) * session.cellHeight });
    const before = session.selectionReleases;
    await s.pointer(cell(0).x, cell(0).y, "down");
    await s.pointer(cell(3).x, cell(3).y, "drag");
    await s.pointer(cell(7).x, cell(7).y, "drag");
    await s.pointer(cell(7).x, cell(7).y, "up");
    await s.until("terminal.session", (value) => value.selectionReleases === before + 1, "the selection was not released", { surface });
    await s.until("host.window", (window) => window.responder?.surface === surface, "the terminal did not take native focus");
    writePasteboard([{ "public.utf8-plain-text": Buffer.from("CHANGED").toString("base64") }]);
    await s.press("c", { modifiers: ["command"] });
    await s.until("terminal.session", () => pasteboardText() === "EDITMENU",
      `an injected Command+C did not copy the selection (the pasteboard holds ${JSON.stringify(pasteboardText())})`, { surface });

    const marker = `INJECTED${process.pid}`;
    writePasteboard([{ "public.utf8-plain-text": Buffer.from(marker).toString("base64") }]);
    await s.press("v", { modifiers: ["command"] });
    await readScreenUntil(s, surface, (screen) => screen.some((line) => line.includes(marker)),
      "an injected Command+V did not paste through the Edit menu");
    await s.run("terminal.input", { bytes: "\u0015" }, surface);
  });
}
