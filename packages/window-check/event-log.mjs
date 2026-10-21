// Reads error events from the event log of the application under check. The host process writes one event per line to
// `logs/host-<boot>.jsonl` for each run, and an event with level error is an error (docs/spec/logging.md#files).
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { untilFolderState } from "./folder-wait.mjs";
import { policyFile, readPolicy, requireStored } from "./log-policy.mjs";

// The event files of the processes of the application (docs/spec/logging.md#files): the host and every sidecar service, each with its
// main file (error, warn and info) and its debug file (debug and trace). A sidecar file is named by its role, so the role is any name.
const HOST_LOG = /^[a-z][a-z0-9-]*-\d+-\d+(\.debug)?\.jsonl$/;

/**
 * The file that records the last read position of each file. It is placed next to the configuration folder, so there is
 * one per configuration folder.
 */
export const eventOffsetFile = (configDir) => `${configDir}.event-offsets`;

/** The identity of a file: its inode as decimal text, read as a bigint so that no digit is lost. */
const inodeOf = (path) => String(statSync(path, { bigint: true }).ino);

/**
 * File name to last read position `{offset, inode}`: the byte offset and the inode of the file that held it, so a read finds
 * the file again after the writer rotated it. Without a record it is empty, so every file is read from the start.
 */
export function readEventOffsets(configDir) {
  const file = eventOffsetFile(configDir);
  if (!existsSync(file)) return {};
  const value = JSON.parse(readFileSync(file, "utf8"));
  const position = (item) => item !== null && typeof item === "object" && Number.isInteger(item.offset) && item.offset >= 0 &&
    typeof item.inode === "string" && /^\d+$/.test(item.inode) && Object.keys(item).length === 2;
  if (value === null || typeof value !== "object" || Array.isArray(value) || !Object.values(value).every(position)) {
    throw new Error(`${file}: expected an object of positions {offset, inode}, found ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * The position from which a session judges the errors of the application with the process identifier pid. A file that the
 * stored offsets name keeps its stored position. Every other file that exists at the start of the session is placed at its
 * end now: the stored offsets do not name it when an earlier session did not read it (a boot that ended before the earlier
 * session stored its offsets, or a configuration whose offsets were removed), and its records all precede the session. The
 * file of the running process pid starts at its beginning, because the records of that process belong to the session. A file
 * that appears after the start is absent from the result and is read from its beginning, so its records count.
 */
export function sessionEventStart(configDir, pid) {
  const stored = existsSync(eventOffsetFile(configDir)) ? readEventOffsets(configDir) : {};
  const running = new RegExp(`-${pid}(\\.debug)?\\.jsonl$`);
  const start = { ...stored };
  for (const [name, position] of Object.entries(currentEventOffsets(configDir))) {
    if (Object.hasOwn(stored, name) || running.test(name)) continue;
    start[name] = position;
  }
  return start;
}

export function writeEventOffsets(configDir, offsets) {
  writeFileSync(eventOffsetFile(configDir), `${JSON.stringify(offsets)}\n`);
}

const RECORD_EVENT = /^(host|page|native|sidecar|plugin)\.record\.(error|warn|info|debug|trace)$/;

/**
 * The line of one event. A record event (`<layer>.record.<level>` `{where, text}`) is the text line `<level> <layer>
 * <where>: <text>`, and any other event is `<level> <layer> <event>: <fields>`.
 */
export function eventLine(event) {
  if (RECORD_EVENT.test(event.event)) {
    const { where, text } = event.fields ?? {};
    if (typeof where !== "string" || typeof text !== "string") {
      throw new Error(`the record event ${event.event} needs where and text as strings, found ${JSON.stringify(event.fields)}`);
    }
    return `${event.level} ${event.layer} ${where}: ${text}`;
  }
  return `${event.level} ${event.layer} ${event.event}: ${JSON.stringify(event.fields ?? {})}`;
}

/**
 * The events written after offsets in every host event log, and the new positions. The events of one process are in the order
 * of seq across its main file and its debug file. A last fragment whose line is not finished is not read and is read next time.
 * When a line is not an event, a file is shorter than the read position, or no event log exists, the error contains the file name.
 */
export function readEvents(configDir, offsets) {
  const logs = join(configDir, "logs");
  const names = readdirSync(logs).filter((name) => HOST_LOG.test(name)).sort();
  if (names.length === 0) throw new Error(`${logs} holds no host event log; the application writes it there (docs/spec/logging.md#files)`);
  let events = [];
  const next = {};
  // The events of the files of one process, which the writer numbers across both files.
  const processes = new Map();
  for (const name of names) {
    const path = join(logs, name);
    const inode = inodeOf(path);
    const position = offsets[name];
    let offset = position?.offset ?? 0;
    // A file of another inode than the one read before was rotated: the writer moved the file that was read to a generation
    // `<name>.<n>` (docs/spec/logging.md#files) and started a new file, so the rest of that generation is read, and the new
    // file from its start.
    let rotated = "";
    if (position !== undefined && position.inode !== inode) {
      const generation = readdirSync(logs).find((entry) => entry.startsWith(`${name}.`) && /^\d+$/.test(entry.slice(name.length + 1)) &&
        inodeOf(join(logs, entry)) === position.inode);
      if (generation === undefined) throw new Error(`${path} was rotated, and no generation holds the ${offset} bytes already read`);
      const before = readFileSync(join(logs, generation));
      if (before.length < offset) throw new Error(`${join(logs, generation)} is shorter than the ${offset} bytes already read`);
      rotated = before.subarray(offset).toString("utf8");
      offset = 0;
    }
    const size = statSync(path).size;
    if (size < offset) throw new Error(`${path} is shorter than the ${offset} bytes already read`);
    const data = readFileSync(path);
    const text = rotated + data.subarray(offset).toString("utf8");
    const complete = text.lastIndexOf("\n") + 1;
    const lines = complete === 0 ? [] : text.slice(0, complete - 1).split("\n");
    // The line number counts from the start of the file, so the error names the line a person opens.
    let lineNumber = data.subarray(0, offset).filter((byte) => byte === 0x0a).length;
    for (const line of lines) {
      lineNumber += 1;
      let event;
      try {
        event = JSON.parse(line);
      } catch (error) {
        throw new Error(`${path}:${lineNumber}: the line is not valid JSON: ${error.message}`);
      }
      if (typeof event?.level !== "string") throw new Error(`${path}:${lineNumber}: the event has no level`);
      if (!Number.isInteger(event.seq)) throw new Error(`${path}:${lineNumber}: the event has no integer seq`);
      const owner = name.replace(/(\.debug)?\.jsonl$/, "");
      if (!processes.has(owner)) processes.set(owner, []);
      processes.get(owner).push(event);
    }
    // The generation ends at the end of a line, so the position in the new file excludes its bytes.
    next[name] = { offset: offset + Buffer.byteLength(text.slice(0, complete)) - Buffer.byteLength(rotated), inode };
  }
  // A day of checks writes hundreds of thousands of events into one file, and the spread of a call would overflow the stack.
  for (const list of processes.values()) events = events.concat(list.toSorted((a, b) => a.seq - b.seq));
  return { events, offsets: next };
}

/**
 * The lines of the error events written after offsets (`error <layer> <where or event>: <text or fields>`) and the new
 * positions.
 */
export function readEventErrors(configDir, offsets) {
  const { events, offsets: next } = readEvents(configDir, offsets);
  return { errors: events.filter((event) => event.level === "error").map(eventLine), offsets: next };
}

/** The lines of all events written after offsets and the new positions. */
export function readEventLines(configDir, offsets) {
  const { events, offsets: next } = readEvents(configDir, offsets);
  return { lines: events.map(eventLine), offsets: next };
}

/**
 * Waits until a whole line of an event written after offsets satisfies the predicate and returns that line. An
 * asynchronous writer writes the records to the file at every batch interval, so the files are read once the change
 * watch of the folder `logs` is active and again at each change (folder-wait.mjs); the watch reports a new file and
 * content that another process appends to a file. When the deadline passes, it rejects with an error that holds the lines
 * read. `records` names the records that the predicate reads, declared in `catalog`; a record that the policy file of the
 * folder does not store is an error at once that names the record and the policy (docs/spec/logging.md#policy), because
 * the wait would end only at its deadline.
 */
export async function untilEventLines(configDir, offsets, predicate, timeout, { catalog, records } = {}) {
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error("untilEventLines: the wait names no record; give { catalog, records } of the records that the predicate reads");
  }
  requireStored(readPolicy(configDir), catalog, records, policyFile(configDir));
  const read = () => {
    const { lines } = readEventLines(configDir, offsets);
    return predicate(lines) ? lines : undefined;
  };
  const seen = () => {
    try {
      return JSON.stringify(readEventLines(configDir, offsets).lines.slice(-8));
    } catch (error) {
      return `unreadable: ${error.message}`;
    }
  };
  return untilFolderState(join(configDir, "logs"), read, timeout,
    () => new Error(`no event line matched within ${timeout} ms; the lines after the offsets: ${seen()}`));
}

/** Returns, within timeout, the first line among the event lines written after offsets that the predicate accepts; `declared` is the { catalog, records } of untilEventLines. */
export async function untilEventLine(configDir, offsets, predicate, timeout, declared) {
  const lines = await untilEventLines(configDir, offsets, (all) => all.some(predicate), timeout, declared);
  return lines.find(predicate);
}

// The prefixes of the events of the trace and the layer of the row that each one makes. The events `sidecar.<name>.*` of a sidecar
// make the layer `<name>-core`; `sidecar.record.<level>` are the lines of its standard error, not trace events.
const TRACE_PREFIXES = [["page.trace.", "page"], ["host.trace.", "host"], ["host.sampler.", "sampler"]];
const SIDECAR_TRACE = /^sidecar\.(?!record\.)([a-z][a-z0-9-]*)\./;

// The prefix of a trace event and the layer of its row, or undefined when the event is not a trace event.
function traceLayer(name) {
  const known = TRACE_PREFIXES.find(([prefix]) => name.startsWith(prefix));
  if (known) return known;
  const sidecar = SIDECAR_TRACE.exec(name);
  return sidecar ? [sidecar[0], `${sidecar[1]}-core`] : undefined;
}

/**
 * The events of the trace of the page, the host and the sampler as rows in the shape of the trace file of earlier runs: the
 * layer, the event name without the prefix, the time as an ISO-8601 text with milliseconds, and the fields of the event.
 */
export function traceRows(events) {
  const rows = [];
  for (const event of events) {
    const match = traceLayer(event.event);
    if (!match) continue;
    // The surface, the session and the correlation identifiers of an event are members of the line and not of its fields.
    const context = {};
    for (const key of ["surface", "session", "cids"]) if (event[key] !== undefined) context[key] = event[key];
    rows.push({ layer: match[1], event: event.event.slice(match[0].length), ts: new Date(event.ts_us / 1000).toISOString(), ...context, ...event.fields });
  }
  return rows;
}

/**
 * The end of the complete lines of every host event log now. A check that reads what the application wrote after a moment
 * takes this position first; `readEventOffsets` is the position at which the earlier session ended, which the harness uses
 * to judge the errors between two checks.
 */
export function currentEventOffsets(configDir) {
  const logs = join(configDir, "logs");
  const offsets = {};
  for (const name of readdirSync(logs).filter((entry) => HOST_LOG.test(entry)).sort()) {
    const data = readFileSync(join(logs, name));
    offsets[name] = { offset: data.lastIndexOf(0x0a) + 1, inode: inodeOf(join(logs, name)) };
  }
  return offsets;
}
