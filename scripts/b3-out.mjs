// The output of a measurement target for the benchmark B3 (docs/spec/hosts.md, performance goals), and its single writer and
// reader. A target that takes B3_OUT=<file> writes to that file one JSON object {measurements, conditions}. measurements maps
// each measurement name that the target declares in its B3_MEASUREMENTS to a number, "passed" or "failed"; conditions holds the
// state of the run: refreshRate and backingScale of the screen of the window, traceState, the trace state that the target applied
// (0, 1 or "frame-records", scripts/measure-trace.mjs), logPolicy, the classes of the policy in force, and window {width, height},
// the content size of the window in points. The writer and the reader refuse the same forms with the same errors.
import { readFileSync, writeFileSync } from "node:fs";
import { EVERY_LEVEL, policyOfSetting } from "@soksak/window-check/log-policy.mjs";
import { FRAME_RECORDS, traceSettings } from "./measure-trace.mjs";

/** The members of the conditions, in the order of the output. */
const CONDITIONS = ["refreshRate", "backingScale", "traceState", "logPolicy", "window"];

/** The classes of a log policy (docs/spec/logging.md#policy). */
const CLASSES = Object.keys(EVERY_LEVEL);

/**
 * The conditions of a run from the host.window reply of the measured window, the trace state that the target applied and the
 * classes of the policy in force. A window on no screen (refreshRate null) has no refresh rate to record and is an error.
 */
export function b3Conditions({ window, trace, policy }) {
  traceSettings(trace);
  if (window.refreshRate === null) throw new Error("host.window reports the refresh rate null, so the window is on no screen");
  return {
    refreshRate: window.refreshRate,
    backingScale: window.scale,
    traceState: trace,
    logPolicy: policy,
    window: { width: window.content?.width, height: window.content?.height },
  };
}

const positive = (value) => typeof value === "number" && Number.isFinite(value) && value > 0;
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const sameNames = (value, names) => Object.keys(value).length === names.length && names.every((name) => Object.hasOwn(value, name));

/** Throws an error that names the first measurement or condition outside the form of the B3 output. */
function requireB3(output) {
  if (!isObject(output) || !sameNames(output, ["measurements", "conditions"])) {
    throw new Error(`the B3 output must have the members measurements and conditions, not ${isObject(output) ? Object.keys(output).join(", ") : JSON.stringify(output)}`);
  }
  const { measurements, conditions } = output;
  if (!isObject(measurements) || Object.keys(measurements).length === 0) throw new Error("the B3 output has no measurement");
  for (const [name, value] of Object.entries(measurements)) {
    if (!(typeof value === "number" && Number.isFinite(value)) && value !== "passed" && value !== "failed") {
      throw new Error(`B3 measurement ${name} must be a finite number, "passed" or "failed", not ${typeof value === "number" ? String(value) : JSON.stringify(value)}`);
    }
  }
  if (!isObject(conditions) || !sameNames(conditions, CONDITIONS)) {
    throw new Error(`B3 conditions must be ${CONDITIONS.join(", ")}, not ${isObject(conditions) ? Object.keys(conditions).join(", ") : JSON.stringify(conditions)}`);
  }
  for (const name of ["refreshRate", "backingScale"]) {
    if (!positive(conditions[name])) throw new Error(`B3 condition ${name} must be a positive number, not ${JSON.stringify(conditions[name])}`);
  }
  if (![0, 1, FRAME_RECORDS].includes(conditions.traceState)) {
    throw new Error(`B3 condition traceState must be 0, 1 or ${JSON.stringify(FRAME_RECORDS)}, not ${JSON.stringify(conditions.traceState)}`);
  }
  const policy = conditions.logPolicy;
  if (!isObject(policy) || !sameNames(policy, CLASSES)) {
    throw new Error(`B3 condition logPolicy must name the classes ${CLASSES.join(", ")}, not ${isObject(policy) ? Object.keys(policy).join(", ") : JSON.stringify(policy)}`);
  }
  try {
    policyOfSetting(policy);
  } catch (error) {
    throw new Error(`B3 condition logPolicy: ${error.message}`, { cause: error });
  }
  const { window } = conditions;
  if (!isObject(window) || !sameNames(window, ["width", "height"]) || !positive(window.width) || !positive(window.height)) {
    throw new Error(`B3 condition window must be {width, height} of positive numbers, not ${JSON.stringify(window)}`);
  }
}

/** Writes the B3 output of a run to `file`; a measurement or a condition outside the form is an error that names it, and nothing is written. */
export function writeB3Out(file, { measurements, conditions }) {
  const output = { measurements, conditions };
  requireB3(output);
  writeFileSync(file, `${JSON.stringify(output, null, 2)}\n`);
}

/** Reads the B3 output of a run from `file`; text that is not JSON or not of the form is an error that names the file and the bad key. */
export function readB3Out(file) {
  const text = readFileSync(file, "utf8");
  let output;
  try {
    output = JSON.parse(text);
  } catch (error) {
    throw new Error(`${file}: not JSON: ${error.message}`, { cause: error });
  }
  try {
    requireB3(output);
  } catch (error) {
    throw new Error(`${file}: ${error.message}`, { cause: error });
  }
  return output;
}
