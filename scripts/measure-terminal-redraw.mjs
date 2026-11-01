// Reports the CPU that a shown terminal costs while its program redraws a status block at a fixed rate (docs/operations/examples.md). It
// starts scripts/fixtures/status-redraw.mjs in the terminal surface SURFACE of the running application of CONFIG_DIR with terminal.input,
// waits until the screen shows the start line of the fixture, ends that watch, because a watch of terminal.screen relays every screen too,
// and measures the CPU of each process of the application over INTERVAL seconds with measure-app-usage.mjs. It prints the CPU share of each
// process and its CPU milliseconds per frame. Every error is printed to stderr, and the exit status is 1 when an error occurred.
// `make terminal-redraw-usage` runs it.
//
//   node scripts/measure-terminal-redraw.mjs --sok PATH --config-dir DIR --surface SURFACE [--rate 20] [--interval 10] [--json]
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { isAbsolute } from "node:path";
import { parseArgs } from "node:util";
import { measureApps } from "./measure-app-usage.mjs";

const FIXTURE = fileURLToPath(new URL("./fixtures/status-redraw.mjs", import.meta.url));
const START = "status-redraw start";

/** The command line options. */
export function parseOptions(args) {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      sok: { type: "string" },
      "config-dir": { type: "string" },
      surface: { type: "string" },
      rate: { type: "string", default: "20" },
      interval: { type: "string", default: "10" },
      json: { type: "boolean", default: false },
    },
  });
  if (!values.sok || !values["config-dir"] || !values.surface) throw new Error("required options: --sok PATH --config-dir DIR --surface SURFACE");
  if (!isAbsolute(values["config-dir"])) throw new Error(`--config-dir must be an absolute path (${values["config-dir"]})`);
  const rate = Number(values.rate);
  if (!Number.isInteger(rate) || rate < 1 || rate > 120) throw new Error(`--rate must be an integer from 1 to 120 (${values.rate})`);
  const interval = Number(values.interval);
  if (!(interval > 0)) throw new Error(`--interval must be a positive number of seconds (${values.interval})`);
  return { sok: values.sok, configDir: values["config-dir"], surface: values.surface, rate, interval, json: values.json };
}

/** The CPU milliseconds per frame of a process that used cpuPercent of a core while the program drew rate frames per second. */
export function frameMilliseconds(cpuPercent, rate) {
  if (!Number.isFinite(cpuPercent) || cpuPercent < 0) throw new Error(`cpu share must be a nonnegative number (${cpuPercent})`);
  if (!Number.isInteger(rate) || rate < 1) throw new Error(`rate must be a positive integer (${rate})`);
  return (cpuPercent / 100) * 1000 / rate;
}

/** The text of a terminal.screen value: each row joined from the characters of its cells, an empty cell as a space. */
export function screenText(rows) {
  if (!Array.isArray(rows)) throw new Error("terminal.screen is not a list of rows");
  return rows.map((row) => row.map((cell) => cell.ch ?? " ".repeat(cell.width)).join("")).join("\n");
}

/** Resolves when a line of the watch of terminal.screen of surface shows the start line of the fixture; it ends the watch. */
function waitForStart(sok, configDir, surface) {
  return new Promise((resolve, reject) => {
    const watch = spawn(sok, ["status", "terminal.screen", "--surface", surface, "--watch", "--config-dir", configDir],
      { stdio: ["ignore", "pipe", "pipe"] });
    let errors = "";
    let done = false;
    watch.stderr.on("data", (chunk) => { errors += chunk; });
    createInterface({ input: watch.stdout }).on("line", (line) => {
      if (done || !screenText(JSON.parse(line)).includes(START)) return;
      done = true;
      watch.kill();
      resolve();
    });
    watch.on("error", reject);
    watch.on("exit", (code) => {
      if (!done) reject(new Error(`sok status terminal.screen --watch ended with ${code} before the fixture started: ${errors.trim()}`));
    });
  });
}

async function measureRedraw({ sok, configDir, surface, rate, interval }) {
  // The fixture draws for the interval and a margin, so it draws during the whole measurement.
  const text = `node ${JSON.stringify(FIXTURE)} ${rate} ${interval + 5}\n`;
  const started = waitForStart(sok, configDir, surface);
  const input = spawnSync(sok, ["terminal.input", "--surface", surface, "--params", JSON.stringify({ bytes: text }), "--config-dir", configDir],
    { encoding: "utf8" });
  if (input.status !== 0) throw new Error(`sok terminal.input failed: ${input.stderr.trim()}`);
  await started;
  const result = await measureApps({ sok, configDirs: [configDir], interval });
  const rows = result.apps[0].rows.map((row) => ({
    ...row, frameMilliseconds: row.cpuPercent === null ? null : frameMilliseconds(row.cpuPercent, rate),
  }));
  return { rate, interval, surface, rows, errors: result.errors };
}

function formatReport({ rate, interval, surface, rows }) {
  const lines = [`terminal ${surface}: ${rate} frames per second, ${interval} s`, "role pid cpu% ms/frame attribution"];
  for (const row of rows) {
    lines.push([row.role, row.pid, row.cpuPercent?.toFixed(1) ?? "-", row.frameMilliseconds?.toFixed(2) ?? "-", row.attribution ?? ""].join(" "));
  }
  const total = rows.reduce((sum, row) => sum + (row.cpuPercent ?? 0), 0);
  lines.push(`total ${total.toFixed(1)}% ${frameMilliseconds(total, rate).toFixed(2)} ms/frame`);
  return lines.join("\n");
}

if (import.meta.main) {
  try {
    const options = parseOptions(process.argv.slice(2));
    const result = await measureRedraw(options);
    console.log(options.json ? JSON.stringify(result, null, 2) : formatReport(result));
    for (const error of result.errors) console.error(`error: ${error}`);
    if (result.errors.length > 0) process.exitCode = 1;
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exitCode = 1;
  }
}
