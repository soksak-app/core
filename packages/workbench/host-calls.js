// The progress of the host calls that the page sent. It makes every call sent before the page reloads itself receive a reply
// (docs/spec/native-host.md#page-reload). The runtimes of both applications wrap their own calls with it.
// A call that holds a number JSON cannot carry (NaN, Infinity) is rejected without being sent (docs/spec/native-host.md#host-calls).
import { boundedJson } from "./bounded-json.js";

/** The path and value of the first non-finite number in arg. It is null when there is none. */
function nonFinite(value, path) {
  if (typeof value === "number") return Number.isFinite(value) ? null : { path, value };
  if (value === null || typeof value !== "object") return null;
  for (const [key, item] of Object.entries(value)) {
    const found = nonFinite(item, Array.isArray(value) ? `${path}[${key}]` : path ? `${path}.${key}` : key);
    if (found) return found;
  }
  return null;
}

// The observer of the calls (docs/spec/logging.md#automatic-entrances): it receives {name, args, micros, ok, error} once for
// every call that the wrapper handles, after the call ended or was refused. One observer is installed for the page.
let observer = null;

/** Installs the observer of the host calls, or removes it with null. */
export function observeHostCalls(next) {
  observer = next;
}

const observed = (name, args, started, ok, error, code, cids) => {
  if (observer) observer({ name, args, micros: Math.round((performance.now() - started) * 1000), ok, error, code, cids });
};

/** The code of an error that a host call states when the failure has none of its own: the internal code of the entrance (docs/spec/logging.md#result-form). */
export const INTERNAL_CODE = -32603;

/** The text of a failure of a call and its code, or undefined when the failure has none of its own. */
export function failureOf(error) {
  return {
    error: error instanceof Error ? error.message : String(error),
    code: Number.isInteger(error?.code) ? error.code : undefined,
  };
}

// The longest text of the arguments of a call in an event, in bytes; a longer text is cut while it is serialized and the event
// says `truncated` (docs/spec/logging.md#bounds).
const CALL_ARGS_LIMIT = 1024;

/** The text of the arguments of a host call and whether it was cut. */
function callArguments(args) {
  try {
    const { text, truncated } = boundedJson(args, CALL_ARGS_LIMIT);
    return { args: text, truncated };
  } catch (error) {
    // default: arguments that JSON cannot serialize are recorded with the reason, as the call itself fails on them.
    return { args: `unserializable: ${error.message}`, truncated: false };
  }
}

/**
 * The correlation identifiers that a call continues (docs/spec/logging.md#correlation-identifier). Only the send of a request
 * to a sidecar carries them: the main page passes one object `{sidecar, surface, body, cids}`, and the runtime of a surface
 * passes `(sidecar, surface, body, cids)`. A call without a non-empty list has none; a value that is not a list is returned as
 * it is, so the batcher of the events reports it.
 */
function callCids(name, args) {
  if (name !== "sidecarSend") return undefined;
  const cids = args.length === 1 && args[0] !== null && typeof args[0] === "object" ? args[0].cids : args[3];
  return Array.isArray(cids) && cids.length === 0 ? undefined : cids;
}

/**
 * The event `page.call` of a host call (docs/spec/logging.md#automatic-entrances): the level is `debug`, and `warn` for a
 * refused call. The main page and the documents of the surfaces make the event here so that both record a call alike. `cids`
 * are the correlation identifiers that the call continues, or undefined.
 */
export function callEvent({ name, args, micros, ok, error, code, cids }) {
  const fields = { name, ...callArguments(args), micros, ok };
  // default: a failure without a code of its own has the internal code of the entrance (docs/spec/logging.md#result-form).
  if (!ok) fields.error = `${code ?? INTERNAL_CODE}: ${error}`;
  // default: a call that carries out no operation has the identifiers that its arguments carry, if any (a sidecar send).
  return { level: ok ? "debug" : "warn", event: "page.call", fields, cids: cids ?? callCids(name, args) };
}

/**
 * Wraps call, a transport `(name, arg, {cids})`, and counts the calls in progress. settle() finishes when every call sent until then has received a reply, and calls after that are
 * not sent. A call that is not sent ends together with the document, like a call stopped by a reload, so it returns a promise that never settles.
 */
export function settlingCalls(call) {
  let pending = 0;
  let settled = null;
  let resolve = null;
  const answered = () => {
    pending -= 1;
    if (pending === 0 && resolve) resolve();
  };
  /** Sends one call; `cids` are the identifiers of the operation that the call carries out, or undefined. */
  function run(cids, name, args) {
    if (settled) return new Promise(() => {});
    const started = performance.now();
    for (const arg of args) {
      const found = nonFinite(arg, "");
      if (found) {
        const where = found.path ? found.path : "the argument";
        const error = new TypeError(`host call ${name}: ${where} is ${found.value}, which JSON sends as null`);
        observed(name, args, started, false, error.message, undefined, cids);
        return Promise.reject(error);
      }
    }
    pending += 1;
    // The transport takes the one argument of the call and the options of the call.
    const result = Promise.resolve().then(() => call(name, args[0], { cids }));
    result.then(() => { observed(name, args, started, true, undefined, undefined, cids); answered(); },
      (error) => { const failure = failureOf(error); observed(name, args, started, false, failure.error, failure.code, cids); answered(); });
    return result;
  }
  return {
    call: (name, ...args) => run(undefined, name, args),
    /** Sends a call that carries out the operation whose identifiers are `cids` (operations.js). */
    callContinuing: (cids, name, ...args) => run(cids, name, args),
    settle() {
      if (!settled) {
        settled = new Promise((done) => { resolve = done; });
        if (pending === 0) resolve();
      }
      return settled;
    },
  };
}
