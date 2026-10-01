// 터미널 프로토콜 창 검사: 구현한 CSI 와 OSC 시퀀스를 셸로 PTY 에 쓰고, 화면, 커서, 세션 상태나 응답을 확인한다.
//
// 응답이 있는 시퀀스는 셸의 read 가 응답을 받아 16진수로 화면에 쓴다. 화면 효과는 12행에 완료 표시를 쓴 뒤 읽는다.
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, fresh, open } from "./app.mjs";
import { pasteboardText, writePasteboard } from "./pasteboard.mjs";
import { cellBackgrounds, ensureTerminals, isColor, readScreenUntil, selectionBackground } from "./terminal-screen.mjs";

// d N: 커서를 12행으로 옮기고 완료 표시를 쓴다. r SEQ END N: SEQ 를 쓰고 END 까지의 응답을 16진수로 쓴다.
const SETUP = "b=$(printf '\\007'); d() { printf '\\033[12;1HDONE%s\\n' \"$1\"; }; " +
  "r() { printf \"$1\"; IFS= read -r -s -d \"$2\" -t 5 R; printf '\\033[12;1HR%s:%s\\n' \"$3\" " +
  "\"$(printf '%s' \"$R\" | od -An -tx1 | tr -d ' \\n')\"; }; " +
  // m ON COUNT N OFF: ON 을 쓰고, 입력 COUNT 바이트를 원시 모드로 읽어 16진수로 쓴 뒤 OFF 를 쓴다. 읽기 전에 W<N> 을 쓴다.
  "m() { printf \"$1\"; stty raw -echo; printf '\\033[12;1HW%s\\r\\n' \"$3\"; " +
  "R=$(dd bs=1 count=\"$2\" 2>/dev/null | od -An -tx1 | tr -d ' \\n'); stty sane; printf \"$4\"; " +
  "printf '\\033[12;1HR%s:%s\\n' \"$3\" \"$R\"; }; clear\r";

let serial = 0;

/** 화면을 지우고 printf 로 bytes 를 쓴 뒤 완료 표시가 보일 때 화면 셀을 돌려준다. */
async function effect(s, surface, bytes) {
  const id = ++serial;
  await s.run("terminal.input", { bytes: `clear; printf '${bytes}'; d ${id}\r` }, surface);
  await readScreenUntil(s, surface, (lines) => lines.some((line) => line.startsWith(`DONE${id}`)),
    `${JSON.stringify(bytes)} did not finish`);
  return s.get("terminal.screen", surface);
}

/** bytes 를 쓰고 end 로 끝나는 응답을 돌려준다. end 는 셸 단어다. */
async function reply(s, surface, bytes, end) {
  const id = ++serial;
  await s.run("terminal.input", { bytes: `clear; r '${bytes}' ${end} ${id}\r` }, surface);
  const lines = await readScreenUntil(s, surface, (screen) => screen.some((line) => line.startsWith(`R${id}:`)),
    `${JSON.stringify(bytes)} did not reply`);
  const hex = lines.find((line) => line.startsWith(`R${id}:`)).slice(`R${id}:`.length).trim();
  return Buffer.from(hex, "hex").toString("latin1");
}

/** on 으로 모드를 켜고 act 가 만든 입력 count 바이트를 돌려준다. off 로 모드를 끈다. */
async function report(s, surface, on, count, off, act) {
  const id = ++serial;
  await s.run("terminal.input", { bytes: `clear; m '${on}' ${count} ${id} '${off}'\r` }, surface);
  await readScreenUntil(s, surface, (lines) => lines.some((line) => line.startsWith(`W${id}`)), `${JSON.stringify(on)} did not start reading`);
  await act();
  const lines = await readScreenUntil(s, surface, (screen) => screen.some((line) => line.startsWith(`R${id}:`)),
    `${JSON.stringify(on)} did not receive ${count} bytes`);
  const hex = lines.find((line) => line.startsWith(`R${id}:`)).slice(`R${id}:`.length).trim();
  return Buffer.from(hex, "hex").toString("latin1");
}

/** 검사가 쓴 응답 줄(R<n>:…)이 검사 뒤에 남지 않도록 터미널 탭을 닫는다. */
async function closeTerminalTabs(s) {
  const grid = await s.get("core.grid");
  for (const tab of grid.cards.flatMap((card) => card.tabs).filter((tab) => tab.plugin === "terminal")) {
    await s.run("core.tab.close", { tab: tab.id });
  }
}

const text = (screen, row) => screen[row].map((cell) => cell.ch ?? " ").join("").trimEnd();
const at = (screen, row, col) => screen[row][col].ch ?? " ";

for (const app of Object.values(APPS)) {
  test(`${app.name}: implemented CSI sequences change the screen, the cursor, and the replies`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const [terminal] = await ensureTerminals(s, 1);
    s.cleanup(() => closeTerminalTabs(s));
    const surface = terminal.surface;
    await readScreenUntil(s, surface, (lines) => lines.some((line) => line.includes("$")), "shell prompt missing");
    await s.run("terminal.input", { bytes: SETUP }, surface);

    // A/B/C/D/G/H/f 와 s/u.
    let screen = await effect(s, surface, "\\033[4;10fP\\033[2AQ\\033[BR\\033[3DS\\033[2GT\\033[6;5HX\\033[sY\\033[7;2HZ\\033[uW");
    assert.deepEqual([at(screen, 3, 9), at(screen, 1, 10), at(screen, 2, 11), at(screen, 2, 9), at(screen, 2, 1)],
      ["P", "Q", "R", "S", "T"], "cursor movement");
    assert.deepEqual([at(screen, 5, 4), at(screen, 5, 5), at(screen, 6, 1)], ["X", "W", "Z"], "cursor save and restore");
    // E/F 와 3C.
    screen = await effect(s, surface, "\\033[3;5H\\033[2EX\\033[1FY\\033[8;1HA\\033[3CB");
    assert.deepEqual([at(screen, 4, 0), at(screen, 3, 0), text(screen, 7)], ["X", "Y", "A   B"], "next and previous line");
    // m.
    screen = await effect(s, surface, "\\033[1;1H\\033[1;3;4;7mZ\\033[0mN");
    assert.deepEqual(screen[0][0], { ch: "Z", width: 1, bold: true, italic: true, underline: true, inverse: true }, "SGR attributes");
    assert.deepEqual(screen[0][1], { ch: "N", width: 1 }, "SGR reset");
    // S/T 와 r.
    const five = "\\033[1;1HL1\\033[2;1HL2\\033[3;1HL3\\033[4;1HL4\\033[5;1HL5";
    screen = await effect(s, surface, `${five}\\033[2;4r\\033[1S\\033[r`);
    assert.deepEqual([0, 1, 2, 3, 4].map((row) => text(screen, row)), ["L1", "L3", "L4", "", "L5"], "scroll up in a region");
    screen = await effect(s, surface, `${five}\\033[2;4r\\033[1T\\033[r`);
    assert.deepEqual([0, 1, 2, 3, 4].map((row) => text(screen, row)), ["L1", "", "L2", "L3", "L5"], "scroll down in a region");
    // J/K.
    screen = await effect(s, surface, "\\033[1;1HAAAA\\033[1;3H\\033[K\\033[2;1HBBBB\\033[3;1HCCCC\\033[2;3H\\033[J");
    assert.deepEqual([0, 1, 2].map((row) => text(screen, row)), ["AA", "BB", ""], "erase in line and display");
    // @/P, L/M.
    screen = await effect(s, surface, "\\033[1;1HABCD\\033[1;2H\\033[2@\\033[2;1HABCD\\033[2;2H\\033[2P");
    assert.deepEqual([text(screen, 0), text(screen, 1)], ["A  BCD", "AD"], "insert and delete characters");
    screen = await effect(s, surface, "\\033[1;1HM1\\033[2;1HM2\\033[3;1HM3\\033[2;1H\\033[1L\\033[5;1HN1\\033[6;1HN2\\033[5;1H\\033[1M");
    assert.deepEqual([0, 1, 2, 3, 4].map((row) => text(screen, row)), ["M1", "", "M2", "M3", "N2"], "insert and delete lines");
    // I/Z 와 b.
    screen = await effect(s, surface, "\\033[1;1H\\033[2IX\\033[2;20H\\033[ZY\\033[3;1HQ\\033[3b");
    assert.deepEqual([at(screen, 0, 16), at(screen, 1, 16), text(screen, 2)], ["X", "Y", "QQQQ"], "tabulation and repeat");
    // ?1049h/l.
    await effect(s, surface, "\\033[1;1HPRIMARY");
    const id = ++serial;
    await s.run("terminal.input", { bytes: `printf '\\033[?1049h\\033[1;1HALTERNATE'; read -r x; printf '\\033[?1049l'; d ${id}\r` }, surface);
    await readScreenUntil(s, surface, (lines) => lines[0].startsWith("ALTERNATE") && !lines.some((line) => line.includes("PRIMARY")),
      "the alternate screen did not replace the primary screen");
    await s.run("terminal.input", { bytes: "\r" }, surface);
    await readScreenUntil(s, surface, (lines) => lines.some((line) => line.startsWith(`DONE${id}`)) &&
      lines[0].startsWith("PRIMARY"), "leaving the alternate screen did not restore the primary screen");

    // ?25h/l, ?12h/l, SP q. drawn 은 사이드카가 프로그램의 요청을 적용해 그린 커서다.
    await s.run("terminal.focus", {}, surface);
    await s.until("terminal.cursor", (cursor) => cursor.focused === true, "the terminal did not take focus", { surface });
    await effect(s, surface, "\\033[?25l");
    await s.until("terminal.cursor", (cursor) => cursor.visible === false, "?25l did not hide the cursor", { surface });
    await effect(s, surface, "\\033[?25h\\033[4 q");
    await s.until("terminal.cursor", (cursor) => cursor.visible === true && cursor.drawn.shape === "underline" &&
      cursor.drawn.blinking === false, "?25h and DECSCUSR 4 did not draw a steady underline cursor", { surface });
    await effect(s, surface, "\\033[?12h");
    await s.until("terminal.cursor", (cursor) => cursor.drawn.blinking === true, "?12h did not request blinking", { surface });
    await effect(s, surface, "\\033[?12l\\033[5 q");
    await s.until("terminal.cursor", (cursor) => cursor.drawn.shape === "beam" && cursor.drawn.blinking === true,
      "DECSCUSR 5 did not draw a blinking beam cursor", { surface });
    await effect(s, surface, "\\033[0 q");
    await s.until("terminal.cursor", (cursor) => cursor.drawn.shape === cursor.shape,
      "DECSCUSR 0 did not return to the configured cursor shape", { surface });

    // 5n, 6n, c, >c, 14t.
    assert.equal(await reply(s, surface, "\\033[5n", "n"), "\x1b[0");
    assert.equal(await reply(s, surface, "\\033[3;7H\\033[6n", "R"), "\x1b[3;7");
    assert.equal(await reply(s, surface, "\\033[c", "c"), "\x1b[?6");
    assert.match(await reply(s, surface, "\\033[>c", "c"), /^\x1b\[>0;\d+;1$/);
    const session = await s.get("terminal.session", surface);
    const size = await reply(s, surface, "\\033[14t", "t");
    // 장치 픽셀은 창이 놓인 화면의 배율을 따른다.
    const { scale } = await s.get("host.window");
    assert.equal(size, `\x1b[4;${Math.round(session.rows * session.cellHeight * scale)};${Math.round(session.cols * session.cellWidth * scale)}`,
      `14t did not report the text area in device pixels: ${JSON.stringify(size)}`);

    // 지원하지 않는 CSI 는 명시적인 오류로 남는다.
    await effect(s, surface, "\\033[18t");
    // 거부한 시퀀스는 프로그램의 출력이므로 세션 오류가 아니라 거부 기록에 남는다.
    const rejected = await s.until("terminal.session", (value) => value.rejected.includes("unsupported CSI window report 18t"),
      "an unsupported CSI window report was not recorded as rejected", { surface });
    assert.equal(rejected.error, undefined, "a rejected program sequence became a terminal error");
  });

  test(`${app.name}: implemented OSC sequences change the title, colors, cursor, and clipboard and reply`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const [terminal] = await ensureTerminals(s, 1);
    s.cleanup(() => closeTerminalTabs(s));
    const surface = terminal.surface;
    await readScreenUntil(s, surface, (lines) => lines.some((line) => line.includes("$")), "shell prompt missing");
    await s.run("terminal.input", { bytes: SETUP }, surface);

    // 0 과 2: 탭 제목.
    await effect(s, surface, "\\033]2;OSC-TWO\\007");
    await s.until("core.grid", (grid) => grid.cards.some((card) => card.tabs.some((tab) => tab.id === surface && tab.label === "OSC-TWO")),
      "OSC 2 did not title the tab");
    await effect(s, surface, "\\033]0;OSC-ZERO\\007");
    await s.until("core.grid", (grid) => grid.cards.some((card) => card.tabs.some((tab) => tab.id === surface && tab.label === "OSC-ZERO")),
      "OSC 0 did not title the tab");

    // 4 와 104: 색 번호의 설정, 조회, 초기화.
    const color = (selector) => reply(s, surface, `\\033]${selector};?\\007`, "\"$b\"");
    const original = await color("4;1");
    assert.match(original, /^\x1b\]4;1;rgb:[0-9a-f]{4}\/[0-9a-f]{4}\/[0-9a-f]{4}$/, "OSC 4 query");
    await effect(s, surface, "\\033]4;1;rgb:12/34/56\\007");
    assert.equal(await color("4;1"), "\x1b]4;1;rgb:1212/3434/5656", "OSC 4 set");
    await effect(s, surface, "\\033]104;1\\007");
    assert.equal(await color("4;1"), original, "OSC 104 with a number");
    await effect(s, surface, "\\033]4;1;rgb:12/34/56\\007\\033]104\\007");
    assert.equal(await color("4;1"), original, "OSC 104 without parameters");

    // 10–12 와 110–112: 전경, 배경, 커서 색.
    for (const selector of [10, 11, 12]) {
      const before = await color(selector);
      assert.match(before, new RegExp(`^\\x1b\\]${selector};rgb:[0-9a-f]{4}/[0-9a-f]{4}/[0-9a-f]{4}$`), `OSC ${selector} query`);
      await effect(s, surface, `\\033]${selector};rgb:ab/cd/ef\\007`);
      assert.equal(await color(selector), `\x1b]${selector};rgb:abab/cdcd/efef`, `OSC ${selector} set`);
      await effect(s, surface, `\\033]${selector + 100}\\007`);
      assert.equal(await color(selector), before, `OSC ${selector + 100} reset`);
    }

    // 50: 커서 모양.
    await s.run("terminal.focus", {}, surface);
    await s.until("terminal.cursor", (cursor) => cursor.focused === true, "the terminal did not take focus", { surface });
    await effect(s, surface, "\\033]50;CursorShape=1\\007");
    await s.until("terminal.cursor", (cursor) => cursor.drawn.shape === "beam", "OSC 50 CursorShape=1 did not draw a beam", { surface });
    await effect(s, surface, "\\033]50;CursorShape=0\\007");
    await s.until("terminal.cursor", (cursor) => cursor.drawn.shape === "block", "OSC 50 CursorShape=0 did not draw a block", { surface });

    // 5, 6, 105, 106: 굵게, 밑줄, 반전, 기울임 글자의 특수 색. 깜빡임(2)은 적용할 수 없어 오류다.
    const special = await color("5;0");
    assert.match(special, /^\x1b\]5;0;rgb:[0-9a-f]{4}\/[0-9a-f]{4}\/[0-9a-f]{4}$/, "OSC 5 query");
    await effect(s, surface, "\\033]5;0;rgb:11/22/33\\007\\033]6;0;1\\007\\033]106;0;0\\007");
    assert.equal(await color("5;0"), "\x1b]5;0;rgb:1111/2222/3333", "OSC 5 set");
    await effect(s, surface, "\\033]105;0\\007");
    assert.equal(await color("5;0"), special, "OSC 105 reset");
    assert.equal((await s.get("terminal.session", surface)).error, undefined, "OSC 5, 6, 105, and 106 reported an error");
    await effect(s, surface, "\\033]5;2;#ffffff\\007");
    await s.until("terminal.session", (value) => value.rejected.some((reason) => /blink/.test(reason)),
      "the blink color was not rejected", { surface });

    // 22: 포인터 모양.
    await effect(s, surface, "\\033]22;crosshair\\007");
    await s.until("terminal.session", (value) => value.pointer === "crosshair", "OSC 22 did not set the pointer", { surface });
    await effect(s, surface, "\\033]22;\\007");
    await s.until("terminal.session", (value) => value.pointer === "default", "an empty OSC 22 did not restore the pointer", { surface });

    // 17, 19, 117, 119: 선택 영역의 강조 색.
    const highlight = await color("17");
    const highlightText = await color("19");
    assert.match(highlight, /^\x1b\]17;rgb:[0-9a-f]{4}\/[0-9a-f]{4}\/[0-9a-f]{4}$/, "OSC 17 query");
    await effect(s, surface, "\\033]17;rgb:12/34/56\\007\\033]19;rgb:ab/cd/ef\\007\\033[1;1HHIGHLIGHT");
    assert.equal(await color("17"), "\x1b]17;rgb:1212/3434/5656", "OSC 17 set");
    assert.equal(await color("19"), "\x1b]19;rgb:abab/cdcd/efef", "OSC 19 set");
    await effect(s, surface, "\\033[1;1HHIGHLIGHT");
    const view = await s.rect("terminal.view", undefined, surface);
    const { cellWidth, cellHeight } = await s.get("terminal.session", surface);
    const at = (col) => ({ x: view.document.x + view.x + (col + 0.5) * cellWidth, y: view.document.y + view.y + 0.5 * cellHeight });
    const selectFirstCells = async () => {
      const before = (await s.get("terminal.session", surface)).selectionReleases;
      await s.pointer(at(0).x, at(0).y, "down");
      await s.pointer(at(3).x, at(3).y, "drag");
      await s.pointer(at(3).x, at(3).y, "up");
      await s.until("terminal.session", (value) => value.selectionReleases === before + 1, "the selection was not released", { surface });
    };
    await selectFirstCells();
    const [highlighted] = await cellBackgrounds(s, surface, [{ col: 1, row: 0 }]);
    assert.ok(isColor(highlighted, "#123456"),
      `a selected cell was drawn on rgb(${highlighted}) instead of the OSC 17 highlight background #123456`);
    await effect(s, surface, "\\033]117\\007\\033]119\\007\\033[1;1HHIGHLIGHT");
    assert.equal(await color("17"), highlight, "OSC 117 reset");
    assert.equal(await color("19"), highlightText, "OSC 119 reset");
    await effect(s, surface, "\\033[1;1HHIGHLIGHT");
    await selectFirstCells();
    // 강조 색이 없으면 선택한 칸은 테마의 선택 배경(--edge) 위에 그린다(docs/spec/terminal-runtime.md).
    const selection = await selectionBackground(s);
    const [plain] = await cellBackgrounds(s, surface, [{ col: 1, row: 0 }]);
    assert.ok(isColor(plain, selection),
      `a selected cell without highlight colors was drawn on rgb(${plain}) instead of the theme selection background ${selection}`);

    // 52: 기본 정책은 거부하고, 허용하면 텍스트를 저장하고 조회에 답한다.
    const before = pasteboardText();
    await effect(s, surface, `\\033]52;c;${Buffer.from("OSC52-DENIED").toString("base64")}\\007`);
    await s.until("terminal.session", (value) => /clipboard/i.test(value.error ?? ""), "a denied OSC 52 store was not reported", { surface });
    assert.equal(pasteboardText(), before, "a denied OSC 52 store changed the pasteboard");
    await s.run("core.settings.change", { key: "terminal.clipboard.program", value: "allow", scope: "common" });
    s.cleanup(() => s.run("core.settings.change", { key: "terminal.clipboard.program", value: "deny", scope: "common" }));
    await effect(s, surface, `\\033]52;c;${Buffer.from("OSC52-ALLOWED").toString("base64")}\\007`);
    await s.until("terminal.session", () => pasteboardText() === "OSC52-ALLOWED", "an allowed OSC 52 store did not reach the pasteboard", { surface });
    assert.equal(await reply(s, surface, "\\033]52;c;?\\007", "\"$b\""), `\x1b]52;c;${Buffer.from("OSC52-ALLOWED").toString("base64")}`,
      "OSC 52 query");
  });
  test(`${app.name}: mouse, focus, paste, and alternate-scroll modes report input`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const [terminal] = await ensureTerminals(s, 1);
    s.cleanup(() => closeTerminalTabs(s));
    const surface = terminal.surface;
    await readScreenUntil(s, surface, (lines) => lines.some((line) => line.includes("$")), "shell prompt missing");
    // ?1005 는 96 열 이상의 좌표에서만 UTF-8 두 바이트를 쓴다. 기본 창 폭에서는 고정 사이드바 때문에 터미널이 그보다
    // 좁으므로 창을 잠시 넓히고 검사 뒤 되돌린다.
    const { content } = await s.get("host.window");
    s.cleanup(() => s.run("host.window.resize", { width: content.width, height: content.height }));
    await s.run("host.window.resize", { width: content.width + 160, height: content.height });
    await s.until("terminal.session", (session) => session?.cols >= 100, "the widened terminal did not reach 100 columns", { surface });
    await s.run("terminal.input", { bytes: SETUP }, surface);
    await s.presented();
    const view = await s.rect("terminal.view", undefined, surface);
    const { cellWidth, cellHeight } = await s.get("terminal.session", surface);
    // 1부터 센 칸 (col, row) 의 가운데.
    const cell = (col, row) => ({ x: view.document.x + view.x + (col - 0.5) * cellWidth, y: view.document.y + view.y + (row - 0.5) * cellHeight });

    // ?1000 과 ?1006: 누름과 뗌을 SGR 로 알린다.
    const click = cell(10, 5);
    const clicked = "\x1b[<0;10;5M\x1b[<0;10;5m";
    assert.equal(await report(s, surface, "\\033[?1000h\\033[?1006h", clicked.length, "\\033[?1000l\\033[?1006l",
      () => s.click(click.x, click.y)), clicked, "?1000 and ?1006 click report");
    // ?1000 과 ?1005: 95 열을 넘는 좌표를 UTF-8 로 알린다.
    const far = cell(100, 5);
    assert.equal(Buffer.from(await report(s, surface, "\\033[?1000h\\033[?1005h", 14, "\\033[?1000l\\033[?1005l",
      () => s.click(far.x, far.y)), "latin1").toString("hex"), Buffer.from("\x1b[M \u0084%\x1b[M#\u0084%", "utf8").toString("hex"),
      "?1005 UTF-8 coordinates");
    // ?1002: 누른 채 움직이면 움직임을 알린다.
    const to = cell(12, 5);
    const dragged = "\x1b[<0;10;5M\x1b[<32;12;5M\x1b[<0;12;5m";
    assert.equal(await report(s, surface, "\\033[?1002h\\033[?1006h", dragged.length, "\\033[?1002l\\033[?1006l", async () => {
      await s.pointer(click.x, click.y, "down");
      await s.pointer(to.x, to.y, "drag");
      await s.pointer(to.x, to.y, "up");
    }), dragged, "?1002 button motion report");
    // ?1000 과 ?1006 에서 휠은 줄마다 휠 단추를 알린다. 31 픽셀은 두 줄이다.
    const wheel = await report(s, surface, "\\033[?1000h\\033[?1006h", "\x1b[<64;10;5M".length * 2, "\\033[?1000l\\033[?1006l",
      () => s.pointer(click.x, click.y, "scroll", { deltaY: 31 }));
    assert.match(wheel, /^(\x1b\[<6[45];10;5M){2}$/, `?1000 wheel report: ${JSON.stringify(wheel)}`);
    // ?1007: 대체 화면에서 휠은 방향키가 된다. ?1 이 켜지면 방향키는 응용 커서 키(ESC O)다.
    const arrows = await report(s, surface, "\\033[?1049h\\033[?1007h", 6, "\\033[?1007l\\033[?1049l",
      () => s.pointer(click.x, click.y, "scroll", { deltaY: 31 }));
    assert.match(arrows, /^(\x1b\[[AB]){2}$/, `?1007 alternate scroll: ${JSON.stringify(arrows)}`);
    const application = await report(s, surface, "\\033[?1h\\033[?1049h\\033[?1007h", 6, "\\033[?1007l\\033[?1049l\\033[?1l",
      () => s.pointer(click.x, click.y, "scroll", { deltaY: 31 }));
    assert.match(application, /^(\x1bO[AB]){2}$/, `?1 application cursor keys: ${JSON.stringify(application)}`);
    // ?2004: 붙여넣기를 괄호로 감싼다.
    writePasteboard([{ "public.utf8-plain-text": Buffer.from("PASTE").toString("base64") }]);
    assert.equal(await report(s, surface, "\\033[?2004h", 17, "\\033[?2004l", () => s.run("terminal.paste", {}, surface)),
      "\x1b[200~PASTE\x1b[201~", "?2004 bracketed paste");
    // ?1004: 초점을 잃고 얻을 때 알린다.
    await s.run("terminal.focus", {}, surface);
    await s.until("terminal.cursor", (cursor) => cursor.focused === true, "the terminal did not take focus", { surface });
    const outside = await s.rect("core.card.close", 0);
    assert.equal(await report(s, surface, "\\033[?1004h", 6, "\\033[?1004l", async () => {
      await s.click(outside.document.x + outside.x - 40, outside.document.y + outside.y + outside.height / 2);
      await s.until("terminal.cursor", (cursor) => cursor.focused === false, "the terminal did not lose focus", { surface });
      await s.run("terminal.focus", {}, surface);
    }), "\x1b[O\x1b[I", "?1004 focus report");
  });

  test(`${app.name}: repeated card focus keeps terminal drag PTY ownership idempotent`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const terminals = await ensureTerminals(s, 1);
    s.cleanup(() => closeTerminalTabs(s));
    const [first] = terminals;
    const surface = first.surface;
    await readScreenUntil(s, surface, (lines) => lines.some((line) => line.includes("$")), "first terminal prompt missing");
    await s.run("terminal.input", { bytes: SETUP }, surface);
    const view = await s.rect("terminal.view", undefined, surface);
    const metrics = await s.get("terminal.session", surface);
    const point = (col, row) => ({
      x: view.document.x + view.x + (col + 0.5) * metrics.cellWidth,
      y: view.document.y + view.y + (row + 0.5) * metrics.cellHeight,
    });
    const from = point(8, 4);
    const to = point(12, 4);
    const grid = await s.get("core.grid");
    const card = (surfaceId) => grid.cards.find((item) => item.tabs.some((tab) => tab.id === surfaceId))?.id;
    const firstCard = card(first.surface);
    const secondCard = grid.cards.find((item) => item.id !== firstCard && item.id !== "left")?.id;
    assert.ok(firstCard && secondCard, `two cards are required for the focus sequence: ${JSON.stringify(grid)}`);
    assert.ok(firstCard && secondCard, "two terminal cards are required for the focus sequence");
    const expected = "\x1b[<0;9;5M\x1b[<32;13;5M\x1b[<0;13;5m";
    for (let attempt = 0; attempt < 5; attempt++) {
      const bytes = await report(s, surface, "\\033[?1003h\\033[?1006h", expected.length,
        "\\033[?1003l\\033[?1006l", async () => {
        await s.run("core.card.focus", { card: secondCard });
        await s.until("core.grid", (value) => value.cards.some((item) => item.id === secondCard && item.focused),
          `attempt ${attempt + 1}: second card did not focus`);
        await s.run("core.card.focus", { card: firstCard });
        await s.until("core.grid", (value) => value.cards.some((item) => item.id === firstCard && item.focused),
          `attempt ${attempt + 1}: first card did not refocus`);
        await s.run("terminal.focus", {}, surface);
        await s.until("terminal.cursor", (value) => value.focused === true,
          `attempt ${attempt + 1}: first terminal did not regain focus`, { surface });
        await s.pointer(from.x, from.y, "down", { button: "left" });
        await s.pointer(to.x, to.y, "drag", { button: "left" });
        await s.pointer(to.x, to.y, "up", { button: "left" });
      });
      assert.equal(bytes, expected, `attempt ${attempt + 1}: drag PTY bytes were missing or reordered`);
      const state = await s.get("terminal.session", surface);
      assert.equal(state.error, undefined, `attempt ${attempt + 1}: terminal session error ${state.error}`);
    }
  });
}
