// Measures what the host calls of the main page leave in the page process of a running diagnostic build.
//
// For each round it collects the JavaScript objects of the page (diagnostics.page.collect) and reads the footprint of the page process, has the page
// send N host calls (diagnostics.page.calls, in requests of at most 50 calls), reads the footprint again, collects, and reads it a third time. The footprint is the physical footprint
// that the operating system footprint reports, with its WebKit malloc category. For each step it prints one JSON line
// {round, phase, pageProcess, footprint, webkitMalloc, ms?} and after the rounds one summary {calls, rounds, perCall: {beforeCollect, afterCollect}} with the
// mean growth of WebKit malloc in bytes per call before and after the collection. With --idle-minutes M the page sends no calls: each round waits M minutes
// without input instead (phase "idle"), and the summary {idleMinutes, rounds, perMinute: {beforeCollect, afterCollect}} is the mean growth per minute,
// which measures what the page allocates on its own while idle. The idle interval waits for no event, so it is set by duration. The JavaScript heap of WebKit is allocated in WebKit malloc, while the
// total footprint also moves with graphics memory of the window that the calls do not cause. It measures the first ready window and makes no judgment. `make host-calls` runs it.
//
//   node scripts/measure-host-calls.mjs --sok PATH --config-dir DIR [--calls N | --idle-minutes M] [--rounds N]
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { connect } from "@soksak/client";

/** The most calls of one diagnostics.page.calls request (docs/spec/endpoint.md); a round sends its calls in requests of this size. */
export const BATCH = 50;

/**
 * Measures the rounds. status() is the host.window state, collect() and calls(count) are the diagnostic methods, and footprint(pid) returns
 * {footprint, webkitMalloc, reclaimable} in bytes. With idleMs and wait(ms) a round waits idleMs instead of sending calls.
 */
export async function measure({ status, collect, calls, footprint, count, rounds, log, idleMs, wait }) {
  const read = async (round, phase, extra = {}) => {
    const { pageProcess } = await status();
    if (!Number.isInteger(pageProcess) || pageProcess <= 0) throw new Error(`round ${round} ${phase}: the window has no page process (${pageProcess})`);
    const entry = { round, phase, pageProcess, ...footprint(pageProcess), ...extra };
    log(entry);
    return entry;
  };
  const growth = { beforeCollect: 0, afterCollect: 0 };
  for (let round = 1; round <= rounds; round++) {
    await collect();
    const base = await read(round, "base");
    let called;
    if (idleMs) {
      await wait(idleMs);
      called = await read(round, "idle");
    } else {
      let ms = 0;
      for (let sent = 0; sent < count; sent += BATCH) {
        const batch = Math.min(BATCH, count - sent);
        const reply = await calls(batch);
        if (reply?.count !== batch) throw new Error(`round ${round}: the page answered ${JSON.stringify(reply)} for ${batch} calls`);
        ms += reply.ms;
      }
      called = await read(round, "calls", { ms });
    }
    await collect();
    const collected = await read(round, "collected");
    if (called.pageProcess !== base.pageProcess || collected.pageProcess !== base.pageProcess) {
      throw new Error(`round ${round}: the page process changed from ${base.pageProcess} during the round`);
    }
    growth.beforeCollect += called.webkitMalloc - base.webkitMalloc;
    growth.afterCollect += collected.webkitMalloc - base.webkitMalloc;
  }
  const per = (bytes, unit) => Math.round(bytes / (rounds * unit));
  const summary = idleMs
    ? { idleMinutes: idleMs / 60_000, rounds, perMinute: { beforeCollect: per(growth.beforeCollect, idleMs / 60_000), afterCollect: per(growth.afterCollect, idleMs / 60_000) } }
    : { calls: count, rounds, perCall: { beforeCollect: per(growth.beforeCollect, count), afterCollect: per(growth.afterCollect, count) } };
  log(summary);
  return summary;
}

/** The total footprint and the dirty and reclaimable bytes of the WebKit malloc category, of the output of `footprint -p PID -f bytes`. */
export function parseFootprint(text) {
  const total = text.match(/Footprint: (\d+) B/);
  if (!total) throw new Error(`footprint reported no byte count: ${text.slice(0, 200)}`);
  const malloc = text.match(/^\s*(\d+) B\s+\d+ B\s+(\d+) B\s+\d+\s+WebKit malloc\s*$/m);
  if (!malloc) throw new Error(`footprint reported no WebKit malloc category: ${text.slice(0, 200)}`);
  return { footprint: Number(total[1]), webkitMalloc: Number(malloc[1]), reclaimable: Number(malloc[2]) };
}

/** The command line options. */
export function parseOptions(args) {
  const { values } = parseArgs({
    args, strict: true,
    options: { sok: { type: "string" }, "config-dir": { type: "string" }, calls: { type: "string", default: "1000" }, rounds: { type: "string", default: "5" }, "idle-minutes": { type: "string", default: "0" } },
  });
  const positive = (name) => {
    const number = Number(values[name]);
    if (!Number.isInteger(number) || number < 1) throw new Error(`--${name} must be a positive integer`);
    return number;
  };
  if (!values.sok || !values["config-dir"]) throw new Error("required options: --sok PATH --config-dir DIR");
  const idleMinutes = Number(values["idle-minutes"]);
  if (!Number.isInteger(idleMinutes) || idleMinutes < 0) throw new Error("--idle-minutes must be a non-negative integer");
  return { calls: positive("calls"), rounds: positive("rounds"), idleMinutes, sok: values.sok, configDir: values["config-dir"] };
}

if (import.meta.main) {
  const options = parseOptions(process.argv.slice(2));
  const sok = (...args) => execFileSync(options.sok, [...args, "--config-dir", options.configDir], { encoding: "utf8" });
  const windows = JSON.parse(sok("windows"));
  const window = windows.find((entry) => entry.ready)?.window;
  if (!window) throw new Error(`no window is ready: ${JSON.stringify(windows)}`);
  const client = await connect({ configDir: options.configDir });
  try {
    await measure({
      status: async () => JSON.parse(sok("status", "host.window", "--window", window)),
      // The diagnostic methods are methods of the local endpoint of a diagnostic build, not declared commands, so the client calls them.
      collect: () => client.request("diagnostics.page.collect", { window }),
      calls: (count) => client.request("diagnostics.page.calls", { window, count }),
      footprint: (pid) => parseFootprint(execFileSync("footprint", ["-p", String(pid), "-f", "bytes"], { encoding: "utf8" })),
      count: options.calls,
      rounds: options.rounds,
      idleMs: options.idleMinutes * 60_000,
      wait: (ms) => sleep(ms),
      log: (entry) => console.log(JSON.stringify(entry)),
    });
  } finally {
    client.close();
  }
}
