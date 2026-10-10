// Measures the memory of the main page process of a running application at start, after idle, and after reload.
//
// Reads the host.window state (pageProcess) of the window with the sok of the application bundle and runs host.window.reload, so a release build is also
// measured. The memory is the physical footprint that the operating system footprint reports. The idle interval is a time that waits for no event, so it is
// set by duration. For each step it prints {phase, elapsedMs, pageProcess, footprint} as one JSON line and makes no judgment. Reload
// opens the document in a new page process (docs/spec/native-host.md), so the last step also records whether the process of the start still exists
// (startProcessAlive).
// `make page-memory` runs it.
//
//   node scripts/measure-page-memory.mjs --sok PATH --config-dir DIR [--idle-minutes N] [--reloads N]
import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * Measures the steps in sequence. status() is the host.window state, reload() is one reload, footprint(pid) is the number of bytes, and wait(ms) is
 * the idle interval. alive(pid) tells whether that process still exists.
 */
export async function measure({ status, reload, footprint, alive, wait, idleMs, reloads, log, now = Date.now }) {
  const started = now();
  const record = async (phase, extra = () => ({})) => {
    const { pageProcess } = await status();
    if (!Number.isInteger(pageProcess) || pageProcess <= 0) throw new Error(`${phase}: the window has no page process (${pageProcess})`);
    const entry = { phase, elapsedMs: now() - started, pageProcess, footprint: footprint(pageProcess), ...extra() };
    log(entry);
    return entry;
  };
  const start = await record("start");
  await wait(idleMs);
  await record("idle");
  for (let i = 0; i < reloads; i++) await reload();
  await record("reloads", () => ({ startProcessAlive: alive(start.pageProcess) }));
}

/** The number of bytes in the footprint output. */
export function parseFootprint(text) {
  const match = text.match(/Footprint: (\d+) B/);
  if (!match) throw new Error(`footprint reported no byte count: ${text.slice(0, 200)}`);
  return Number(match[1]);
}

/** The command line options. */
export function parseOptions(args) {
  const options = { idleMinutes: 60, reloads: 20 };
  for (let index = 0; index < args.length; index += 2) {
    const [name, value] = [args[index], args[index + 1]];
    if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value`);
    if (name === "--sok") options.sok = value;
    else if (name === "--config-dir") options.configDir = value;
    else if (name === "--idle-minutes" || name === "--reloads") {
      const number = Number(value);
      if (!Number.isInteger(number) || number < 0) throw new Error(`${name} must be a non-negative integer`);
      options[name === "--reloads" ? "reloads" : "idleMinutes"] = number;
    } else throw new Error(`unknown option: ${name}`);
  }
  if (!options.sok || !options.configDir) throw new Error("required options: --sok PATH --config-dir DIR");
  return options;
}

if (import.meta.main) {
  const options = parseOptions(process.argv.slice(2));
  const sok = (...args) => execFileSync(options.sok, [...args, "--config-dir", options.configDir], { encoding: "utf8" });
  await measure({
    status: async () => JSON.parse(sok("status", "host.window")),
    reload: async () => { sok("host.window.reload"); },
    footprint: (pid) => parseFootprint(execFileSync("footprint", ["-p", String(pid), "-f", "bytes"], { encoding: "utf8" })),
    alive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        if (error.code === "ESRCH") return false;
        throw error;
      }
    },
    wait: (ms) => sleep(ms),
    idleMs: options.idleMinutes * 60_000,
    reloads: options.reloads,
    log: (entry) => console.log(JSON.stringify(entry)),
  });
}
