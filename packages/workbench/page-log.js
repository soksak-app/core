// The records of the page (docs/spec/diagnostics.md#forms, docs/spec/logging.md#writers). A failure and an observation of the
// page are the events `page.record.error` and `page.record.info` with the fields `where` and `text`. The page queues them
// without waiting and relays the records of one turn to the host in one batch through the call `log`. A page without the
// application host (the browser example) writes to its console.
import { host } from "@soksak/runtime";
import { callEvent, observeHostCalls } from "./host-calls.js";
import { createEventBatcher } from "./log-batch.js";
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
  const { where, text } = recordOf(level, line);
  return batcher.emitAndWait(level, `page.record.${level}`, { where, text });
}

/** Queues an event of a plugin or of the page with its level, name and fields; nothing happens in a page without a host. */
export function emitEvent(level, event, fields) {
  batcher?.emit(level, event, fields);
}

// The calls of the log and of the performance switch are not recorded: a recorded `log` call would record itself. The range
// reads of the debug timeline are not recorded either: the view reads in answer to the event that the writer announced after
// it wrote, so a recorded read would write the event that triggers the next read.
const UNRECORDED_CALLS = new Set(["log", "performance", "debugReadRange"]);
// Every host call of the page is the event `page.call` at the level `debug`, and a refused call is at the level `warn`
// (docs/spec/logging.md#automatic-entrances). The callers report their own failures; the event does not fail a window check.
if (batcher) {
  observeHostCalls(({ name, args, micros, ok, error }) => {
    if (UNRECORDED_CALLS.has(name)) return;
    const { level, event, fields } = callEvent({ name, args, micros, ok, error });
    batcher.emit(level, event, fields);
  });
}

// The methods of the console and the level of the event that each one makes. A console is the output of code that does not
// use the entrance of the records, so `console.error` is stored at the level `warn`: it is in the log under its own event name
// `page.console.error` and it does not fail a window check, as it did not before it was recorded. The entrance for errors is
// `reportRecord`, and for a plugin `context.runtime.log.error`.
const CONSOLE_LEVELS = { error: "warn", warn: "warn", info: "info", log: "info", debug: "debug" };

/** The text of the arguments of a console call: the arguments as the page wrote them, separated by a space. */
function consoleText(args) {
  return args.map((arg) => {
    if (typeof arg === "string") return arg;
    if (arg instanceof Error) return String(arg);
    try {
      const text = JSON.stringify(arg);
      // default: JSON has no text for undefined and for a function; the value is written as String shows it.
      return text === undefined ? String(arg) : text;
    } catch {
      // default: a value that JSON cannot serialize (a cycle, a BigInt) is written as String shows it.
      return String(arg);
    }
  }).join(" ");
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
      emitEvent(level, `page.console.${method}`, { text: consoleText(args) });
    };
  }
}
