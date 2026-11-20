// Reports the CPU time and the memory of each process of a running application while the input of a program in one terminal tab
// grows (docs/operations/examples.md#terminal-input-measurement). It opens the window and the tab of the plugin PLUGIN as
// make measure-terminal-text does (withTerminalTab of scripts/measure-terminal-text.mjs) and measures two programs:
//   shell   the shell of the tab, whose line editor redraws the line that a person types;
//   box     scripts/fixtures/input-box.mjs, which draws its whole input box again in one synchronized update after every read, as an
//           agent program draws its prompt.
// For each input length of LENGTHS, in increasing order, it clears the input with Control-U, gives the program the input of that length
// (`inputText`; typed bytes for the shell, a bracketed paste for the box, which draws once) through `<plugin>.input` and waits until
// `<plugin>.screen` shows its end. It then measures with measureApps of scripts/measure-app-usage.mjs an idle interval of FRAMES display
// periods at the refresh rate that host.window reports right before it, after the footprints settled, and an interval of KEYS presses of
// `a` through input.key, each after the region presented the frame of the key before it. For each length of PASTES it then clears the
// input and measures one bracketed paste of that length, from the input to the screen that shows its end. A bracketed paste reaches the
// program as the bytes `ESC [ 200 ~`, the text and `ESC [ 201 ~` through `<plugin>.input`, because the declared paste of a terminal reads
// the clipboard of the person. The wait for the screen of a paste is part of its interval: a watch of the screen reads each screen of
// the paste, which no other status announces. The programs run as children of the session of the sidecar, so their own CPU is not part
// of the figures. It prints, for each program and length, the CPU milliseconds per display period and per key and the footprint of each
// process, and for each paste its CPU milliseconds and its seconds, with the load of the machine that `top -l 1` reports at the start of
// each interval. Every error is printed to stderr, and the exit status is 1 when an error occurred. `make measure-terminal-input` runs it.
//
// PLUGIN is an argument of the caller and has no default: the script names no plugin and measures a plugin of the installed environment
// that exposes `<plugin>.input` and `<plugin>.screen`. It judges no value and gates nothing.
//
//   node scripts/measure-terminal-input.mjs --sok PATH --config-dir DIR --plugin PLUGIN [--lengths 0,1000,10000,50000]
//     [--pastes 10000,50000] [--frames 600] [--keys 40] [--json]
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { screenText } from "./measure-terminal-redraw.mjs";
import { clearLine, interval, intervalFigures, presented, untilPresented, withTerminalTab } from "./measure-terminal-text.mjs";

const BOX = fileURLToPath(new URL("./fixtures/input-box.mjs", import.meta.url));
const PASTE_BEGIN = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const READY = "input-ready";
// The command splits the word, so that its echo on the screen is not the line that it prints.
const READY_LINE = "printf 'input-''ready\\n'";

/** The command line options. */
export function parseOptions(args) {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      sok: { type: "string" },
      "config-dir": { type: "string" },
      plugin: { type: "string" },
      lengths: { type: "string", default: "0,1000,10000,50000" },
      pastes: { type: "string", default: "10000,50000" },
      frames: { type: "string", default: "600" },
      keys: { type: "string", default: "40" },
      json: { type: "boolean", default: false },
    },
  });
  if (!values.sok || !values["config-dir"] || !values.plugin) throw new Error("required options: --sok PATH --config-dir DIR --plugin PLUGIN");
  if (!isAbsolute(values["config-dir"])) throw new Error(`--config-dir must be an absolute path (${values["config-dir"]})`);
  return {
    sok: values.sok, configDir: values["config-dir"], plugin: values.plugin,
    lengths: parseLengths("--lengths", values.lengths, 0), pastes: parseLengths("--pastes", values.pastes, 1),
    frames: parseLengths("--frames", values.frames, 1)[0], keys: parseLengths("--keys", values.keys, 1)[0], json: values.json,
  };
}

/** The integers of the comma-separated list `text` of the option `name`, each at least `least`, in increasing order. */
export function parseLengths(name, text, least) {
  const values = text.split(",").map((part) => {
    const value = Number(part.trim());
    if (!Number.isInteger(value) || value < least) throw new Error(`${name} must hold integers of at least ${least} (${text})`);
    return value;
  });
  for (let index = 1; index < values.length; index++) {
    if (values[index] <= values[index - 1]) throw new Error(`${name} must increase (${text})`);
  }
  return values;
}

/** The end of an input of `length` characters, which names the length, so that the screen shows which input arrived. */
export const inputEnd = (length) => `]${length}[`;

/**
 * The input of `length` characters: digits, and at its end inputEnd(length) when that fits, so that the screen shows that the whole
 * input arrived. A length shorter than its end is digits alone, and 0 is empty.
 */
export function inputText(length) {
  if (!Number.isInteger(length) || length < 0) throw new Error(`an input length must be a non-negative integer, not ${length}`);
  const end = inputEnd(length);
  const digits = (count) => "0123456789".repeat(Math.ceil(count / 10)).slice(0, count);
  return length < end.length ? digits(length) : `${digits(length - end.length)}${end}`;
}

/** The bytes of a bracketed paste of `text`. */
export const pasteBytes = (text) => `${PASTE_BEGIN}${text}${PASTE_END}`;

/** Whether the screen `rows` of a terminal shows `text`, which may wrap over several rows. */
export const shows = (rows, text) => screenText(rows).replaceAll("\n", "").includes(text);

/** Whether the screen `rows` shows the status line of the input box with `chars` characters. */
export const boxShows = (rows, chars) => screenText(rows).split("\n").some((row) => row.trimEnd() === `input-box chars=${chars}`);

/** Presses `count` keys `a`, each after the region of `tab` presented the frame of the key before it. */
async function typeKeys(s, tab, count, periodMs) {
  let shown = (await presented(s, tab)).frames;
  for (let key = 0; key < count; key++) {
    await s.key("a", "down", { text: "a" });
    await s.key("a", "up", { text: "a" });
    shown = await untilPresented(s, tab, shown, periodMs);
  }
}

/**
 * Measures the program in the tab for each length: `fill(length)` gives the program the input and waits for it, `filled(rows, length,
 * keys)` judges a screen after the keys. Then measures each paste: `pasted(rows, length)` judges the screen that shows its end.
 */
async function measureProgram({ s, tab, sok, configDir, plugin, lengths, pastes, frames, keys, fill, filled, pasted }) {
  const { refreshRate } = await s.get("host.window");
  if (!(refreshRate > 0)) throw new Error(`host.window of ${s.window} reports the refresh rate ${JSON.stringify(refreshRate)}`);
  const periodMs = 1000 / refreshRate;
  const screen = (predicate, message) => s.until(`${plugin}.screen`, predicate, message, { surface: tab });
  const inputs = [];
  for (const length of lengths) {
    await clearLine(s);
    await fill(length);
    const idle = await interval({ s, tab, sok, configDir, footprints: "settled", seconds: frames / refreshRate });
    const typed = await interval({ s, tab, sok, configDir, footprints: "at-once", span: () => typeKeys(s, tab, keys, periodMs) });
    await screen((rows) => filled(rows, length, keys), `the tab ${tab} did not show the ${keys} keys after an input of ${length}`);
    inputs.push({
      length,
      idle: { ...intervalFigures({ measurement: idle.measurement, actions: frames }), refreshRate, load: idle.load, presented: idle.presented, occluded: idle.occluded },
      keys: { ...intervalFigures({ measurement: typed.measurement, actions: keys }), load: typed.load, presented: typed.presented, occluded: typed.occluded },
    });
  }
  const pasteResults = [];
  for (const length of pastes) {
    await clearLine(s);
    await fill(0);
    const paste = await interval({
      s, tab, sok, configDir, footprints: "at-once",
      span: async () => {
        await s.run(`${plugin}.input`, { bytes: pasteBytes(inputText(length)) }, tab);
        await screen((rows) => pasted(rows, length), `the tab ${tab} did not show the paste of ${length}`);
      },
    });
    pasteResults.push({ length, ...intervalFigures({ measurement: paste.measurement, actions: 1 }), load: paste.load, presented: paste.presented, occluded: paste.occluded });
  }
  await clearLine(s);
  return { inputs, pastes: pasteResults };
}

async function measureInput({ sok, configDir, plugin, lengths, pastes, frames, keys }) {
  return withTerminalTab({ configDir, plugin, prefix: "terminal-input-project-" }, async ({ s, tab }) => {
    const screen = (predicate, message) => s.until(`${plugin}.screen`, predicate, message, { surface: tab });
    const common = { s, tab, sok, configDir, plugin, lengths, pastes, frames, keys };
    // An input that reaches the terminal before the line editor of the shell starts is read by the terminal in its line mode,
    // which keeps a bounded line and echoes it; the shell runs a short line first, and its output shows that the editor reads.
    await s.run(`${plugin}.input`, { bytes: `${READY_LINE}\n` }, tab);
    await screen((rows) => screenText(rows).split("\n").some((row) => row.trimEnd() === READY), `the shell of ${tab} did not print ${READY}`);
    const shell = await measureProgram({
      ...common,
      fill: async (length) => {
        if (length === 0) return;
        await s.run(`${plugin}.input`, { bytes: inputText(length) }, tab);
        await screen((rows) => shows(rows, inputText(length).slice(-40)), `the shell of ${tab} did not show the input of ${length}`);
      },
      filled: (rows, length, count) => shows(rows, `${inputText(length).slice(-20)}${"a".repeat(count)}`),
      pasted: (rows, length) => shows(rows, inputText(length).slice(-40)),
    });
    await s.run(`${plugin}.input`, { bytes: `node ${JSON.stringify(BOX)}\n` }, tab);
    await screen((rows) => boxShows(rows, 0), `the input box did not start in ${tab}`);
    const box = await measureProgram({
      ...common,
      fill: async (length) => {
        await screen((rows) => boxShows(rows, 0), `the input box of ${tab} did not clear its input`);
        if (length === 0) return;
        await s.run(`${plugin}.input`, { bytes: pasteBytes(inputText(length)) }, tab);
        await screen((rows) => boxShows(rows, length), `the input box of ${tab} did not show the input of ${length}`);
      },
      filled: (rows, length, count) => boxShows(rows, length + count),
      pasted: (rows, length) => boxShows(rows, length),
    });
    await s.key("c", "down", { modifiers: ["control"] });
    await s.key("c", "up", { modifiers: ["control"] });
    await screen((rows) => screenText(rows).includes("input-box end"), `the input box of ${tab} did not end`);
    return { plugin, frames, keys, shell, box };
  });
}

/** The group of a process row: host, webContent (the page and document processes and the WebContent services), sidecars or other. */
export function groupOf(role) {
  if (role === "host") return "host";
  if (role.startsWith("page ") || role.startsWith("document ") || role === "webkit webcontent") return "webContent";
  if (role.startsWith("sidecar ")) return "sidecars";
  return "other";
}

/** The CPU milliseconds per action and the footprint bytes of each group of the figures of one interval (intervalFigures), each process once. */
export function groupFigures(figures) {
  const groups = { host: { ms: 0, bytes: 0 }, webContent: { ms: 0, bytes: 0 }, sidecars: { ms: 0, bytes: 0 }, other: { ms: 0, bytes: 0 } };
  const seen = new Set();
  for (const row of figures.rows) {
    if (seen.has(row.pid)) continue;
    seen.add(row.pid);
    const group = groups[groupOf(row.role)];
    group.ms = row.msPerAction === null || group.ms === null ? null : group.ms + row.msPerAction;
    group.bytes = row.bytes === null || group.bytes === null ? null : group.bytes + row.bytes;
  }
  return groups;
}

const value = (number, digits) => (number === null ? "error" : number.toFixed(digits));
const mb = (bytes) => value(bytes === null ? null : bytes / 1048576, 1);

export function formatReport({ plugin, frames, keys, shell, box }) {
  const lines = [`${plugin}: idle over ${frames} display periods, ${keys} keys; CPU ms of host/webContent/sidecars, footprint MB of the same`];
  for (const [name, program] of [["shell", shell], ["box", box]]) {
    for (const { length, idle, keys: typed } of program.inputs) {
      const i = groupFigures(idle);
      const k = groupFigures(typed);
      lines.push(`${name} input ${length}: idle ms/period ${value(i.host.ms, 3)}/${value(i.webContent.ms, 3)}/${value(i.sidecars.ms, 3)}; ` +
        `key ms ${value(k.host.ms, 2)}/${value(k.webContent.ms, 2)}/${value(k.sidecars.ms, 2)} total ${value(typed.totals.total.msPerAction, 2)}; ` +
        `MB ${mb(i.host.bytes)}/${mb(i.webContent.bytes)}/${mb(i.sidecars.bytes)}; ${typed.presented} frames for ${keys} keys; ` +
        `occluded ${idle.occluded.join("/")}; ${idle.load[0] ?? ""} / ${typed.load[0] ?? ""}`);
    }
    for (const paste of program.pastes) {
      const p = groupFigures(paste);
      lines.push(`${name} paste ${paste.length}: ${paste.seconds.toFixed(2)} s, CPU ms ${value(p.host.ms, 1)}/${value(p.webContent.ms, 1)}/${value(p.sidecars.ms, 1)} ` +
        `total ${value(paste.totals.total.msPerAction, 1)}; MB ${mb(p.host.bytes)}/${mb(p.webContent.bytes)}/${mb(p.sidecars.bytes)}; ${paste.load[0] ?? ""}`);
    }
  }
  return lines.join("\n");
}

if (import.meta.main) {
  try {
    const options = parseOptions(process.argv.slice(2));
    const result = await measureInput(options);
    console.log(options.json ? JSON.stringify(result, null, 2) : formatReport(result));
    const intervals = [result.shell, result.box].flatMap(({ inputs, pastes }) => [...inputs.flatMap(({ idle, keys }) => [idle, keys]), ...pastes]);
    const errors = intervals.flatMap(({ errors: found }) => found);
    for (const error of errors) console.error(`error: ${error}`);
    if (errors.length > 0) process.exitCode = 1;
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exitCode = 1;
  }
}
