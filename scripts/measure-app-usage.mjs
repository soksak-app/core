// Reports the CPU and memory of the running applications of the given data folders, by process (docs/operations/examples.md).
// The host is the process whose command line has --config-dir DIR. The sidecars are the processes whose executable is under DIR/sidecars/.
// The page and document processes come from sok windows and from sok status host.window of each window. The WebKit GPU and networking processes
// (pgrep -f com.apple.WebKit.(GPU|Networking)) belong to an application when lsof of their networking process lists a path under DIR; the GPU
// process of that application is the one that started in the same second as the networking process (ps lstart). A WebKit process that no
// application claims is printed as unattributed. The memory of a process is its phys_footprint (footprint -p PID -f bytes). Its CPU share is the
// CPU time that ps reports, read at two points INTERVAL seconds apart. Every error is printed to stderr with the process or window it concerns,
// and the exit status is 1 when an error occurred. `make app-usage` runs it.
//
//   node scripts/measure-app-usage.mjs --sok PATH --config-dir DIR [--config-dir DIR ...] [--interval SECONDS] [--json]
import { execFileSync, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, isAbsolute, posix } from "node:path";
import { parseArgs } from "node:util";

/** Executables of the tools that run this measurement; their command lines name the data folder, but they are not the application. */
const TOOL_EXECUTABLES = new Set(["node", "sh", "bash", "zsh", "make", "sok"]);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Parses a CPU time of ps, [[dd-]hh:]mm:ss.ss, into seconds. */
export function parseCpuTime(text) {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d{2}\.\d{2})$/.exec(text);
  if (!match) throw new Error(`cpu time "${text}" is not in the [[dd-]hh:]mm:ss.ss format`);
  const [, days, hours, minutes, seconds] = match;
  if (Number(seconds) >= 60) throw new Error(`cpu time "${text}" has seconds of 60 or more`);
  if (hours !== undefined && Number(minutes) >= 60) throw new Error(`cpu time "${text}" has minutes of 60 or more`);
  if (days !== undefined && Number(hours) >= 24) throw new Error(`cpu time "${text}" has hours of 24 or more`);
  return Number(days ?? 0) * 86400 + Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds);
}

/** Reads the phys_footprint of the output of footprint -f bytes, in bytes. The peak and the summary line are not the footprint. */
export function parseFootprint(text) {
  const match = /^\s*phys_footprint: (\d+) B$/m.exec(text);
  if (!match) throw new Error("footprint output has no phys_footprint line");
  return Number(match[1]);
}

/** The CPU share of a process over an interval: the CPU seconds it used divided by the interval, in percent. */
export function cpuPercent(before, after, intervalSeconds) {
  if (!(intervalSeconds > 0)) throw new Error(`interval must be a positive number of seconds (${intervalSeconds})`);
  if (after < before) throw new Error(`cpu time decreased from ${before} to ${after}`);
  return ((after - before) / intervalSeconds) * 100;
}

/** Parses the rows of ps -axo pid=,command= into { pid, command }. */
export function parseProcessTable(text) {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (!match) throw new Error(`process row "${line}" has no pid`);
      return { pid: Number(match[1]), command: match[2] };
    });
}

/** Parses the rows of ps -axo pid=,time= into a map from pid to CPU seconds. */
export function parseCpuSamples(text) {
  const samples = new Map();
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const match = /^\s*(\d+)\s+(\S+)\s*$/.exec(line);
    if (!match) throw new Error(`cpu sample row "${line}" has no pid and time`);
    samples.set(Number(match[1]), parseCpuTime(match[2]));
  }
  return samples;
}

/** The lexical form of a path: doubled and trailing slashes removed. A launch command line can carry a doubled slash that the path does not need. */
function lexicalPath(path) {
  const normalized = posix.normalize(path);
  return normalized.length > 1 && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

/** The command line with its doubled slashes removed, so that it compares with lexicalPath. */
function lexicalCommand(command) {
  return command.replace(/\/{2,}/g, "/");
}

function hasConfigDirArgument(command, configDir) {
  const argument = `--config-dir ${lexicalPath(configDir)}`;
  const line = lexicalCommand(command);
  const index = line.indexOf(argument);
  return index !== -1 && (index + argument.length === line.length || line[index + argument.length] === " ");
}

/** The sidecar directory prefixes of a data folder. A process can carry the path as given or the real path of a symbolic link. */
function sidecarPrefixes(configDir, realPath) {
  return [...new Set([configDir, realPath].map((dir) => `${lexicalPath(dir)}/sidecars/`))];
}

function sidecarPrefixOf(command, configDir, realPath) {
  const line = lexicalCommand(command);
  return sidecarPrefixes(configDir, realPath).find((prefix) => line.startsWith(prefix));
}

function isTool(command) {
  return TOOL_EXECUTABLES.has(basename(command.split(" ")[0]));
}

/** The host process of a data folder: the one application process whose command line has --config-dir DIR. */
export function hostProcess(table, configDir, realPath = configDir) {
  const hosts = table.filter(
    ({ command }) =>
      !isTool(command) &&
      [configDir, realPath].some((dir) => hasConfigDirArgument(command, dir)) &&
      sidecarPrefixOf(command, configDir, realPath) === undefined &&
      !command.includes("com.apple.WebKit."),
  );
  if (hosts.length === 0) throw new Error(`no host process has --config-dir ${configDir}`);
  if (hosts.length > 1) throw new Error(`${hosts.length} host processes have --config-dir ${configDir}: ${hosts.map(({ pid }) => pid).join(", ")}`);
  return { pid: hosts[0].pid };
}

/**
 * The sidecar processes of a data folder: the processes whose executable is under DIR/sidecars/. realPath is the real path of the data folder,
 * which the sidecars are launched from when the data folder is named through a symbolic link.
 */
export function sidecarProcesses(table, configDir, realPath = configDir) {
  const rows = [];
  for (const { pid, command } of table) {
    const prefix = sidecarPrefixOf(command, configDir, realPath);
    if (prefix === undefined) continue;
    rows.push({ role: `sidecar ${lexicalCommand(command).slice(prefix.length).split(/[ /]/)[0]}`, pid, attribution: "executable path" });
  }
  return rows;
}

/** Whether the lsof output of a process lists a path under the data folder. */
export function lsofMentions(text, configDir) {
  return text.split("\n").some((line) => line.includes(`${configDir}/`) || line.endsWith(configDir));
}

/** Parses the output of ps -o lstart= into the start time in milliseconds. ps reports the start time in whole seconds. */
export function parseLstart(text) {
  const trimmed = text.trim();
  const match = /^\w{3} (\w{3}) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(trimmed);
  const month = match ? MONTHS.indexOf(match[1]) : -1;
  if (!match || month < 0) throw new Error(`lstart "${trimmed}" is not a start time`);
  const [, , day, hour, minute, second, year] = match;
  return new Date(Number(year), month, Number(day), Number(hour), Number(minute), Number(second)).getTime();
}

function secondOf(milliseconds) {
  return Math.floor(milliseconds / 1000);
}

/**
 * Attributes the WebKit processes. Each process is { pid, kind: "gpu" | "networking", startedAt (milliseconds), configDir (the data folder of a
 * networking process, or null) }. A networking process with a data folder belongs to that application, and the GPU process that started in the
 * same second belongs to the same application; a second with no GPU process or with several is an error. Returns the attributed rows of each
 * process with its data folder, the rows of the processes no application claims, and the errors, all in the order of the input.
 */
export function attributeWebKit(processes) {
  const errors = [];
  const owners = new Map();
  const networkings = processes.filter((process) => process.kind === "networking" && process.configDir !== null);
  const gpus = processes.filter((process) => process.kind === "gpu");
  for (const networking of networkings) {
    owners.set(networking.pid, { configDir: networking.configDir, attribution: "data folder" });
    const second = secondOf(networking.startedAt);
    const candidates = gpus.filter((gpu) => !owners.has(gpu.pid) && secondOf(gpu.startedAt) === second);
    if (candidates.length === 0) {
      errors.push(`webkit networking pid ${networking.pid} (${networking.configDir}) has no webkit gpu process started in its start second`);
    } else if (candidates.length > 1) {
      errors.push(
        `webkit networking pid ${networking.pid} (${networking.configDir}) has ${candidates.length} webkit gpu processes started in its start second: ${candidates.map(({ pid }) => pid).join(", ")}`,
      );
    } else {
      owners.set(candidates[0].pid, { configDir: networking.configDir, attribution: "start time" });
    }
  }
  const attributed = [];
  const unattributed = [];
  for (const process of processes) {
    const role = process.kind === "gpu" ? "webkit gpu" : "webkit networking";
    const owner = owners.get(process.pid);
    if (owner) attributed.push({ configDir: owner.configDir, role, pid: process.pid, attribution: owner.attribution });
    else unattributed.push({ role, pid: process.pid, attribution: "unattributed" });
  }
  return { attributed, unattributed, errors };
}

/** Sums the rows of one application. A row whose value is null has an error in the errors list, and the sum leaves that value out. */
export function totalsOf(rows) {
  let bytes = 0;
  let cpu = 0;
  for (const row of rows) {
    if (row.bytes !== null) bytes += row.bytes;
    if (row.cpuPercent !== null) cpu += row.cpuPercent;
  }
  return { bytes, cpuPercent: cpu };
}

function megabytes(bytes) {
  return bytes === null ? "error" : (bytes / 1_000_000).toFixed(1);
}

function percent(value) {
  return value === null ? "error" : value.toFixed(1);
}

function formatTable(rows, totals) {
  const lines = [
    ["role", "pid", "attribution", "MB", "cpu%"],
    ...rows.map((row) => [row.role, String(row.pid), row.attribution, megabytes(row.bytes), percent(row.cpuPercent)]),
    ["total", "", "", megabytes(totals.bytes), percent(totals.cpuPercent)],
  ];
  const widths = [0, 1, 2, 3, 4].map((column) => Math.max(...lines.map((line) => line[column].length)));
  return lines
    .map((line) => line.map((cell, column) => (column === 0 || column === 2 ? cell.padEnd(widths[column]) : cell.padStart(widths[column]))).join("  "))
    .join("\n");
}

function formatReport({ apps, unattributed, interval }) {
  const sections = apps.map((app) => `app ${app.configDir} (cpu over ${interval} s)\n${formatTable(app.rows, app.totals)}`);
  sections.push(`webkit processes not attributed to an application\n${formatTable(unattributed.rows, unattributed.totals)}`);
  return sections.join("\n\n");
}

/** The command line options. */
export function parseOptions(args) {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      sok: { type: "string" },
      "config-dir": { type: "string", multiple: true },
      interval: { type: "string", default: "10" },
      json: { type: "boolean", default: false },
    },
  });
  if (!values.sok || !values["config-dir"]) throw new Error("required options: --sok PATH --config-dir DIR [--config-dir DIR ...]");
  for (const configDir of values["config-dir"]) {
    if (!isAbsolute(configDir)) throw new Error(`--config-dir must be an absolute path (${configDir})`);
  }
  const interval = Number(values.interval);
  if (!(interval > 0)) throw new Error(`--interval must be a positive number of seconds (${values.interval})`);
  return { sok: values.sok, configDirs: values["config-dir"], interval, json: values.json };
}

function run(file, args) {
  return execFileSync(file, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function pgrepPids() {
  const result = spawnSync("pgrep", ["-f", "com.apple.WebKit.(GPU|Networking)"], { encoding: "utf8" });
  if (result.status === 1) return [];
  if (result.error || result.status !== 0) throw new Error(`pgrep failed: ${result.error?.message ?? result.stderr.trim()}`);
  return result.stdout.split("\n").filter((line) => line !== "").map(Number);
}

/** The pages and documents of each window of one application, and its host and sidecars. */
function applicationRows(configDir, sok, table, errors) {
  const rows = [];
  const realPath = realpathSync(configDir);
  try {
    const { pid } = hostProcess(table, configDir, realPath);
    rows.push({ role: "host", pid, attribution: "config-dir argument" });
  } catch (error) {
    errors.push(`host of ${configDir}: ${error.message}`);
  }
  rows.push(...sidecarProcesses(table, configDir, realPath));
  let windows = [];
  try {
    windows = JSON.parse(run(sok, ["windows", "--config-dir", configDir]));
    if (!Array.isArray(windows)) throw new Error("sok windows reply is not an array");
  } catch (error) {
    errors.push(`windows of ${configDir}: ${error.message}`);
  }
  for (const { window } of windows) {
    const where = `page of window ${window} of ${configDir}`;
    let status;
    try {
      status = JSON.parse(run(sok, ["status", "host.window", "--window", window, "--config-dir", configDir]));
    } catch (error) {
      errors.push(`${where}: ${error.message}`);
      continue;
    }
    if (!Number.isInteger(status.pageProcess) || status.pageProcess <= 0) {
      errors.push(`${where}: no page process (${JSON.stringify(status.pageProcess)})`);
    } else {
      rows.push({ role: `page ${window}`, pid: status.pageProcess, attribution: "host.window" });
    }
    if (!Array.isArray(status.documents)) {
      errors.push(`${where}: host.window reply has no documents array`);
      continue;
    }
    for (const document of status.documents) {
      const role = `document ${document.surface}/${document.document}`;
      if (Number.isInteger(document.process) && document.process > 0) {
        rows.push({ role, pid: document.process, attribution: "host.window" });
      } else {
        errors.push(`${role} of window ${window} of ${configDir}: no process (${JSON.stringify(document.process)})`);
      }
    }
  }
  return rows;
}

/** The data folder that a networking process opens, or null with an error when it opens several data folders or lsof fails. */
function dataFolderOf(pid, configDirs, errors) {
  const result = spawnSync("lsof", ["-p", String(pid)], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    errors.push(`webkit networking pid ${pid}: lsof -p failed: ${result.error?.message ?? result.stderr.trim()}`);
    return null;
  }
  // lsof prints the resolved path of each file, so the data folder is compared by its real path (a launch path can name a symbolic link).
  const owners = configDirs.filter((configDir) => lsofMentions(result.stdout, realpathSync(configDir)));
  if (owners.length > 1) {
    errors.push(`webkit networking pid ${pid} opens the data folders of ${owners.length} applications: ${owners.join(", ")}`);
    return null;
  }
  return owners[0] ?? null;
}

/** The WebKit GPU and networking processes, attributed to the applications and the unattributed ones. */
function webkitRows(table, configDirs, errors) {
  const commands = new Map(table.map(({ pid, command }) => [pid, command]));
  const processes = [];
  const unattributed = [];
  for (const pid of pgrepPids()) {
    const command = commands.get(pid);
    if (command === undefined) {
      errors.push(`webkit process ${pid}: exited before its command line was read`);
      continue;
    }
    const kind = /com\.apple\.WebKit\.GPU\b/.test(command) ? "gpu" : /com\.apple\.WebKit\.Networking\b/.test(command) ? "networking" : null;
    if (kind === null) continue;
    let startedAt;
    try {
      startedAt = parseLstart(run("ps", ["-o", "lstart=", "-p", String(pid)]));
    } catch (error) {
      errors.push(`webkit ${kind} pid ${pid}: ${error.message}`);
      unattributed.push({ role: `webkit ${kind}`, pid, attribution: "unattributed" });
      continue;
    }
    const configDir = kind === "networking" ? dataFolderOf(pid, configDirs, errors) : null;
    processes.push({ pid, kind, startedAt, configDir });
  }
  const attribution = attributeWebKit(processes);
  errors.push(...attribution.errors);
  return { attributed: attribution.attributed, unattributed: [...attribution.unattributed, ...unattributed] };
}

function footprintOf(pid, where, errors) {
  try {
    return parseFootprint(run("footprint", ["-p", String(pid), "-f", "bytes"]));
  } catch (error) {
    errors.push(`${where}: ${error.message}`);
    return null;
  }
}

function cpuOf(before, after, pid, interval, where, errors) {
  if (!before.has(pid) || !after.has(pid)) {
    errors.push(`${where}: pid is not in the process table at both cpu reads`);
    return null;
  }
  try {
    return cpuPercent(before.get(pid), after.get(pid), interval);
  } catch (error) {
    errors.push(`${where}: ${error.message}`);
    return null;
  }
}

async function measureApps({ sok, configDirs, interval }) {
  const errors = [];
  const table = parseProcessTable(run("ps", ["-axww", "-o", "pid=,command="]));
  const apps = configDirs.map((configDir) => ({ configDir, rows: applicationRows(configDir, sok, table, errors) }));
  const webkit = webkitRows(table, configDirs, errors);
  for (const row of webkit.attributed) {
    apps.find((app) => app.configDir === row.configDir).rows.push({ role: row.role, pid: row.pid, attribution: row.attribution });
  }
  const unattributed = webkit.unattributed;

  const groups = [...apps.map((app) => ({ name: app.configDir, rows: app.rows })), { name: "unattributed", rows: unattributed }];
  const measured = groups.flatMap(({ name, rows }) => rows.map((row) => ({ row, where: `${name} ${row.role} (pid ${row.pid})` })));
  const readCpu = () => parseCpuSamples(run("ps", ["-axo", "pid=,time="]));
  const before = readCpu();
  for (const { row, where } of measured) row.bytes = footprintOf(row.pid, where, errors);
  // The fixed sampling interval is the measurement itself; no status notification marks the end of a CPU interval.
  await new Promise((resolve) => setTimeout(resolve, interval * 1000));
  const after = readCpu();
  for (const { row, where } of measured) row.cpuPercent = cpuOf(before, after, row.pid, interval, where, errors);

  return {
    interval,
    apps: apps.map((app) => ({ configDir: app.configDir, rows: app.rows, totals: totalsOf(app.rows) })),
    unattributed: { rows: unattributed, totals: totalsOf(unattributed) },
    errors,
  };
}

if (import.meta.main) {
  try {
    const options = parseOptions(process.argv.slice(2));
    const result = await measureApps(options);
    console.log(options.json ? JSON.stringify(result, null, 2) : formatReport(result));
    for (const error of result.errors) console.error(`error: ${error}`);
    if (result.errors.length > 0) process.exitCode = 1;
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exitCode = 1;
  }
}
