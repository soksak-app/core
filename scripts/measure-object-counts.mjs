// Measures the object counts of a window of a running application before and after repeated operations (docs/operations/examples.md#page-memory). It sets the trace state of TRACE (scripts/measure-trace.mjs), reads diagnostics.objects of the window after the counts settle,
// runs the list of operations N times, settles after each operation, and reads the counts, the Go runtime figures (the member runtime of the
// Wails and the mygo host) and the footprint of the host process, of the page process and of each document process again. A window whose
// host.window reports pageProcess null has no main page, which is the window of the mygo host: its reply has page null, and the measurement
// reads no page process. The host is the process whose command line has --config-dir DIR, found as `make measure-app-usage` finds it. The measure
// function asserts nothing: it logs one entry per repetition, {repetition, counts, runtime, footprint}, and then one summary per count,
// {count, baseline, values, grows}, where grows is true when the count rises in every repetition after the second. A count that grows is a
// defect for the owning check to judge. With --b3-out FILE, which needs at least 30 repetitions, it writes the B3 output of S3
// (scripts/b3-out.mjs) with the measurements that B3_MEASUREMENTS declares, changedCounts and growingFigures of b3Measurements, and
// the conditions of the window, whose traceState is the diagnostics.performance that TRACE set (b3Output).
// `make measure-object-counts` runs it.
//
//   node scripts/measure-object-counts.mjs --sok PATH --config-dir DIR --trace 0|1 --plugin ID [--plugin ID]... [--repetitions N] [--b3-out FILE]
import { spawn, execFile, execFileSync } from "node:child_process";
import { connect } from "@soksak/client";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { readPolicy } from "@soksak/window-check/log-policy.mjs";
import { b3Conditions, writeB3Out } from "./b3-out.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { parseArgs } from "node:util";
import { PROCESS_TABLE_BYTES, hostProcess, parseProcessTable, requireOcclusion } from "./measure-app-usage.mjs";
import { applyTrace, parseTrace, traceSettings } from "./measure-trace.mjs";

const execFileAsync = promisify(execFile);

/**
 * The operations of one repetition, in order, for the installed surface plugins that the measurement names: one tab of each
 * plugin, then a split with the first plugin, a drag of the divider of such a split, the add menu of a card, the settings
 * window, a plugin apply and a project window. Each is a step of operationSteps, which runs its declared commands.
 */
export function operationsFor(plugins) {
  return [...plugins.map((plugin) => `tab.${plugin}`), "card.split", "divider.drag", "card.menu", "settings.window", "plugins.apply",
    "project.window"];
}

/** The divider drag of a repetition: 40 points along x and back in 200 ms, once (diagnostics.drag of docs/spec/endpoint.md). */
const DRAG = { dx: 40, dy: 0, ms: 200, times: 1 };

/**
 * The steps of the operations of operationsFor. run(args) runs sok with the arguments and returns its reply, request(method, params)
 * calls a method of the endpoint, until(name, predicate) resolves with the first value of the status of the window that satisfies
 * the predicate, and waitFor(check) resolves with the first truthy value of check(), which runs again after each change of the
 * statuses host.window and host.windows. windows are the windows before the first step, and projectRoot is the folder that the
 * project window opens.
 */
export function operationSteps({ window, windows, plugins, run, request, until, waitFor, projectRoot }) {
  // core.grid is a status; its fixed cards are the sidebars, which hold no tab of a plugin card.
  const firstCard = async () => {
    const grid = await run(["status", "core.grid", "--window", window]);
    const card = Array.isArray(grid?.cards) ? grid.cards.find((entry) => !entry.fixed) : undefined;
    if (!card) throw new Error(`core.grid reports no card that is not fixed: ${JSON.stringify(grid?.cards?.map((entry) => entry.id))}`);
    return card.id;
  };
  const split = async (card) => run(["core.card.split", "--window", window, "--card", card, "--side", "right", "--plugin", plugins[0]]);
  const tabSteps = Object.fromEntries(plugins.map((plugin) => [`tab.${plugin}`, async () => {
    const card = await firstCard();
    const { tab } = await run(["core.card.add-tab", "--window", window, "--card", card, "--plugin", plugin]);
    await run(["core.tab.close", "--window", window, "--tab", tab]);
  }]));
  const status = (name) => run(["status", name, "--window", window]);
  return {
    ...tabSteps,
    "card.split": async () => {
      const { card } = await split(await firstCard());
      await run(["core.card.close", "--window", window, "--card", card]);
    },
    // The split card starts at the boundary that it shares with the card it was split from: line c0 of the x axis.
    "divider.drag": async () => {
      const { card } = await split(await firstCard());
      const grid = await status("core.grid");
      const placed = grid?.cards?.find((entry) => entry.id === card);
      if (!placed) throw new Error(`core.grid reports no card ${card} after core.card.split: ${JSON.stringify(grid?.cards?.map((entry) => entry.id))}`);
      // diagnostics.drag is a method of the local endpoint of a diagnostic build, not a declared command, so the client calls it.
      await request("diagnostics.drag", { window, axis: "x", line: placed.c0, ...DRAG });
      await run(["core.card.close", "--window", window, "--card", card]);
    },
    "card.menu": async () => {
      const card = await firstCard();
      await run(["core.card.menu", "--window", window, "--card", card, "--menu", "add"]);
      await until("core.picker", (picker) => picker.open);
      await run(["core.picker.close", "--window", window]);
      await until("core.picker", (picker) => !picker.open);
    },
    "settings.window": async () => {
      await run(["core.settings.open", "--window", window]);
      await until("core.settings-modal", (modal) => modal.open);
      await run(["core.settings.close", "--window", window]);
      await until("core.settings-modal", (modal) => !modal.open);
    },
    "plugins.apply": async () => {
      const before = (await status("core.window.document")).timeOrigin;
      const { reloaded } = await run(["core.plugins.apply", "--window", window]);
      if (reloaded !== true) throw new Error("core.plugins.apply kept a modified tab, so the workbench did not start again");
      // The reply comes before the new start of the workbench, so the next operation waits until the window reports another
      // start of its workbench that is complete, as the preparation of a window check does; a window without a main page
      // starts its workbench again without a new page process.
      await until("core.window.document", (document) => document.timeOrigin !== before && document.readyState === "complete");
    },
    "project.window": async () => {
      const known = new Set(windows.map((entry) => entry.window));
      await run(["core.window.new", "--window", window]);
      const created = await waitFor(async () => (await run(["windows"])).find((entry) => entry.ready && !known.has(entry.window)));
      const project = await run(["core.project.open", "--window", created.window, "--root", projectRoot]);
      if (typeof project.id !== "string") throw new Error("core.project.open reply has no id");
      await run(["core.project.close", "--window", created.window, "--id", project.id]);
      await run(["host.window.close", "--window", created.window]);
      await waitFor(async () => !(await run(["windows"])).some((entry) => entry.window === created.window));
    },
  };
}

/** The baseline reads at most this many times before it fails, so a count that keeps changing ends the measurement. */
const BASELINE_MAX_READINGS = 10;

/** The counts that the member host of every diagnostics.objects reply holds. */
const HOST_COUNTS = ["surfaces", "regions", "documents", "sidecarSessions", "pendingReplies", "eventSubscribers"];

/** The figures of the Go runtime in the member runtime of diagnostics.objects (docs/spec/endpoint.md), which a host without a Go runtime leaves out. */
const RUNTIME_FIGURES = ["heapObjectsBytes", "heapUnusedBytes", "heapFreeBytes", "heapReleasedBytes", "stacksBytes", "metadataOtherBytes",
  "heapGoalBytes", "goroutines"];

/** A count of diagnostics.objects must be a non-negative integer; any other value is reported, not replaced. */
function requireCount(value, name) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`object count ${name} is not a non-negative integer (${JSON.stringify(value)})`);
  return value;
}

/** The members of a diagnostics.objects reply that are not objects of counts: sessions lists what host.sidecarSessions counts, and runtime holds figures. */
const UNCOUNTED_MEMBERS = new Set(["sessions", "runtime"]);

/** The counts that the member page of every reply with a main page holds. */
const PAGE_COUNTS = ["elements", "documents"];

/**
 * Flattens a diagnostics.objects reply into one number per count name. Every object member of the reply outside runtime, documents
 * and sessions is an object of counts, and each of its members is the count `<member>.<name>`, because the S3 judge of B3 compares
 * "every count of diagnostics.objects outside its runtime member", the counts that a host adds among them, as the mygo host adds
 * the counts of its workbench, its native views and its framework callbacks. host holds at least HOST_COUNTS and page at least
 * PAGE_COUNTS; page is null for a window without a main page, which then has no page counts. documents is counted by its entries.
 */
export function countsOf({ host, page, documents, ...added }) {
  if (!host || typeof host !== "object") throw new Error("diagnostics.objects reply has no host object");
  if (page !== null && (!page || typeof page !== "object")) throw new Error("diagnostics.objects reply has no page object and no page null");
  if (!Array.isArray(documents)) throw new Error("diagnostics.objects reply has no documents array");
  const counts = {};
  const count = (member, value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`diagnostics.objects member ${member} is not an object of counts (${JSON.stringify(value)})`);
    }
    for (const [name, number] of Object.entries(value)) counts[`${member}.${name}`] = requireCount(number, `${member}.${name}`);
  };
  for (const name of HOST_COUNTS) requireCount(host[name], `host.${name}`);
  count("host", host);
  if (page !== null) {
    for (const name of PAGE_COUNTS) requireCount(page[name], `page.${name}`);
    count("page", page);
  }
  for (const [member, value] of Object.entries(added)) {
    if (!UNCOUNTED_MEMBERS.has(member)) count(member, value);
  }
  counts["documents.regions"] = documents.length;
  counts["documents.elements"] = documents.reduce((sum, document) => sum + requireCount(document.elements, "documents[].elements"), 0);
  counts["documents.documents"] = documents.reduce((sum, document) => sum + requireCount(document.documents, "documents[].documents"), 0);
  return counts;
}

/** The Go runtime figures of a diagnostics.objects reply, or null for a reply without runtime, which the Tauri host gives. */
export function runtimeOf({ runtime }) {
  if (runtime === undefined) return null;
  if (!runtime || typeof runtime !== "object") throw new Error(`diagnostics.objects runtime is not an object (${JSON.stringify(runtime)})`);
  return Object.fromEntries(RUNTIME_FIGURES.map((name) => {
    const value = runtime[name];
    if (!Number.isInteger(value) || value < 0) throw new Error(`runtime figure ${name} is not a non-negative integer (${JSON.stringify(value)})`);
    return [name, value];
  }));
}

function sameCounts(a, b) {
  return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((name) => a[name] === b[name]);
}

/** Reads the replies after each settle until two consecutive readings have equal counts, and returns the last reply. */
async function settledReply(objects, settle) {
  const readings = [];
  for (let attempt = 1; attempt <= BASELINE_MAX_READINGS; attempt++) {
    await settle();
    const reply = await objects();
    const counts = countsOf(reply);
    const previous = readings.at(-1);
    if (previous && sameCounts(previous, counts)) return reply;
    readings.push(counts);
  }
  const [before, last] = readings.slice(-2);
  throw new Error(`object counts did not settle within ${BASELINE_MAX_READINGS} readings; the last two differ: ${JSON.stringify(before)} and ${JSON.stringify(last)}`);
}

/**
 * The footprint of the host process, of the page process and of each document process, the latter two read from host.window. A
 * window whose host.window reports pageProcess null has no page process, and its reply must report page null, as a window with a
 * page process must report its page.
 */
async function footprintOf(status, footprint, host, reply) {
  const reading = await status();
  // A covered window measures another state, so every reading requires a window that is not covered.
  requireOcclusion(null, [reading]);
  const { pageProcess, documents } = reading;
  if (pageProcess !== null && (!Number.isInteger(pageProcess) || pageProcess <= 0)) throw new Error(`the window has no page process (${pageProcess})`);
  if ((pageProcess === null) !== (reply.page === null)) {
    throw new Error(`diagnostics.objects reports the page ${JSON.stringify(reply.page)} while host.window reports pageProcess ${pageProcess}`);
  }
  if (!Array.isArray(documents)) throw new Error("host.window reply has no documents array");
  return {
    host: { pid: host, bytes: footprint(host) },
    page: pageProcess === null ? null : { pid: pageProcess, bytes: footprint(pageProcess) },
    documents: documents.map((document) => {
      if (!Number.isInteger(document.process) || document.process <= 0) {
        throw new Error(`document ${document.surface}/${document.document} has no process (${JSON.stringify(document.process)})`);
      }
      return { surface: document.surface, document: document.document, pid: document.process, bytes: footprint(document.process) };
    }),
  };
}

/**
 * Measures the baseline and the repetitions. objects() reads diagnostics.objects of the window, status() reads host.window, host is the
 * process id of the host, footprint(pid) returns the bytes of a process, operate(name) runs one operation, settle() waits for the status
 * notification that ends the last operation, and log(entry) receives each entry. Returns the summary of each count, keyed by its name.
 */
export async function measure({ objects, status, host, footprint, operate, settle, repetitions, log, operations }) {
  if (!Array.isArray(operations) || operations.length === 0) throw new Error("measure needs the operations of a repetition");
  const entry = async (repetition, reply) => {
    const counts = countsOf(reply);
    log({ repetition, counts, runtime: runtimeOf(reply), footprint: await footprintOf(status, footprint, host, reply) });
    return counts;
  };
  const baseline = await entry(0, await settledReply(objects, settle));
  const rows = [baseline];
  for (let repetition = 1; repetition <= repetitions; repetition++) {
    for (const name of operations) {
      await operate(name);
      await settle();
    }
    rows.push(await entry(repetition, await objects()));
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

/** The keys of the B3 output of object-counts (scripts/b3-out.mjs), which b3Measurements gives. */
export const B3_MEASUREMENTS = Object.freeze(["changedCounts", "growingFigures"]);

/** The repetitions that S3 of B3 judges: every repetition from the second on against the first, and 21 to 30 against 11 to 20. */
const B3_REPETITIONS = 30;

/** The figures that S3 judges for growth: the host footprint and each Go runtime figure except heapReleasedBytes, which counts memory returned to the system. */
function growthFigures(entry) {
  const figures = { "footprint.host": entry.footprint.host.bytes };
  if (entry.runtime !== null) {
    for (const name of RUNTIME_FIGURES) if (name !== "heapReleasedBytes") figures[`runtime.${name}`] = entry.runtime[name];
  }
  return figures;
}

/**
 * The B3 measurements of S3 from the repetition entries of measure (docs/spec/hosts.md, G3): changedCounts is the number of counts
 * whose value after some repetition from the second on differs from their value after the first repetition (a count that a later
 * repetition lacks or adds has changed), and growingFigures is the number of figures of growthFigures whose lowest value over
 * repetitions 21 to 30 is above their highest value over repetitions 11 to 20.
 */
export function b3Measurements(entries) {
  const repetitions = entries.filter((entry) => entry.repetition >= 1);
  const last = repetitions.at(-1)?.repetition ?? 0;
  if (last < B3_REPETITIONS) throw new Error(`the B3 measurements of object-counts need the repetitions 1 to ${B3_REPETITIONS}, not 1 to ${last}`);
  const [first, ...later] = repetitions;
  const names = new Set(repetitions.flatMap((entry) => Object.keys(entry.counts)));
  const changedCounts = [...names].filter((name) => later.some((entry) => entry.counts[name] !== first.counts[name])).length;
  const series = (from, to, name) => repetitions.filter((entry) => entry.repetition >= from && entry.repetition <= to).map((entry) => {
    const value = growthFigures(entry)[name];
    if (value === undefined) throw new Error(`repetition ${entry.repetition} has no figure ${name}`);
    return value;
  });
  const growingFigures = Object.keys(growthFigures(first))
    .filter((name) => Math.min(...series(21, 30, name)) > Math.max(...series(11, 20, name))).length;
  return { changedCounts, growingFigures };
}

/**
 * The B3 output of a run of object-counts from the repetition entries of measure, the host.window reply (status) of the measured
 * window (window), the trace state that TRACE set (trace) and the classes of the policy in force (policy): the measurements of
 * b3Measurements and the conditions of b3Conditions, whose traceState is the diagnostics.performance of that trace state.
 */
export function b3Output({ entries, window, status, trace, policy }) {
  const conditions = b3Conditions({ windows: [{ ...status, window }], performance: traceSettings(trace)["diagnostics.performance"], policy });
  return { measurements: b3Measurements(entries), conditions };
}

/** The command line options. */
export function parseOptions(args) {
  const { values } = parseArgs({
    args, strict: true,
    options: {
      sok: { type: "string" }, "config-dir": { type: "string" }, trace: { type: "string" }, repetitions: { type: "string", default: "20" },
      plugin: { type: "string", multiple: true, default: [] }, "b3-out": { type: "string" },
    },
  });
  const trace = parseTrace(values.trace);
  const repetitions = Number(values.repetitions);
  if (!Number.isInteger(repetitions) || repetitions < 1) throw new Error("--repetitions must be a positive integer");
  if (!values.sok || !values["config-dir"]) throw new Error("required options: --sok PATH --config-dir DIR");
  // The plugins are those of the measured application, which core does not know, so the measurement names them.
  if (values.plugin.length === 0) throw new Error("required option: --plugin ID, once for each surface plugin whose tab the measurement opens");
  const empty = values.plugin.find((plugin) => plugin.trim() === "");
  if (empty !== undefined) throw new Error(`--plugin must name a plugin id (${JSON.stringify(empty)})`);
  const b3Out = values["b3-out"] ?? null;
  if (b3Out === "") throw new Error("--b3-out must name a file");
  if (b3Out !== null && repetitions < B3_REPETITIONS) throw new Error(`--b3-out needs at least ${B3_REPETITIONS} repetitions, not ${repetitions}`);
  return { repetitions, sok: values.sok, configDir: values["config-dir"], trace, plugins: values.plugin, b3Out };
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
  /** Resolves with the first value of check() that is truthy; check runs again after each change that arrives after it started. */
  const waitFor = async (check) => {
    for (;;) {
      const next = nextChange();
      const value = await check();
      if (value) return value;
      await next;
    }
  };

  const run = (args) => execFileAsync(sok, [...args, "--config-dir", configDir], { encoding: "utf8" }).then(({ stdout }) => JSON.parse(stdout));
  const runSync = (args) => JSON.parse(execFileSync(sok, [...args, "--config-dir", configDir], { encoding: "utf8" }));

  const windows = runSync(["windows"]);
  if (!Array.isArray(windows) || windows.length !== 1) {
    throw new Error(`object-counts measures one window; the application has ${Array.isArray(windows) ? windows.length : "no"} windows`);
  }
  const window = windows[0].window;
  // The host is found before the trace state changes anything, so an application without a host process fails first.
  const { pid: host } = hostProcess(parseProcessTable(execFileSync("ps", ["-axww", "-o", "pid=,command="], { encoding: "utf8", maxBuffer: PROCESS_TABLE_BYTES })),
    configDir, realpathSync(configDir));
  await applyTrace((command, params) => run([command, "--params", JSON.stringify(params)]), options.trace, configDir);
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

  const projectRoot = mkdtempSync(join(tmpdir(), "object-counts-project-"));
  const client = await connect({ configDir });
  const operateSteps = operationSteps({
    window, windows, plugins: options.plugins, run, projectRoot, waitFor,
    // diagnostics.objects and diagnostics.drag are methods of the local endpoint of a diagnostic build, not declared commands, so the
    // client calls them.
    request: (method, params) => client.request(method, params),
    until: (name, predicate) => client.watch(window, name, predicate, { timeout: STEP_LIMIT_MS }),
  });
  const entries = [];
  try {
    await measure({
      objects: () => step("diagnostics.objects", () => client.request("diagnostics.objects", { window })),
      status: () => step("host.window", async () => ({ ...await run(["status", "host.window", "--window", window]), window })),
      host,
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
      operations: operationsFor(options.plugins),
      log: (entry) => {
        if (entry.repetition !== undefined) entries.push(entry);
        console.log(JSON.stringify(entry));
      },
    });
    if (options.b3Out !== null) {
      writeB3Out(options.b3Out, b3Output({ entries, window, status: await run(["status", "host.window", "--window", window]),
        trace: options.trace, policy: readPolicy(configDir).classes }));
    }
  } finally {
    client.close();
    for (const child of watches) child.kill();
    rmSync(projectRoot, { recursive: true, force: true });
  }
}
