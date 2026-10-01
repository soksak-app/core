// 실제 입력 창 검사가 터미널 안에서 실행하는 전체 화면 TUI. alternate screen 에서 ?1003 motion 보고와 ?1006 SGR
// 인코딩을 켜고, 받은 마우스 보고로 직접 선택한 칸을 반전해 그린다. 터미널의 마우스 보고, 선택, 초점 경로를 외부
// 프로그램 없이 같은 조건으로 검사한다.
//
//   node e2e/fixture-tui.mjs        q 또는 Ctrl-C 로 끝낸다.
import { pathToFileURL } from "node:url";

/** 첫 행의 머리글과 선택 대상 낱말. */
export const HEADER = "  >_ Fixture TUI";
export const HEADER_WORD = "Fixture";
/** 입력 행의 안내문. */
export const PROMPT = "Ask fixture";

/**
 * SGR 마우스 보고(`ESC [ < b ; x ; y M|m`)를 읽는다. 반환값은 {events, rest} 이며 events 의 칸 좌표는 0부터 센다.
 * 끝이 잘린 보고는 rest 로 남겨 다음 입력과 잇는다. 보고가 아닌 바이트는 keys 로 돌려준다.
 */
export function parseInput(text) {
  const events = [];
  let keys = "";
  let index = 0;
  while (index < text.length) {
    if (text.startsWith("\x1b[<", index)) {
      const match = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(text.slice(index));
      if (!match) {
        // 끝까지 숫자와 구분자뿐이면 잘린 보고다. 그 밖의 바이트가 섞이면 보고가 아니다.
        if (/^\x1b\[<[\d;]*$/.test(text.slice(index))) return { events, keys, rest: text.slice(index) };
        throw new Error(`invalid mouse report ${JSON.stringify(text.slice(index, index + 16))}`);
      }
      const code = Number(match[1]);
      events.push({ code, col: Number(match[2]) - 1, row: Number(match[3]) - 1, release: match[4] === "m" });
      index += match[0].length;
    } else {
      keys += text[index];
      index += 1;
    }
  }
  return { events, keys, rest: "" };
}

/**
 * 마우스 보고 하나로 선택을 바꾼다. 왼쪽 누름은 그 칸에서 새 선택을 시작하고, 누른 채 움직임과 뗌은 끝 칸을 옮긴다.
 * 선택은 누른 행의 [시작 칸, 끝 칸) 이므로 같은 칸의 클릭은 빈 선택이다. 누르지 않은 움직임(?1003)은 선택을 바꾸지
 * 않는다.
 */
export function select(selection, event) {
  const button = event.code & 0b11;
  const motion = (event.code & 32) !== 0;
  if (button !== 0 && !(event.release || motion)) return selection;
  if (!event.release && !motion) return { row: event.row, anchor: event.col, end: event.col, pressed: true };
  if (!selection?.pressed) return selection;
  return { ...selection, end: event.col, pressed: !event.release };
}

/** 선택이 덮는 칸의 [처음, 끝) 범위. 선택이 없으면 null 이다. */
export function selectedRange(selection) {
  if (!selection || selection.anchor === selection.end) return null;
  return { row: selection.row, from: Math.min(selection.anchor, selection.end), to: Math.max(selection.anchor, selection.end) };
}

/** 화면의 각 행 문자열. 첫 행 다음에 머리글, 마지막에서 두 번째 행에 안내문을 둔다. */
export function screenLines(rows, cols) {
  const lines = Array.from({ length: rows }, () => "");
  lines[1] = HEADER;
  lines[Math.max(2, rows - 2)] = `> ${PROMPT}`;
  return lines.map((line) => line.slice(0, cols).padEnd(cols, " "));
}

/** 화면 전체를 그리는 바이트. 선택한 칸은 반전(SGR 7)으로 그린다. */
export function render(rows, cols, selection) {
  const range = selectedRange(selection);
  const lines = screenLines(rows, cols);
  let out = "\x1b[H";
  lines.forEach((line, row) => {
    out += `\x1b[${row + 1};1H`;
    if (range?.row === row) {
      out += `${line.slice(0, range.from)}\x1b[7m${line.slice(range.from, range.to)}\x1b[27m${line.slice(range.to)}`;
    } else {
      out += line;
    }
  });
  return out;
}

function main() {
  const { stdin, stdout } = process;
  if (!stdin.isTTY || !stdout.isTTY) throw new Error("fixture-tui requires a terminal");
  let selection = null;
  let pending = "";
  const draw = () => stdout.write(render(stdout.rows, stdout.columns, selection));
  const finish = () => {
    stdout.write("\x1b[?1003l\x1b[?1006l\x1b[?25h\x1b[?1049l");
    stdin.setRawMode(false);
    process.exit(0);
  };
  stdin.setRawMode(true);
  stdin.setEncoding("latin1");
  stdout.write("\x1b[?1049h\x1b[?25l\x1b[2J\x1b[?1003h\x1b[?1006h");
  draw();
  stdout.on("resize", draw);
  stdin.on("data", (chunk) => {
    const { events, keys, rest } = parseInput(pending + chunk);
    pending = rest;
    for (const event of events) selection = select(selection, event);
    if (events.length) draw();
    if (keys.includes("q") || keys.includes("\x03")) finish();
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main();

/** 검사 셸에서 이 TUI 를 실행하는 입력. 검사를 실행하는 node 로 이 파일을 실행한다. */
export const LAUNCH = `'${process.execPath}' '${new URL(import.meta.url).pathname}'\r`;
