// A full-screen TUI that the real-input window check runs inside the terminal. On the alternate screen it turns on ?1003 motion reporting and ?1006 SGR
// encoding, and draws the cells it selected itself in inverse from the mouse reports it receives. It checks the mouse reporting, selection, and focus paths of the terminal
// under the same conditions without an external program.
//
//   node e2e/fixture-tui.mjs        Ends with q or Ctrl-C.
import { pathToFileURL } from "node:url";

/** The header of the first row and the word to select. */
export const HEADER = "  >_ Fixture TUI";
export const HEADER_WORD = "Fixture";
/** The guide text of the input row. */
export const PROMPT = "Ask fixture";

/**
 * Reads SGR mouse reports (`ESC [ < b ; x ; y M|m`). The return value is {events, rest}, and the cell coordinates of events count from 0.
 * A report that is cut at the end is left in rest and joined with the next input. Bytes that are not a report are returned as keys.
 */
export function parseInput(text) {
  const events = [];
  let keys = "";
  let index = 0;
  while (index < text.length) {
    if (text.startsWith("\x1b[<", index)) {
      const match = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(text.slice(index));
      if (!match) {
        // If only digits and separators remain until the end, the report is cut. If other bytes are mixed in, it is not a report.
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
 * Changes the selection with one mouse report. A left press starts a new selection at that cell, and a motion while pressed and the release move the end cell.
 * The selection is [start cell, end cell) in the pressed row, so a click on the same cell is an empty selection.
 * A motion without a press (?1003) does not change the selection.
 */
export function select(selection, event) {
  const button = event.code & 0b11;
  const motion = (event.code & 32) !== 0;
  if (button !== 0 && !(event.release || motion)) return selection;
  if (!event.release && !motion) return { row: event.row, anchor: event.col, end: event.col, pressed: true };
  if (!selection?.pressed) return selection;
  return { ...selection, end: event.col, pressed: !event.release };
}

/** The [first, end) range of cells that the selection covers. It is null when there is no selection. */
export function selectedRange(selection) {
  if (!selection || selection.anchor === selection.end) return null;
  return { row: selection.row, from: Math.min(selection.anchor, selection.end), to: Math.max(selection.anchor, selection.end) };
}

/** The string of each row of the screen. The header is after the first row, and the guide text is in the second row from the last. */
export function screenLines(rows, cols) {
  const lines = Array.from({ length: rows }, () => "");
  lines[1] = HEADER;
  lines[Math.max(2, rows - 2)] = `> ${PROMPT}`;
  return lines.map((line) => line.slice(0, cols).padEnd(cols, " "));
}

/** The bytes that draw the whole screen. Selected cells are drawn in inverse (SGR 7). */
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

/** The input that runs this TUI in the check shell. It runs this file with the node that runs the check. */
export const LAUNCH = `'${process.execPath}' '${new URL(import.meta.url).pathname}'\r`;
