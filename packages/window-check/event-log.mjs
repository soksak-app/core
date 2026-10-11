// Reads error events from the event log of the application under check. The host process writes one event per line to
// `logs/host-<boot>.jsonl` for each run, and an event with level error is an error (docs/spec/logging.md#files).
import { existsSync, readdirSync, readFileSync, statSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";

// The event files of the processes of the application (docs/spec/logging.md#files): the host and every sidecar service, each with its
// main file (error, warn and info) and its debug file (debug and trace).
const HOST_LOG = /^(host|vt|files|shell)-\d+-\d+(\.debug)?\.jsonl$/;

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
  const events = [];
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
  for (const list of processes.values()) events.push(...list.toSorted((a, b) => a.seq - b.seq));
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
 * asynchronous writer writes the records to the file at every batch interval, so a change watch (fs.watch) is placed on
 * each host event log file and the files are read again at each notification. The notification of a folder cannot
 * report content that another process appends to a file, so it is used only to notice new files. When the deadline
 * passes, it rejects with an error that holds the lines read.
 */
export function untilEventLines(configDir, offsets, predicate, timeout) {
  return new Promise((resolve, reject) => {
    const logs = join(configDir, "logs");
    const watchers = new Map();
    let finished = false;
    let timer;
    const stop = () => {
      finished = true;
      clearTimeout(timer);
      for (const watcher of watchers.values()) watcher.close();
    };
    const fail = (error) => {
      if (finished) return;
      stop();
      reject(error);
    };
    // Every host event log has a watcher, including a file that a later run created.
    const watchFiles = () => {
      for (const name of readdirSync(logs).filter((entry) => HOST_LOG.test(entry))) {
        if (!watchers.has(name)) watchers.set(name, watch(join(logs, name), check));
      }
    };
    function check() {
      if (finished) return;
      try {
        watchFiles();
        const { lines } = readEventLines(configDir, offsets);
        if (predicate(lines)) {
          stop();
          resolve(lines);
        }
      } catch (error) {
        fail(error);
      }
    }
    const folder = watch(logs, check);
    watchers.set("", folder);
    const seen = () => {
      try {
        return JSON.stringify(readEventLines(configDir, offsets).lines.slice(-8));
      } catch (error) {
        return `unreadable: ${error.message}`;
      }
    };
    timer = setTimeout(() => {
      if (finished) return;
      const lines = seen();
      stop();
      reject(new Error(`no event line matched within ${timeout} ms; the lines after the offsets: ${lines}`));
    }, timeout);
    check();
  });
}

/** Returns, within timeout, the first line among the event lines written after offsets that the predicate accepts. */
export async function untilEventLine(configDir, offsets, predicate, timeout) {
  const lines = await untilEventLines(configDir, offsets, (all) => all.some(predicate), timeout);
  return lines.find(predicate);
}

// The prefixes of the events of the trace and the layer of the row that each one makes.
const TRACE_PREFIXES = [["page.trace.", "page"], ["host.trace.", "host"], ["host.sampler.", "sampler"], ["sidecar.vt.", "vt-core"]];

/**
 * The events of the trace of the page, the host and the sampler as rows in the shape of the trace file of earlier runs: the
 * layer, the event name without the prefix, the time as an ISO-8601 text with milliseconds, and the fields of the event.
 */
export function traceRows(events) {
  const rows = [];
  for (const event of events) {
    // A plugin event `plugin.<plugin>.<event>` (docs/spec/logging.md#catalog) is a row of the layer plugin.
    const plugin = /^plugin\.[a-z0-9-]+\./.exec(event.event);
    const match = plugin ? [plugin[0], "plugin"] : TRACE_PREFIXES.find(([prefix]) => event.event.startsWith(prefix));
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
