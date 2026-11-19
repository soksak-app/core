// An input box of an interactive command-line program, as an agent program draws its prompt, for the terminal input measurement
// (scripts/measure-terminal-input.mjs). It reads the terminal in raw mode with bracketed paste on (DEC 2004) and keeps one input text.
// After every read that changes the text it draws the whole box again in one synchronized update (DEC 2026): a top border, the text
// wrapped to the width of the terminal inside a left and a right border, a bottom border and a status line `input-box chars=N`. A box
// lower than the screen is drawn over the box before it, from its first row; a box as high as the screen or higher clears the screen
// and the history and is drawn from the top, as such a program does when its output no longer fits. A printable character and the
// text of a paste are added, Delete removes the last character, Control-U clears the text and Control-C ends the program with the
// line `input-box end chars=N`. The text holds ASCII characters only, so that one character takes one cell.
//
//   node scripts/fixtures/input-box.mjs
const SYNC_BEGIN = "\x1b[?2026h";
const SYNC_END = "\x1b[?2026l";
const PASTE_BEGIN = "\x1b[200~";
const PASTE_END = "\x1b[201~";

if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("input-box needs a terminal on its standard input and output");

let text = "";
let drawnRows = 0;
// The bytes of a paste that has not ended yet, or null outside a paste.
let pasting = null;

/** The rows of the box of `value` for `columns` columns: the borders, the wrapped text and the status line. */
function boxRows(value, columns) {
  const inner = Math.max(1, columns - 4);
  const lines = [];
  for (let start = 0; start < value.length; start += inner) lines.push(value.slice(start, start + inner));
  if (lines.length === 0) lines.push("");
  return [
    `┌${"─".repeat(inner + 2)}┐`,
    ...lines.map((line) => `│ ${line.padEnd(inner)} │`),
    `└${"─".repeat(inner + 2)}┘`,
    `input-box chars=${value.length}`,
  ];
}

function draw() {
  const rows = boxRows(text, process.stdout.columns);
  const screen = process.stdout.rows;
  const start = rows.length >= screen || drawnRows >= screen
    ? "\x1b[2J\x1b[3J\x1b[H"
    : `${drawnRows > 1 ? `\x1b[${drawnRows - 1}A` : ""}\r\x1b[J`;
  process.stdout.write(`${SYNC_BEGIN}${start}${rows.join("\r\n")}${SYNC_END}`);
  drawnRows = rows.length;
}

/** Applies the bytes `data` of one read outside a paste. */
function typed(data) {
  for (const ch of data) {
    if (ch === "\x03") {
      process.stdout.write(`\x1b[?2004l\r\ninput-box end chars=${text.length}\r\n`);
      process.exit(0);
    } else if (ch === "\x15") text = "";
    else if (ch === "\x7f") text = text.slice(0, -1);
    else if (ch >= " " && ch <= "~") text += ch;
  }
}

process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.stdout.write("\x1b[?2004hinput-box start\r\n");
draw();
process.stdin.on("data", (data) => {
  let rest = data;
  while (rest.length > 0) {
    if (pasting !== null) {
      const end = rest.indexOf(PASTE_END);
      if (end === -1) {
        pasting += rest;
        rest = "";
      } else {
        text += pasting + rest.slice(0, end);
        pasting = null;
        rest = rest.slice(end + PASTE_END.length);
      }
    } else {
      const begin = rest.indexOf(PASTE_BEGIN);
      typed(begin === -1 ? rest : rest.slice(0, begin));
      if (begin === -1) rest = "";
      else {
        pasting = "";
        rest = rest.slice(begin + PASTE_BEGIN.length);
      }
    }
  }
  // A paste that has not ended draws nothing yet; its end draws the text once.
  if (pasting === null) draw();
});
