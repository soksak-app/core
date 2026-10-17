// The gate of the page (docs/spec/logging.md#classes-and-policy): the policy says for each class the least severe level that is
// stored. The page asks the gate before it builds the fields of an event, and the batcher counts the events that a closed gate
// refused and reports the count as the event `page.log.gated`.
import { CLASSES } from "./event-classes.js";

const LEVELS = ["error", "warn", "info", "debug", "trace"];
const VALUES = ["off", ...LEVELS];

/**
 * The policy of the setting `diagnostics.log`: the object of the setting names some classes, and a class it does not name stores
 * every level. A class outside the contract and a value outside the levels are refused.
 */
export function logPolicyOf(setting) {
  if (setting === null || typeof setting !== "object" || Array.isArray(setting)) throw new TypeError("the policy must be an object");
  for (const name of Object.keys(setting)) {
    if (!CLASSES.includes(name)) throw new TypeError(`the class ${name} is not one of ${CLASSES.join(", ")}`);
  }
  // default: a class that the setting does not name stores the level error (docs/spec/logging.md#classes-and-policy).
  return Object.fromEntries(CLASSES.map((name) => [name, setting[name] ?? "error"]));
}

/** A gate that stores only the errors of every class until a policy is set. */
export function createLogGate() {
  let max = Object.fromEntries(CLASSES.map((name) => [name, 0]));
  return {
    /** Whether an event of the class and the level is stored. An event whose class the catalog does not give is not gated. */
    enabled(klass, level) {
      if (klass === undefined) return true;
      const at = LEVELS.indexOf(level);
      return at >= 0 && max[klass] >= at;
    },

    /**
     * Puts a policy in force: an object that names every class with one of `off`, `error`, `warn`, `info`, `debug` and `trace`.
     * A refused policy leaves the one in force. Returns whether the policy changed.
     */
    set(policy) {
      if (policy === null || typeof policy !== "object" || Array.isArray(policy)) throw new TypeError("the policy must be an object");
      for (const name of Object.keys(policy)) {
        if (!CLASSES.includes(name)) throw new TypeError(`the class ${name} is not one of ${CLASSES.join(", ")}`);
      }
      const next = {};
      for (const name of CLASSES) {
        if (!Object.hasOwn(policy, name)) throw new TypeError(`the class ${name} is missing`);
        const value = policy[name];
        if (typeof value !== "string") throw new TypeError(`the level of the class ${name} must be text, found ${JSON.stringify(value)}`);
        const at = VALUES.indexOf(value);
        if (at < 0) throw new TypeError(`the level ${JSON.stringify(value)} of the class ${name} is not one of ${VALUES.join(", ")}`);
        next[name] = at - 1;
      }
      const changed = CLASSES.some((name) => next[name] !== max[name]);
      max = next;
      return changed;
    },

    /** The policy in force, as `set` takes it. */
    classes() {
      return Object.fromEntries(CLASSES.map((name) => [name, VALUES[max[name] + 1]]));
    },
  };
}

/** The gate of the page, which every batcher of the page asks. */
export const logGate = createLogGate();
