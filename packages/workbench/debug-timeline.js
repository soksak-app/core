// The timeline of the debug view (docs/spec/debug.md): pages of the events of the event files, which the host answers through the
// query (docs/spec/logging.md#query), become rows sorted by time and are rendered as text lines. The view never reads an event file.

/**
 * The number of rows of one page that the view asks for. A page that draws an element pair for each row of a large event file stopped
 * answering, so the view asks for a page and not for a file.
 */
export const PAGE_ROWS = 500;

/**
 * The number of rows that the view holds and draws. A page that draws one element pair for each of 100000 rows stops answering, so
 * the view holds the newest rows that the pages bring and states how many older rows following leaves out; the filters, the time
 * bounds and the older pages narrow and move the rows, and the selection counts every selected row.
 */
export const HOLD_LIMIT = 2000;

/** The channels of the query: the files that are not debug files, the debug files, and both. */
export const CHANNELS = ["other", "debug", "all"];
/** The levels from the most to the least severe; a level filter shows its level and the more severe ones. */
export const LEVELS = ["error", "warn", "info", "debug", "trace"];
/** The layers of an event. */
export const LAYERS = ["native", "host", "page", "plugin", "sidecar", "sok"];

/** The text of a value in an error message. */
const found = (value) => JSON.stringify(value);

/** The event files of the logs folder in the debug file list: `logs/<role>-<boot>[.debug].jsonl`, also a generation `.1` to `.5`. */
const EVENT_FILE = /^logs\/[a-z][a-z0-9]*-[^/]+?(?:\.debug)?\.jsonl(?:\.[1-5])?$/;

/** Whether the path is an event file of the logs folder. */
export function isEventFile(path) {
  return EVENT_FILE.test(path);
}

/** The identity of a row: its process and its `seq`. */
export const rowId = (row) => `${row.role}-${row.boot}:${row.event.seq}`;

/** The key of a row, which orders the rows and is the cursor of a page: `ts_us`, then `role`, then `boot`, then `seq`. */
export const keyOf = (row) => ({ ts_us: row.event.ts_us, role: row.role, boot: row.boot, seq: row.event.seq });

/** Orders two rows by their keys. */
export function compareRows(left, right) {
  if (left.event.ts_us !== right.event.ts_us) return left.event.ts_us - right.event.ts_us;
  if (left.role !== right.role) return left.role < right.role ? -1 : 1;
  if (left.boot !== right.boot) return left.boot < right.boot ? -1 : 1;
  return left.event.seq - right.event.seq;
}

/** The rows of `held` and `added` sorted by key, each row once; the arguments are not changed. */
export function mergeRows(held, added) {
  const seen = new Set();
  const rows = [];
  for (const row of [...held, ...added]) {
    const id = rowId(row);
    if (seen.has(id)) continue;
    seen.add(id);
    rows.push(row);
  }
  return rows.toSorted(compareRows);
}

/** The time of a row as UTC text with microseconds. */
function timeText(ts_us) {
  const milliseconds = new Date(Math.floor(ts_us / 1000)).toISOString().slice(0, -1);
  return `${milliseconds}${String(ts_us % 1000).padStart(3, "0")}Z`;
}

/** One event as one text line: time, level, layer, event, identifiers, then the fields as `name=value`. */
export function eventLine(event) {
  const parts = [timeText(event.ts_us), event.level, event.layer, event.event];
  for (const name of ["window", "surface", "session"]) {
    if (event[name] !== undefined) parts.push(`${name}=${event[name]}`);
  }
  if (event.cids !== undefined && event.cids.length > 0) parts.push(`cids=${event.cids.join(",")}`);
  // default: an event line without fields has no field text.
  for (const [name, value] of Object.entries(event.fields ?? {})) parts.push(`${name}=${JSON.stringify(value)}`);
  return parts.join(" ");
}

/** The filter of a timeline that has just been loaded: the channel `other`, every level and layer, and no other member. */
export const CLEAR_FILTER = {
  channel: "other", level: "trace", class: "", layer: "all", text: "", event: "", event_prefix: "", surface: "", session: "", cid: "", run: "", from: "", to: "",
};

/** The accepted text of a time bound: UTC with seconds and up to six fractional digits. */
const UTC_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?Z$/;

/** The microseconds of a time bound, or null for the empty text that leaves the bound open. */
function boundOf(name, value) {
  if (typeof value !== "string") throw new Error(`log query ${name} must be a string, found ${found(value)}`);
  if (value === "") return null;
  const invalid = () => new Error(`log query ${name} ${found(value)} is not a UTC time like 2026-10-08T22:53:20.123456Z`);
  const match = UTC_TIME.exec(value);
  if (match === null) throw invalid();
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  // A date that the calendar does not have (for example February 30) moves to another day in Date.UTC.
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) throw invalid();
  // default: a time bound without fractional digits has zero microseconds.
  return date.getTime() * 1000 + Number((match[7] ?? "").padEnd(6, "0"));
}

/**
 * The request of the host call `logQuery` for a filter: the members that the filter leaves open are not in it, `layer` `all` is no
 * layer, and the UTC times become `from_us` and `to_us`. The host refuses a value of the query that it does not accept with its
 * own error text; the times are converted here, so they are refused here.
 */
export function queryOf(filter) {
  for (const [name, value] of Object.entries(filter)) {
    if (typeof value !== "string") throw new Error(`log query ${name} must be a string, found ${found(value)}`);
  }
  const request = { channel: filter.channel, level: filter.level };
  if (filter.layer !== "all") request.layer = filter.layer;
  for (const name of ["class", "text", "event", "event_prefix", "surface", "session", "cid", "run"]) {
    if (filter[name] !== "") request[name] = filter[name];
  }
  const from = boundOf("from", filter.from);
  const to = boundOf("to", filter.to);
  if (from !== null) request.from_us = from;
  if (to !== null) request.to_us = to;
  return request;
}
