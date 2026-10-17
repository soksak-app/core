// Measures the object counts of a window of a running application before and after repeated operations (docs/plans/document-streams-and-memory.md,
// Main application). It reads diagnostics.objects of the window after the counts settle, runs the fixed list of operations N times, settles after
// each operation, and reads the counts and the footprint of each process again. The measure function asserts nothing: it logs one entry per
// repetition, {repetition, counts, footprint}, and then one summary per count, {count, baseline, values, grows}, where grows is true when the count
// rises in every repetition after the second. A count that grows is a defect for the owning check to judge.
// `make object-counts` runs it.
//
//   node scripts/measure-object-counts.mjs --sok PATH --config-dir DIR [--repetitions N]
import { spawn, execFile, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { parseArgs } from "node:util";

const execFileAsync = promisify(execFile);

/** The operations of one repetition, in order. Each is a step of the CLI part, which runs its declared commands (see operate). */
export const OPERATIONS = ["tab.terminal", "tab.browser", "card.split", "plugins.apply", "project.window"];

/** The baseline reads at most this many times before it fails, so a count that keeps changing ends the measurement. */
const BASELINE_MAX_READINGS = 10;

/** The host counts of diagnostics.objects, in the order of the report. */
const HOST_COUNTS = ["surfaces", "regions", "documents", "sidecarSessions", "pendingReplies", "eventSubscribers"];

/** A count of diagnostics.objects must be a non-negative integer; any other value is reported, not replaced. */
function requireCount(value, name) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`object count ${name} is not a non-negative integer (${JSON.stringify(value)})`);
  return value;
}

/** Flattens a diagnostics.objects reply into one number per count name. */
export function countsOf({ host, page, documents }) {
  if (!host || typeof host !== "object") throw new Error("diagnostics.objects reply has no host object");
  if (!page || typeof page !== "object") throw new Error("diagnostics.objects reply has no page object");
  if (!Array.isArray(documents)) throw new Error("diagnostics.objects reply has no documents array");
  const counts = {};
  for (const name of HOST_COUNTS) counts[`host.${name}`] = requireCount(host[name], `host.${name}`);
  counts["page.elements"] = requireCount(page.elements, "page.elements");
  counts["page.documents"] = requireCount(page.documents, "page.documents");
  counts["documents.regions"] = documents.length;
  counts["documents.elements"] = documents.reduce((sum, document) => sum + requireCount(document.elements, "documents[].elements"), 0);
  counts["documents.documents"] = documents.reduce((sum, document) => sum + requireCount(document.documents, "documents[].documents"), 0);
  return counts;
}

function sameCounts(a, b) {
  return Object.keys(a).every((name) => a[name] === b[name]);
}

/** Reads the counts after each settle until two consecutive readings are equal, and returns the equal reading. */
async function settledCounts(objects, settle) {
  const readings = [];
  for (let attempt = 1; attempt <= BASELINE_MAX_READINGS; attempt++) {
    await settle();
    const counts = countsOf(await objects());
    const previous = readings.at(-1);
    if (previous && sameCounts(previous, counts)) return counts;
    readings.push(counts);
  }
  const [before, last] = readings.slice(-2);
  throw new Error(`object counts did not settle within ${BASELINE_MAX_READINGS} readings; the last two differ: ${JSON.stringify(before)} and ${JSON.stringify(last)}`);
}

/** The footprint of the page process and of each document process, read from host.window. */
async function footprintOf(status, footprint) {
  const { pageProcess, documents } = await status();
  if (!Number.isInteger(pageProcess) || pageProcess <= 0) throw new Error(`the window has no page process (${pageProcess})`);
  if (!Array.isArray(documents)) throw new Error("host.window reply has no documents array");
  return {
    page: { pid: pageProcess, bytes: footprint(pageProcess) },
    documents: documents.map((document) => {
      if (!Number.isInteger(document.process) || document.process <= 0) {
        throw new Error(`document ${document.surface}/${document.document} has no process (${JSON.stringify(document.process)})`);
      }
      return { surface: document.surface, document: document.document, pid: document.process, bytes: footprint(document.process) };
    }),
  };
}

/**
 * Measures the baseline and the repetitions. objects() reads diagnostics.objects of the window, status() reads host.window, footprint(pid) returns
 * the bytes of a process, operate(name) runs one operation, settle() waits for the status notification that ends the last operation, and log(entry)
 * receives each entry. Returns the summary of each count, keyed by its name.
 */
export async function measure({ objects, status, footprint, operate, settle, repetitions, log, operations = OPERATIONS }) {
  const baseline = await settledCounts(objects, settle);
  log({ repetition: 0, counts: baseline, footprint: await footprintOf(status, footprint) });
  const rows = [baseline];
  for (let repetition = 1; repetition <= repetitions; repetition++) {
    for (const name of operations) {
      await operate(name);
      await settle();
    }
    const counts = countsOf(await objects());
    log({ repetition, counts, footprint: await footprintOf(status, footprint) });
    rows.push(counts);
  }
  const summary = {};
  for (const name of Object.keys(baseline)) {
    const series = rows.map((counts) => counts[name]);
    // Rises in every repetition after the second: series[3] > series[2], ..., series[N] > series[N-1].
    const grows = repetitions >= 3 && series.slice(3).every((value, index) => value > series[index + 2]);
    summary[name] = { baseline: series[0], values: series.slice(1), grows };
    log({ count: name, ...summary[name] });
  }
  return summary;
}

/** The command line options. */
export function parseOptions(args) {
  const { values } = parseArgs({
    args, strict: true,
    options: { sok: { type: "string" }, "config-dir": { type: "string" }, repetitions: { type: "string", default: "20" } },
  });
  const repetitions = Number(values.repetitions);
  if (!Number.isInteger(repetitions) || repetitions < 1) throw new Error("--repetitions must be a positive integer");
  if (!values.sok || !values["config-dir"]) throw new Error("required options: --sok PATH --config-dir DIR");
  return { repetitions, sok: values.sok, configDir: values["config-dir"] };
}

const STEP_LIMIT_MS = 60_000;

if (import.meta.main) {
  const options = parseOptions(process.argv.slice(2));
  const { sok, configDir } = options;
  const log = (line) => console.error(line);

  // Notifications of the watched statuses: the count rises with each change after the first value of a watch.
  const changes = { count: 0, waiters: [] };
  const notify = () => {
    changes.count += 1;
    for (const waiter of changes.waiters.splice(0)) waiter();
  };
  const nextChange = () => new Promise((resolve) => changes.waiters.push(resolve));
  /** Resolves with the first value of check() that is truthy; check runs again after each change. */
  const waitFor = async (check) => {
    for (;;) {
      const value = check();
      if (value) return value;
      await nextChange();
    }
  };

  const run = (args) => execFileAsync(sok, [...args, "--config-dir", configDir], { encoding: "utf8" }).then(({ stdout }) => JSON.parse(stdout));
  const runSync = (args) => JSON.parse(execFileSync(sok, [...args, "--config-dir", configDir], { encoding: "utf8" }));

  const windows = runSync(["windows"]);
  if (!Array.isArray(windows) || windows.length !== 1) {
    throw new Error(`object-counts measures one window; the application has ${Array.isArray(windows) ? windows.length : "no"} windows`);
  }
  const window = windows[0].window;
  const watches = ["host.window", "host.windows"].map((name) => {
    const child = spawn(sok, ["status", name, "--window", window, "--watch", "--config-dir", configDir], { stdio: ["ignore", "pipe", "pipe"] });
    let first = true;
    createInterface({ input: child.stdout }).on("line", () => {
      if (first) first = false;
      else notify();
    });
    return child;
  });

  let mark = null;
  let lastStep = "none";
  const measuredState = () => JSON.stringify({ lastStep, notifications: changes.count, pendingSince: mark });

  const step = async (label, work) => {
    lastStep = label;
    log(`start ${label}`);
    const started = Date.now();
    let timer;
    const limit = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} did not finish within ${STEP_LIMIT_MS / 1000}s; measured state: ${measuredState()}`)), STEP_LIMIT_MS);
    });
    try {
      const result = await Promise.race([work(), limit]);
      log(`end ${label} ${Date.now() - started}ms`);
      return result;
    } catch (error) {
      log(`fail ${label} ${Date.now() - started}ms`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };

  const firstCard = async () => {
    const { cards } = await run(["core.grid", "--window", window]);
    if (!Array.isArray(cards) || cards.length === 0) throw new Error("core.grid reports no card");
    return cards[0].id;
  };

  const projectRoot = mkdtempSync(join(tmpdir(), "object-counts-project-"));
  const operateSteps = {
    "tab.terminal": async () => {
      const card = await firstCard();
      const { tab } = await run(["core.card.add-tab", "--window", window, "--card", card, "--plugin", "terminal"]);
      await run(["core.tab.close", "--window", window, "--tab", tab]);
    },
    "tab.browser": async () => {
      const card = await firstCard();
      const { tab } = await run(["core.card.add-tab", "--window", window, "--card", card, "--plugin", "browser"]);
      await run(["core.tab.close", "--window", window, "--tab", tab]);
    },
    "card.split": async () => {
      const card = await firstCard();
      const split = await run(["core.card.split", "--window", window, "--card", card, "--side", "right", "--plugin", "terminal"]);
      await run(["core.card.close", "--window", window, "--card", split.card]);
    },
    "plugins.apply": async () => {
      const { reloaded } = await run(["core.plugins.apply", "--window", window]);
      if (reloaded !== true) throw new Error("core.plugins.apply kept a modified tab, so the page did not reload");
    },
    "project.window": async () => {
      const known = new Set(windows.map((entry) => entry.window));
      await run(["core.window.new", "--window", window]);
      const created = await waitFor(() => runSync(["windows"]).find((entry) => entry.ready && !known.has(entry.window)));
      const project = await run(["core.project.open", "--window", created.window, "--root", projectRoot]);
      if (typeof project.id !== "string") throw new Error("core.project.open reply has no id");
      await run(["core.project.close", "--window", created.window, "--id", project.id]);
      await run(["host.window.close", "--window", created.window]);
      await waitFor(() => !runSync(["windows"]).some((entry) => entry.window === created.window));
    },
  };

  try {
    await measure({
      objects: () => step("diagnostics.objects", () => run(["diagnostics.objects", "--window", window])),
      status: () => step("host.window", () => run(["status", "host.window", "--window", window])),
      footprint: (pid) => {
        const text = execFileSync("footprint", ["-p", String(pid), "-f", "bytes"], { encoding: "utf8" });
        const match = text.match(/Footprint: (\d+) B/);
        if (!match) throw new Error(`footprint reported no byte count: ${text.slice(0, 200)}`);
        return Number(match[1]);
      },
      operate: (name) => {
        if (mark === null) mark = changes.count;
        return step(`operate ${name}`, operateSteps[name]);
      },
      settle: async () => {
        if (mark === null) return;
        const since = mark;
        await step(`settle after ${lastStep}`, () => waitFor(() => changes.count > since));
        mark = null;
      },
      repetitions: options.repetitions,
      log: (entry) => console.log(JSON.stringify(entry)),
    });
  } finally {
    for (const child of watches) child.kill();
    rmSync(projectRoot, { recursive: true, force: true });
  }
}
