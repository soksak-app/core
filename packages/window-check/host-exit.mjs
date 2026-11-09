// How a host process of the application under check ended, read right after a check finds it gone: the closing records of its log
// with the source of its exit request, its crash output, a crash report of the system for its process, a jetsam report that names
// it, and otherwise the memory pressure and swap of the machine when the exit was found.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The folders where the system writes the crash reports of a user process and the jetsam reports of the machine. */
export const DIAGNOSTIC_REPORTS = [join(homedir(), "Library", "Logs", "DiagnosticReports"), "/Library/Logs/DiagnosticReports"];

/** The text of fields other than cause as `name value` pairs. */
const fieldText = (fields) => Object.entries(fields ?? {}).filter(([name]) => name !== "cause")
  .map(([name, value]) => ` ${name} ${typeof value === "string" ? value : JSON.stringify(value)}`).join("");

/** The host log of process pid, its boot in seconds, and its closing and error records. */
function hostLog(configDir, pid) {
  const pattern = new RegExp(`^host-(\\d+)-${pid}\\.jsonl$`);
  let name;
  try {
    name = readdirSync(join(configDir, "logs")).find((entry) => pattern.test(entry));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (name === undefined) return null;
  const file = join(configDir, "logs", name);
  const closed = [];
  const errors = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line === "") continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (record.event === "log.closed") {
      closed.push({ seq: record.seq, fields: record.fields ?? {}, text: `seq ${record.seq} log.closed cause ${record.fields?.cause}${fieldText(record.fields)}` });
    } else if (record.level === "error") {
      const fields = record.fields ?? {};
      errors.push({ seq: record.seq, text: `seq ${record.seq} ${record.event} ${fields.text ?? JSON.stringify(fields)}${fields.where ? ` (${fields.where})` : ""}` });
    }
  }
  return { file, boot: Number(name.match(pattern)[1]), closed, errors };
}

/**
 * How a process ended that recorded an error at its end: the exit code that its record of the exit names after its last error
 * record, or that it ended after that error record before any record of its exit; null when its log tells neither.
 */
function endingAfterError(log) {
  const last = log.closed.at(-1);
  const error = log.errors.at(-1);
  if (last?.fields.cause === "exit" && Number.isInteger(last.fields.code) && last.fields.code !== 0) {
    const before = log.errors.filter((record) => record.seq < last.seq).at(-1);
    return `it exited with code ${last.fields.code}${before ? ` after the error record ${before.text}` : ""}`;
  }
  if (error !== undefined && (last === undefined || (error.seq > last.seq && last.fields.cause !== "exit"))) {
    return `it ended after the error record ${error.text}, before a record of its exit, so its exit code was not recorded`;
  }
  return null;
}

/** The text of a crash output file of the host log beside it, when the file is not empty. */
function crashOutput(log, suffix) {
  const path = log.file.replace(/\.jsonl$/, suffix);
  let text;
  try { text = readFileSync(path, "utf8"); } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  return text.trim() === "" ? null : `${path}: ${text.trim().slice(-2000)}`;
}

/** The reports of folders written since boot (seconds), each with its header and body; a report that cannot be parsed is skipped. */
function reportsSince(folders, boot, name) {
  const reports = [];
  for (const folder of folders) {
    let entries;
    try { entries = readdirSync(folder); } catch { continue; }
    for (const entry of entries) {
      if (!entry.endsWith(".ips") || !name(entry)) continue;
      const path = join(folder, entry);
      let text;
      try {
        if (statSync(path).mtimeMs < boot * 1000) continue;
        text = readFileSync(path, "utf8");
      } catch { continue; }
      const split = text.indexOf("\n");
      try {
        reports.push({ path, header: JSON.parse(text.slice(0, split)), body: JSON.parse(text.slice(split + 1)) });
      } catch { continue; }
    }
  }
  return reports;
}

/** A jetsam report that names pid: the reason of its kill and the largest processes of the report. */
function jetsamText(report, pid) {
  const killed = report.body.processes.find((process) => process.pid === pid);
  const pageSize = report.body.memoryStatus?.pageSize ?? 16384;
  const largest = [...report.body.processes].sort((a, b) => (b.rpages ?? 0) - (a.rpages ?? 0)).slice(0, 5)
    .map((process) => `${process.name} ${process.pid} ${Math.round((process.rpages ?? 0) * pageSize / 1048576)} MB`);
  return `the jetsam report ${report.path} killed it for ${killed.reason ?? "no named reason"}; the largest processes: ${largest.join(", ")}`;
}

/** The memory pressure level and the swap use of the machine now, or why they cannot be read. */
export function memoryNow() {
  const read = (name) => {
    try { return execFileSync("/usr/sbin/sysctl", ["-n", name], { encoding: "utf8" }).trim(); } catch (error) {
      return `unreadable (${error.message.split("\n")[0]})`;
    }
  };
  const level = read("kern.memorystatus_vm_pressure_level");
  const names = { 1: "normal", 2: "warning", 4: "critical" };
  return `memory pressure ${names[level] ?? level}, swap ${read("vm.swapusage")}`;
}

/**
 * How host process pid of the configuration folder ended, in this order: the closing records of its log with the source of its exit
 * request and its error records, with the exit code after its last error record or that it ended before recording one; a crash
 * output file of it that is not empty; a crash report of the system for its process; a jetsam report that names it. Without any of
 * them, the process ended with no exit request, no crash output and no crash report, which a SIGKILL or a jetsam kill without a
 * report does, and the memory of the machine is named.
 */
export function exitEvidence(configDir, pid, { reports = DIAGNOSTIC_REPORTS, memory = memoryNow } = {}) {
  const log = hostLog(configDir, pid);
  const boot = log?.boot ?? 0;
  const parts = [];
  if (log !== null) {
    const records = [...log.closed, ...log.errors].sort((a, b) => a.seq - b.seq).slice(-8);
    if (records.length > 0) parts.push(`the last records of ${log.file} that tell how it ended: ${records.map((record) => record.text).join("; ")}`);
    const ending = endingAfterError(log);
    if (ending !== null) parts.push(ending);
    for (const suffix of [".crash", ".stderr"]) {
      const output = crashOutput(log, suffix);
      if (output !== null) parts.push(`the crash output ${output}`);
    }
  } else {
    parts.push(`no host log of process ${pid}`);
  }
  const all = reportsSince(reports, boot, () => true);
  const crash = all.find((report) => !report.path.split("/").pop().startsWith("JetsamEvent-") && report.body?.pid === pid);
  if (crash) parts.push(`the crash report ${crash.path} of ${crash.header.app_name} at ${crash.header.timestamp}`);
  const jetsam = all.find((report) => report.path.split("/").pop().startsWith("JetsamEvent-")
    && Array.isArray(report.body?.processes) && report.body.processes.some((process) => process.pid === pid));
  if (jetsam) parts.push(jetsamText(jetsam, pid));
  if (!(log?.closed.length > 0) && !(log?.errors.length > 0) && parts.every((part) => !/^the (crash|jetsam)/.test(part))) {
    parts.push(`it ended with no exit request, no crash output and no crash report, as a SIGKILL or a jetsam kill does; ${memory()} when the exit was found`);
  }
  return parts.join("; ");
}
