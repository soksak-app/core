// The timeline of the debug view (docs/spec/debug.md): the event lines of the host event files
// `logs/host-<boot>.jsonl` (docs/spec/logging.md) become rows sorted by time, are filtered, and are rendered as text lines.

/** The schema number of the event files that the timeline reads. */
const SCHEMA = 1;

/** The levels from the most to the least severe; a level filter shows its level and the more severe ones. */
export const LEVELS = ["error", "warn", "info", "debug", "trace"];
/** The layers of an event. */
export const LAYERS = ["native", "host", "page", "plugin", "sidecar"];

/** The text of a value in an error message. */
const found = (value) => JSON.stringify(value);

/** The event files of the host in the debug file list, in path order: `logs/host-<boot>.jsonl`, without rotated generations. */
export function hostEventFiles(entries) {
  return entries.map((entry) => entry.path).filter((path) => /^logs\/host-[^/]+\.jsonl$/.test(path)).toSorted();
}

/** Checks the optional string members of an event line. */
function checkIdentifiers(where, event) {
  for (const name of ["window", "surface", "session"]) {
    if (event[name] !== undefined && typeof event[name] !== "string") throw new Error(`${where}: ${name} must be a string, found ${found(event[name])}`);
  }
  if (event.cids !== undefined && !(Array.isArray(event.cids) && event.cids.every((cid) => typeof cid === "string"))) {
    throw new Error(`${where}: cids must be an array of strings, found ${found(event.cids)}`);
  }
}

/** Reads one event line into a row, or throws an error that names the file and the line. */
function rowOf(file, number, raw) {
  const where = `${file}:${number}`;
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    throw new Error(`${where}: not JSON: ${raw}`);
  }
  if (event === null || typeof event !== "object" || Array.isArray(event)) throw new Error(`${where}: not an event object: ${raw}`);
  for (const name of ["ts_us", "seq"]) {
    if (!Number.isInteger(event[name])) throw new Error(`${where}: ${name} must be an integer, found ${found(event[name])}`);
  }
  if (!LEVELS.includes(event.level)) throw new Error(`${where}: level ${found(event.level)} is not one of ${LEVELS.join(", ")}`);
  if (!LAYERS.includes(event.layer)) throw new Error(`${where}: layer ${found(event.layer)} is not one of ${LAYERS.join(", ")}`);
  if (typeof event.event !== "string") throw new Error(`${where}: event must be a string, found ${found(event.event)}`);
  if (event.fields !== undefined && (event.fields === null || typeof event.fields !== "object" || Array.isArray(event.fields))) {
    throw new Error(`${where}: fields must be an object, found ${found(event.fields)}`);
  }
  checkIdentifiers(where, event);
  return { file, line: number, ...event };
}

/**
 * The rows of the text of one event file, in the order of the file. The first line must be `log.open` with the schema number
 * that this reader knows. A truncated text starts inside a line (docs/spec/debug.md): its first, partial line is skipped and
 * the `log.open` check does not apply.
 */
export function parseEvents(file, text, truncated) {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (truncated) {
    if (lines.length < 2) throw new Error(`${file}: the truncated text has no complete line`);
    lines.shift();
  }
  if (lines.length === 0) throw new Error(`${file}: the file is empty`);
  const offset = truncated ? 2 : 1;
  const rows = lines.map((raw, index) => rowOf(file, index + offset, raw));
  if (!truncated) {
    if (rows[0].event !== "log.open") throw new Error(`${file}: the first line is not log.open: ${found(rows[0].event)}`);
    if (rows[0].fields?.schema !== SCHEMA) throw new Error(`${file}: schema ${rows[0].fields?.schema} is not ${SCHEMA}`);
  }
  return rows;
}

/** The rows of several files sorted by time, then `seq`, then file; the arguments are not changed. */
export function mergeRows(files) {
  return files.flat().toSorted((left, right) => {
    if (left.ts_us !== right.ts_us) return left.ts_us - right.ts_us;
    if (left.seq !== right.seq) return left.seq - right.seq;
    return left.file.localeCompare(right.file);
  });
}

/** The time of a row as UTC text with microseconds. */
function timeText(ts_us) {
  const milliseconds = new Date(Math.floor(ts_us / 1000)).toISOString().slice(0, -1);
  return `${milliseconds}${String(ts_us % 1000).padStart(3, "0")}Z`;
}

/** One row as one text line: time, level, layer, event, identifiers, then the fields as `name=value`. */
export function eventLine(row) {
  const parts = [timeText(row.ts_us), row.level, row.layer, row.event];
  for (const name of ["window", "surface", "session"]) {
    if (row[name] !== undefined) parts.push(`${name}=${row[name]}`);
  }
  if (row.cids !== undefined) parts.push(`cids=${row.cids.join(",")}`);
  for (const [name, value] of Object.entries(row.fields ?? {})) parts.push(`${name}=${JSON.stringify(value)}`);
  return parts.join(" ");
}

/** The filter of a timeline that has just been loaded: every level and layer, no text, identifier or time bound, no context rows. */
export const CLEAR_FILTER = { level: "trace", layer: "all", text: "", event: "", surface: "", session: "", cid: "", from: "", to: "", context: "0" };

/** The accepted text of a time bound: UTC with seconds and up to six fractional digits. */
const UTC_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?Z$/;

/** The microseconds of a time bound, or null for the empty text that leaves the bound open. */
function boundOf(name, value) {
  if (typeof value !== "string") throw new Error(`timeline ${name} must be a string, found ${found(value)}`);
  if (value === "") return null;
  const invalid = () => new Error(`timeline ${name} ${found(value)} is not a UTC time like 2026-10-08T22:53:20.123456Z or empty`);
  const match = UTC_TIME.exec(value);
  if (match === null) throw invalid();
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  // A date that the calendar does not have (for example February 30) moves to another day in Date.UTC.
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) throw invalid();
  return date.getTime() * 1000 + Number((match[7] ?? "").padEnd(6, "0"));
}

/** The number of context rows of a filter: decimal digits, at most four. */
function contextCount(value) {
  if (typeof value !== "string" || !/^[0-9]{1,4}$/.test(value)) throw new Error(`timeline context must be decimal digits, found ${found(value)}`);
  return Number(value);
}

/**
 * The rows that pass the filter: `level` is the least severe level shown, `layer` is a layer or `all`, `text` is
 * a case-insensitive part of the text line of the row, `event` is a case-insensitive part of the event name, `surface`
 * and `session` are the whole identifier, `cid` is one of the correlation identifiers of the row, `from` and `to`
 * are inclusive UTC times, and an empty text leaves a member open. `context` only applies to `contextRows`.
 */
export function filterRows(rows, filter) {
  const { level, layer, text, event, surface, session, cid, from, to } = filter;
  if (!LEVELS.includes(level)) throw new Error(`timeline level ${found(level)} is not one of ${LEVELS.join(", ")}`);
  if (layer !== "all" && !LAYERS.includes(layer)) throw new Error(`timeline layer ${found(layer)} is not one of all, ${LAYERS.join(", ")}`);
  for (const [name, value] of Object.entries({ text, event, surface, session, cid })) {
    if (typeof value !== "string") throw new Error(`timeline ${name} must be a string, found ${found(value)}`);
  }
  contextCount(filter.context);
  const first = boundOf("from", from);
  const last = boundOf("to", to);
  if (first !== null && last !== null && first > last) throw new Error(`timeline from is later than to: ${found(from)} ${found(to)}`);
  const least = LEVELS.indexOf(level);
  const needle = text.toLowerCase();
  const name = event.toLowerCase();
  return rows.filter((row) =>
    LEVELS.indexOf(row.level) <= least
    && (layer === "all" || row.layer === layer)
    && (name === "" || row.event.toLowerCase().includes(name))
    && (surface === "" || row.surface === surface)
    && (session === "" || row.session === session)
    && (cid === "" || (row.cids?.includes(cid) ?? false))
    && (first === null || row.ts_us >= first)
    && (last === null || row.ts_us <= last)
    && (needle === "" || eventLine(row).toLowerCase().includes(needle)));
}

/**
 * The rows that pass the filter with `context` rows of `rows` before and after each of them, once, in the order of
 * `rows`, as {row, match}; `match` is false for a row that is shown only as context.
 */
export function contextRows(rows, filter) {
  const passing = new Set(filterRows(rows, filter));
  const count = contextCount(filter.context);
  const shown = [];
  let until = -1;
  rows.forEach((row, index) => {
    if (passing.has(row)) {
      for (let before = Math.max(until + 1, index - count); before < index; before += 1) shown.push({ row: rows[before], match: false });
      shown.push({ row, match: true });
      until = index + count;
    } else if (index <= until) {
      shown.push({ row, match: false });
    }
  });
  return shown;
}
