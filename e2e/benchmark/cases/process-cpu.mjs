// The CPU time of the processes of an application over an interval of a window benchmark, shared by the click, scroll and layout
// redraw benchmarks (e2e/benchmark/click-cpu.test.mjs, scroll-cpu.test.mjs, layout-redraw.test.mjs). The processes are those that
// make measure-app-usage reads (scripts/measure-app-usage.mjs): the host, the process whose command line has --config-dir of the
// application, the page and document processes that host.window of each window of the application reports, the WebKit services of
// the launchd domain of the host, and the sidecar processes of the configuration folder, together with the persistent raster probe
// service and the child process of each of its sessions (rasterServiceSnapshot of e2e/raster-probe.mjs), which the host starts with
// --service-dir. The CPU time of a process is the CPU time that ps reports at the start and at the end of the interval.
import { readCpuSeconds, cpuFigures, onePerProcess, windowApplicationRows } from "../../../scripts/measure-app-usage.mjs";
import { rasterServiceSnapshot } from "../../raster-probe.mjs";

/** The groups that the figures sum, in the order of the report. */
export const CPU_GROUPS = Object.freeze(["host", "webContent", "sidecars", "webkitServices"]);

/**
 * The group of a process row of measure-app-usage (`role`): the host; the web content processes, the main page, the documents of
 * the views and the WebContent services of the launchd domain; the sidecars, a sidecar executable or a process of the raster probe
 * service; and the other WebKit services, GPU and networking. A role of another form is an error that names it.
 */
export function cpuGroupOf(role) {
  if (role === "host") return "host";
  if (role.startsWith("page ") || role.startsWith("document ") || role === "webkit webcontent") return "webContent";
  if (role.startsWith("sidecar ") || role.startsWith("rasterprobe ")) return "sidecars";
  if (role === "webkit gpu" || role === "webkit networking") return "webkitServices";
  throw new Error(`the process role ${JSON.stringify(role)} belongs to no CPU group`);
}

/**
 * The rows of the processes `listed` (measure-app-usage rows `{role, pid, attribution}`) with the raster probe service `service`
 * (rasterServiceSnapshot, or null when the configuration runs none) added: a pid that a listed row already names keeps that row,
 * so no process is counted twice.
 */
export function withRasterService(listed, service) {
  if (service === null) return listed;
  const named = new Set(listed.map(({ pid }) => pid));
  const added = [{ role: "rasterprobe service", pid: service.service }, ...service.children.map((pid) => ({ role: `rasterprobe session ${pid}`, pid }))]
    .filter(({ pid }) => !named.has(pid)).map((row) => ({ ...row, attribution: "service-dir argument" }));
  return [...listed, ...added];
}

/** The host.window of each window of the application of the session `s`, each with `window`, its identifier. */
async function windowStatuses(s) {
  const statuses = [];
  for (const { window } of await s.get("host.windows")) statuses.push({ ...(await s.on(window).get("host.window")), window });
  return statuses;
}

/** The raster probe service of the configuration, or null when it runs none (its folder holds no endpoint yet). */
function rasterService(configDir) {
  try {
    return rasterServiceSnapshot(configDir);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * The processes of the application of the session `s` now: the rows of measure-app-usage for its windows and the raster probe
 * service (withRasterService). An error of a row, a window without a page process among them, fails the reading with every error.
 */
export async function applicationProcesses(s) {
  const { rows, errors } = await windowApplicationRows({ configDir: s.app.configDir, statuses: await windowStatuses(s) });
  if (errors.length > 0) throw new Error(`the processes of ${s.app.name} cannot be read: ${errors.join("; ")}`);
  return withRasterService(rows, rasterService(s.app.configDir));
}

/**
 * The CPU figures of the rows `rows` over `seconds` from the readings `before` and `after` (Map pid -> CPU seconds) and `actions`,
 * the number of actions of the interval: each row with its group, cpuSeconds and cpuPercent, and for each group of CPU_GROUPS and
 * the total the CPU seconds, the percent of the interval and the CPU milliseconds per action, each process once. A process that is not in both readings
 * and a CPU time that decreased are errors (cpuFigures of measure-app-usage), which fail the figures together.
 */
export function cpuReport({ rows, before, after, seconds, actions }) {
  if (!(seconds > 0)) throw new Error(`the interval must be a positive number of seconds, not ${seconds}`);
  if (!Number.isInteger(actions) || actions < 1) throw new Error(`the interval must hold at least one action, not ${actions}`);
  const measured = rows.map((row) => ({ row: { ...row, group: cpuGroupOf(row.role) }, where: `${row.role} (pid ${row.pid})` }));
  const { errors } = cpuFigures({ measured, foreign: new Set(), cpuBefore: before, cpuAfter: after, elapsed: seconds });
  if (errors.length > 0) throw new Error(`the CPU time over the interval cannot be read: ${errors.join("; ")}`);
  // Each process counts once: one WebContent process draws the documents of several views, and each document has its row.
  const figures = (selected) => {
    const cpuSeconds = onePerProcess(selected.map(({ row }) => row)).reduce((sum, row) => sum + row.cpuSeconds, 0);
    return { cpuSeconds, cpuPercent: (cpuSeconds / seconds) * 100, msPerAction: (cpuSeconds * 1000) / actions };
  };
  const groups = Object.fromEntries(CPU_GROUPS.map((group) => [group, figures(measured.filter(({ row }) => row.group === group))]));
  return { seconds, actions, rows: measured.map(({ row }) => row), groups, total: figures(measured) };
}

/**
 * Runs `interval`, which performs `actions` actions and returns a value, and returns `{value, cpu}`: its value and the CPU report
 * (cpuReport) of the processes of the application of the session `s` that ran before it, from the CPU time right before and right
 * after it, over the time between the two readings.
 */
export async function measureCpu(s, actions, interval) {
  const rows = await applicationProcesses(s);
  const before = await readCpuSeconds();
  const started = performance.now();
  const value = await interval();
  const after = await readCpuSeconds();
  const seconds = (performance.now() - started) / 1000;
  return { value, cpu: cpuReport({ rows, before, after, seconds, actions }) };
}

/** The line of a CPU report: each group and the total with its CPU seconds, its percent of the interval and its milliseconds per action. */
export function cpuLine({ seconds, actions, groups, total }) {
  const part = (name, { cpuSeconds, cpuPercent, msPerAction }) =>
    `${name} ${cpuSeconds.toFixed(3)} s ${cpuPercent.toFixed(1)}% ${msPerAction.toFixed(2)} ms/action`;
  return [`${actions} actions in ${seconds.toFixed(2)} s`, ...CPU_GROUPS.map((group) => part(group, groups[group])), part("total", total)].join("; ");
}

/** The percentile `p` (0 to 100) of the numbers `values` by the nearest rank; an empty list is an error. */
export function percentile(values, p) {
  if (values.length === 0) throw new Error("a percentile of no value");
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}
