// The progress of the host calls that the page sent. It makes every call sent before the page reloads itself receive a reply
// (docs/spec/native-host.md#page-reload). The runtimes of both applications wrap their own calls with it.
// A call that holds a number JSON cannot carry (NaN, Infinity) is rejected without being sent (docs/spec/native-host.md#host-calls).

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

const observed = (name, args, started, ok, error) => {
  if (observer) observer({ name, args, micros: Math.round((performance.now() - started) * 1000), ok, error });
};

// The longest text of the arguments of a call in an event; a longer text is cut and the event says `truncated`.
const CALL_ARGS_LIMIT = 1024;

/** The text of the arguments of a host call and whether it was cut. */
function callArguments(args) {
  let text;
  try {
    text = JSON.stringify(args);
  } catch (error) {
    // default: arguments that JSON cannot serialize are recorded with the reason, as the call itself fails on them.
    text = `unserializable: ${error.message}`;
  }
  return text.length > CALL_ARGS_LIMIT ? { args: text.slice(0, CALL_ARGS_LIMIT), truncated: true } : { args: text, truncated: false };
}

/**
 * The event `page.call` of a host call (docs/spec/logging.md#automatic-entrances): the level is `debug`, and `warn` for a
 * refused call. The main page and the documents of the surfaces make the event here so that both record a call alike.
 */
export function callEvent({ name, args, micros, ok, error }) {
  const fields = { name, ...callArguments(args), micros, ok };
  if (!ok) fields.error = error;
  return { level: ok ? "debug" : "warn", event: "page.call", fields };
}

/**
 * Wraps call and counts the calls in progress. settle() finishes when every call sent until then has received a reply, and calls after that are
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
  return {
    call(name, ...args) {
      if (settled) return new Promise(() => {});
      const started = performance.now();
      for (const arg of args) {
        const found = nonFinite(arg, "");
        if (found) {
          const where = found.path ? found.path : "the argument";
          const error = new TypeError(`host call ${name}: ${where} is ${found.value}, which JSON sends as null`);
          observed(name, args, started, false, error.message);
          return Promise.reject(error);
        }
      }
      pending += 1;
      const result = Promise.resolve().then(() => call(name, ...args));
      result.then(() => { observed(name, args, started, true, undefined); answered(); },
        (error) => { observed(name, args, started, false, error instanceof Error ? error.message : String(error)); answered(); });
      return result;
    },
    settle() {
      if (!settled) {
        settled = new Promise((done) => { resolve = done; });
        if (pending === 0) resolve();
      }
      return settled;
    },
  };
}
