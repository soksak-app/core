// The recording functions of the runtime that a plugin receives, `runtime.trace` and `runtime.log` (docs/spec/plugins.md#tracing,
// docs/spec/plugins.md#logging). A surface context builds them with this function.

export const LOG_LEVELS = Object.freeze(["error", "warn", "info", "debug", "trace"]);

const EVENT_NAME = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
// A correlation identifier is not empty and holds no quote, no backslash and no control character, as the host requires.
const CID = /^[^"\\\u0000-\u001f\u007f]+$/;

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Builds `{trace, log}` for the plugin `pluginId` and its surface `surfaceId`. `hooks` is what the page offers:
 *   log(level, event, fields, cids)  stores an event
 *   trace(event, fields)             writes a trace event
 * A page without a host offers none of them, and the calls then store nothing.
 */
export function createPluginRuntime({ pluginId, surfaceId, hooks }) {
  const trace = (event, fields = {}) => {
    if (typeof event !== "string" || event === "") throw new TypeError("trace requires an event name");
    if (!isObject(fields)) throw new TypeError("trace requires fields as an object");
    // default: a page without a host (the browser application, a test) has no trace, as a trace that is off.
    hooks.trace?.(event, { ...fields, plugin: pluginId, surface: surfaceId });
  };
  const cidsOf = (options) => {
    if (options === undefined) return undefined;
    if (!isObject(options) || Object.keys(options).some((key) => key !== "cids")) throw new TypeError("log options may only hold cids");
    const { cids } = options;
    if (cids === undefined) return undefined;
    if (!Array.isArray(cids) || !cids.every((cid) => typeof cid === "string" && CID.test(cid))) {
      throw new TypeError("log cids must be an array of non-empty strings without a quote, a backslash or a control character");
    }
    return cids.length === 0 ? undefined : cids;
  };
  const log = Object.fromEntries(LOG_LEVELS.map((level) => [level, (event, fields = {}, options = undefined) => {
    if (typeof event !== "string" || !EVENT_NAME.test(event)) {
      throw new TypeError("log requires an event name of lowercase words separated by dots");
    }
    const cids = cidsOf(options);
    if (!isObject(fields)) throw new TypeError("log requires fields as an object");
    if ("surface" in fields) throw new TypeError("log fields must not name the surface; the context adds it");
    // default: a page without a host (the browser application, a test) has no event log, as a log that is off.
    hooks.log?.(level, `plugin.${pluginId}.${event}`, { ...fields, surface: surfaceId }, cids);
  }]));
  return { trace, log: Object.freeze(log) };
}
