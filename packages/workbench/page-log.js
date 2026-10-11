// The records of the page (docs/spec/diagnostics.md#forms, docs/spec/logging.md#writers). A failure and an observation of the
// page are the events `page.record.error` and `page.record.info` with the fields `where` and `text`. The page queues them
// without waiting and relays the records of one turn to the host in one batch through the call `log`. A page without the
// application host (the browser example) writes to its console.
import { host } from "@soksak/runtime";
import { boundedJson, byteLength, cutBytes } from "./bounded-json.js";
import { callEvent, observeHostCalls } from "./host-calls.js";
import { createEventBatcher } from "./log-batch.js";
import { installOperationSink } from "./operations.js";
import { recordOf } from "./report-record.js";

// The console as the page had it before the capture: a failure to relay cannot be reported through the relay, and what it
// writes to the console must not become an event again.
// The writer to the console that does not pass through the capture: it is the method of the console when the capture starts, and
// until then the method of the console itself.
let rawError = (...args) => console.error(...args);
let rawInfo = (...args) => console.info(...args);
export const rawConsole = {
  error: (...args) => rawError(...args),
  info: (...args) => rawInfo(...args),
};

const batcher = host
  ? createEventBatcher({ call: (request) => host.call("log", request), report: (error) => rawConsole.error(error.message) })
  : null;

// The longest place and text of a record in an event, in bytes; a longer one is cut on a character boundary and the event says
// `truncated` (docs/spec/logging.md#bounds).
const RECORD_WHERE_LIMIT = 1024;
const RECORD_TEXT_LIMIT = 8192;

/**
 * Stores a record of the page and returns a promise that ends when the batch that carries it was relayed. `level` is `error`
 * for a failure and `info` for a state without a failure; `line` is `<where>: <text>`, and a line without `: ` has the place
 * `page`.
 */
export function reportRecord(level, line) {
  if (!batcher) {
    (level === "error" ? rawConsole.error : rawConsole.info)(line);
    return Promise.resolve();
  }
  const record = recordOf(level, line);
  const where = cutBytes(record.where, RECORD_WHERE_LIMIT);
  const text = cutBytes(record.text, RECORD_TEXT_LIMIT);
  const fields = { where: where.text, text: text.text };
  if (where.truncated || text.truncated) fields.truncated = true;
  return batcher.emitAndWait(level, `page.record.${level}`, fields);
}

// The first event of an operation of the page (docs/spec/logging.md#operation-chains) is stored with the identifiers of the operation.
if (batcher) {
  installOperationSink((event, fields, cids) => {
    // events: page.plugin.operation, page.project.operation, page.window.operation, page.settings.change, page.update.operation
    batcher.emit("info", event, fields, cids);
  });
}

/**
 * Queues an event of a plugin or of the page with its level, name, fields and the correlation identifiers `cids` of its chain
 * (docs/spec/logging.md#operation-chains); nothing happens in a page without a host.
 */
export function emitEvent(level, event, fields, cids = undefined) {
  // events: forwarded
  batcher?.emit(level, event, fields, cids);
}

/**
 * Queues the event `page.start`, which marks the start of this document in the timeline: a reload of the page starts a new
 * document with a new clock, and the events that follow belong to it. `timeOrigin` is `performance.timeOrigin`.
 */
export function recordPageStart(location, timeOrigin) {
  emitEvent("info", "page.start", { time_origin: timeOrigin, url: location.href });
}

// The calls of the log and of the performance switch are not recorded: a recorded `log` call would record itself. The queries
// of the debug timeline are not recorded either: the view asks in answer to the event that the writer announced after it wrote, so
// a recorded query would write the event that triggers the next query. The calls that draw and place a native
// modal are of the class `frame` (docs/spec/logging.md#classes), which is stored as aggregates and not as one event per call;
// a view that follows the event file draws again for every row it appends, so recorded draws would feed it forever.
const UNRECORDED_CALLS = new Set(["log", "performance", "logQuery", "overlayUpdate", "overlayPlace"]);
// Every host call of the page is the event `page.call` at the level `debug`, and a refused call is at the level `warn`
// (docs/spec/logging.md#automatic-entrances). The callers report their own failures; the event does not fail a window check.
if (batcher) {
  observeHostCalls(({ name, args, micros, ok, error, code, cids: operation }) => {
    if (UNRECORDED_CALLS.has(name)) return;
    const { level, event, fields, cids } = callEvent({ name, args, micros, ok, error, code, cids: operation });
    // events: page.call
    batcher.emit(level, event, fields, cids);
  });
}

// The methods of the console and the level of the event that each one makes. A console is the output of code that does not
// use the entrance of the records, so `console.error` is stored at the level `warn`: it is in the log under its own event name
// `page.console.error` and it does not fail a window check, as it did not before it was recorded. The entrance for errors is
// `reportRecord`, and for a plugin `context.runtime.log.error`.
const CONSOLE_LEVELS = { error: "warn", warn: "warn", info: "info", log: "info", debug: "debug" };

// The longest text of a console call in an event, in bytes; a longer text is cut while it is built and the event says `truncated`
// (docs/spec/logging.md#bounds).
const CONSOLE_TEXT_LIMIT = 8192;

/** The text of the arguments of a console call, separated by a space, and whether it was cut at the bound. */
function consoleText(args) {
  const parts = [];
  let length = 0;
  for (const arg of args) {
    const room = CONSOLE_TEXT_LIMIT - length;
    let part;
    let cut = false;
    if (typeof arg === "string") ({ text: part, truncated: cut } = cutBytes(arg, room));
    else if (arg instanceof Error) ({ text: part, truncated: cut } = cutBytes(String(arg), room));
    else {
      try {
        ({ text: part, truncated: cut } = boundedJson(arg, room));
        // default: JSON has no text for undefined and for a function; the value is written as String shows it.
        if (part === undefined) ({ text: part, truncated: cut } = cutBytes(String(arg), room));
      } catch {
        // default: a value that JSON cannot serialize (a cycle, a BigInt) is written as String shows it.
        ({ text: part, truncated: cut } = cutBytes(String(arg), room));
      }
    }
    parts.push(part);
    length += byteLength(part) + 1;
    if (cut || length >= CONSOLE_TEXT_LIMIT) return { text: parts.join(" "), truncated: cut || args.length > parts.length };
  }
  return { text: parts.join(" "), truncated: false };
}

const captured = new WeakSet();

/**
 * Records what the page writes to its console as the events `page.console.<method>` with the field `text`, and keeps the
 * console working: each method still runs. Calling it again for the same console changes nothing.
 */
export function captureConsole(target = console) {
  if (captured.has(target)) return;
  captured.add(target);
  for (const [method, level] of Object.entries(CONSOLE_LEVELS)) {
    const original = target[method]?.bind(target);
    if (!original) continue;
    if (target === console && method === "error") rawError = original;
    if (target === console && method === "info") rawInfo = original;
    target[method] = (...args) => {
      original(...args);
      const { text, truncated } = consoleText(args);
      emitEvent(level, `page.console.${method}`, truncated ? { text, truncated } : { text });
    };
  }
}
