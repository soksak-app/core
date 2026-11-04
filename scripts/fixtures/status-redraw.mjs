// Rewrites ROWS rows at the bottom of a terminal at a fixed rate, as an interactive command-line program redraws its status line or a
// block of rows, for the terminal redraw measurement (scripts/measure-terminal-redraw.mjs). It prints a start line and ROWS empty rows,
// then RATE frames per second for SECONDS seconds, each of which moves the cursor up ROWS rows and rewrites them: the first row holds a
// spinner and the elapsed time and each further row the frame number. It ends with a line that holds the number of frames it drew.
//
//   node scripts/fixtures/status-redraw.mjs RATE SECONDS ROWS
const [rate, seconds, rows] = process.argv.slice(2).map(Number);
if (!Number.isInteger(rate) || rate < 1 || rate > 120) throw new Error(`rate must be an integer from 1 to 120, got ${process.argv[2]}`);
if (!(seconds > 0)) throw new Error(`seconds must be a positive number, got ${process.argv[3]}`);
if (!Number.isInteger(rows) || rows < 1) throw new Error(`rows must be a positive integer, got ${process.argv[4]}`);

const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
const started = Date.now();
let frames = 0;
process.stdout.write(`status-redraw start rate=${rate} rows=${rows}\n${"\n".repeat(rows)}`);
// The fixed rate is the content of the fixture: each tick draws one frame of the rows.
const timer = setInterval(() => {
  frames += 1;
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  const lines = [`${SPINNER[frames % SPINNER.length]} Working (${elapsed}s)`];
  for (let row = 2; row <= rows; row++) lines.push(`  row ${row} frame ${frames}`);
  process.stdout.write(`\x1b[${rows}A${lines.map((line) => `\r\x1b[2K${line}\n`).join("")}`);
  if (Date.now() - started >= seconds * 1000) {
    clearInterval(timer);
    process.stdout.write(`status-redraw end frames=${frames}\n`);
  }
}, 1000 / rate);
