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

/**
 * The rows that pass the filter: `level` is the least severe level shown, `layer` is a layer or `all`, and `text` is
 * a case-insensitive part of the text line of the row.
 */
export function filterRows(rows, { level, layer, text }) {
  if (!LEVELS.includes(level)) throw new Error(`timeline level ${found(level)} is not one of ${LEVELS.join(", ")}`);
  if (layer !== "all" && !LAYERS.includes(layer)) throw new Error(`timeline layer ${found(layer)} is not one of all, ${LAYERS.join(", ")}`);
  if (typeof text !== "string") throw new Error(`timeline text must be a string, found ${found(text)}`);
  const least = LEVELS.indexOf(level);
  const needle = text.toLowerCase();
  return rows.filter((row) =>
    LEVELS.indexOf(row.level) <= least
    && (layer === "all" || row.layer === layer)
    && (needle === "" || eventLine(row).toLowerCase().includes(needle)));
}
