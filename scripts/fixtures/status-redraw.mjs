// Redraws a status block of three lines at the bottom of a terminal at a fixed rate, as an interactive command-line program redraws its
// status line, for the terminal redraw measurement (scripts/measure-terminal-redraw.mjs). It prints a start line, then RATE frames per second
// for SECONDS seconds, then an end line with the number of frames it drew.
//
//   node scripts/fixtures/status-redraw.mjs RATE SECONDS
const [rate, seconds] = process.argv.slice(2).map(Number);
if (!Number.isInteger(rate) || rate < 1 || rate > 120) throw new Error(`rate must be an integer from 1 to 120, got ${process.argv[2]}`);
if (!(seconds > 0)) throw new Error(`seconds must be a positive number, got ${process.argv[3]}`);

const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
const started = Date.now();
let frames = 0;
process.stdout.write(`status-redraw start rate=${rate}\n\n\n\n`);
// The fixed rate is the content of the fixture: each tick draws one frame of the status block.
const timer = setInterval(() => {
  frames += 1;
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  process.stdout.write(`\x1b[3A\r\x1b[2K${SPINNER[frames % SPINNER.length]} Working (${elapsed}s)\n\r\x1b[2K  frame ${frames}\n\r\x1b[2K  > \n`);
  if (Date.now() - started >= seconds * 1000) {
    clearInterval(timer);
    process.stdout.write(`status-redraw end frames=${frames}\n`);
  }
}, 1000 / rate);
