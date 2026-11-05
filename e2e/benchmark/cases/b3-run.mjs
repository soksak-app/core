// The run of an e2e benchmark for the benchmark B3 (docs/operations/examples.md, B3). `make e2e-benchmark-*` takes B3_OUT=<file> and, for
// the view drag and the resize catch-up, TRACE=<state> (0|frame-records and captured|frame-records), and passes them to the benchmark as
// SOKSAK_B3_OUT and SOKSAK_B3_TRACE. The benchmark writes the keys that e2e/benchmark/measurements.mjs declares for it, and for the state
// of SOKSAK_B3_TRACE, with the conditions of the measured interval, through the single writer and reader of the B3 output,
// scripts/b3-out.mjs. Without SOKSAK_B3_OUT it runs as a window check and writes nothing. B3 names a new file for each run of a
// benchmark file, so the tests of one file add to one output: they run under the same conditions, a value is written once, and the
// verdict is "failed" when any test of the file failed.
import { existsSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { policyOfSetting, readPolicy } from "@soksak/window-check/log-policy.mjs";
import { b3Conditions as conditionsOf, readB3Out, writeB3Out } from "../../../scripts/b3-out.mjs";
import { parseTrace } from "../../../scripts/measure-trace.mjs";

/** The session of the conditions that b3Conditions read, whose window withB3Out reads again when it writes them. */
const SESSIONS = new WeakMap();

const OUT = "SOKSAK_B3_OUT";
const TRACE = "SOKSAK_B3_TRACE";

/** The fixture options (fresh of e2e/fixture.mjs) that apply the settings `settings` of a benchmark (B3_SETTINGS, traceSettings). */
export function fixtureSettings(settings) {
  return { performanceTrace: settings["diagnostics.performance"], log: settings["diagnostics.log"] };
}

/**
 * The conditions of the run of the window of `s` now: its host.window, its diagnostics.performance and the classes of its policy file.
 * They must hold the settings `settings` that the benchmark applied for its interval (B3_SETTINGS of measurements.mjs, or traceSettings
 * of the trace state); other conditions are an error that names both.
 */
export async function b3Conditions(s, settings) {
  const { values } = await s.get("core.settings");
  const conditions = conditionsOf({ windows: [{ ...(await s.get("host.window")), window: s.window }],
    performance: values["diagnostics.performance"], policy: readPolicy(s.app.configDir).classes });
  const classes = policyOfSetting(settings["diagnostics.log"]).classes;
  if (conditions.traceState !== settings["diagnostics.performance"] || !isDeepStrictEqual(conditions.logPolicy, classes)) {
    throw new Error(`the window runs with diagnostics.performance ${conditions.traceState} and the log classes ` +
      `${JSON.stringify(conditions.logPolicy)}, not the settings ${JSON.stringify(settings)} of the benchmark, whose log classes are ` +
      `${JSON.stringify(classes)}`);
  }
  SESSIONS.set(conditions, s);
  return conditions;
}

/**
 * The conditions to write when the interval ends: a window covered at the start or now is covered, and an application is active only when
 * it was active at the start and is now, so an activation that ended during the interval is recorded. A benchmark that failed keeps the
 * conditions of its start when its window cannot be read, because its failure is what it records.
 */
async function conditionsAtEnd(conditions, failure) {
  const s = SESSIONS.get(conditions);
  if (s === undefined) return conditions;
  try {
    const { occluded, active } = await s.get("host.window");
    return { ...conditions, occluded: conditions.occluded || occluded, active: conditions.active && active };
  } catch (error) {
    if (failure) return conditions;
    throw error;
  }
}

/**
 * The B3 output of a benchmark run from the environment `env` and the keys that the benchmark declares (B3_MEASUREMENTS): null without
 * SOKSAK_B3_OUT, otherwise { path, state, keys }. A benchmark that declares keys for each of two states takes the state from
 * SOKSAK_B3_TRACE, set together with SOKSAK_B3_OUT, which is one of the state names of its keys; a benchmark of one state refuses
 * SOKSAK_B3_TRACE, and its state is null.
 */
export function b3Target(env, declared) {
  const path = env[OUT];
  const trace = env[TRACE];
  if (path === "") throw new Error(`${OUT} must be the path of the B3 output file or unset, not empty`);
  if (Array.isArray(declared)) {
    if (trace !== undefined) {
      throw new Error(`${TRACE} names the state of a benchmark that measures in two, and this benchmark measures in one; it must be unset, not ${JSON.stringify(trace)}`);
    }
    return path === undefined ? null : { path, state: null, keys: declared };
  }
  if ((path === undefined) !== (trace === undefined)) {
    const [set, unset] = path === undefined ? [TRACE, OUT] : [OUT, TRACE];
    throw new Error(`${OUT} and ${TRACE} are set together or not at all; ${set} is set and ${unset} is not`);
  }
  if (path === undefined) return null;
  let state;
  try {
    state = parseTrace(trace, Object.keys(declared));
  } catch (error) {
    throw new Error(`${TRACE}: ${error.message}`, { cause: error });
  }
  return { path, state, keys: declared[state] };
}

/** The output of `path` written by an earlier test of the run with the output `next` of this test added to it. */
function mergedOutput(path, next) {
  if (!existsSync(path)) return next;
  const { measurements, conditions } = readB3Out(path);
  if (!isDeepStrictEqual(conditions, next.conditions)) {
    throw new Error(`${path}: the conditions ${JSON.stringify(next.conditions)} of this test differ from the conditions ${JSON.stringify(conditions)} of an earlier test of the run`);
  }
  for (const [key, value] of Object.entries(next.measurements)) {
    if (key === "verdict" && Object.hasOwn(measurements, key)) {
      measurements[key] = measurements[key] === "failed" || value === "failed" ? "failed" : "passed";
    } else if (Object.hasOwn(measurements, key)) {
      throw new Error(`${path}: B3 measurement ${key} was written by an earlier test of the run`);
    } else {
      measurements[key] = value;
    }
  }
  return { measurements, conditions };
}

/**
 * Runs `measure(run)` of a benchmark for the B3 output `target` (b3Target), which may be null. `run.state` is the state of the output
 * (null for a benchmark of one state or without output); the benchmark sets `run.conditions` (b3Conditions) at the start of the
 * interval that it measures in that state and adds its values to `run.measurements`. With a target, the output is written also when the
 * run fails: the values measured before the failure and, when the benchmark declares `verdict`, "passed" or "failed". A value that the
 * benchmark does not declare is refused. The error of the run is thrown after the output is written; an output that cannot be written
 * fails the run, with the error of the run when both fail.
 */
export async function withB3Out(target, measure) {
  const run = { state: target?.state ?? null, conditions: undefined, measurements: {} };
  let failure;
  try {
    await measure(run);
  } catch (error) {
    failure = error;
  }
  if (target === null) {
    if (failure) throw failure;
    return run;
  }
  try {
    const values = target.keys.filter((key) => key !== "verdict");
    for (const key of Object.keys(run.measurements)) {
      if (!values.includes(key)) throw new Error(`B3 measurement ${key} is not declared for this benchmark; it declares ${values.join(", ")}`);
    }
    const measurements = target.keys.includes("verdict") ? { ...run.measurements, verdict: failure ? "failed" : "passed" } : { ...run.measurements };
    writeB3Out(target.path, mergedOutput(target.path, { measurements, conditions: await conditionsAtEnd(run.conditions, failure) }));
  } catch (error) {
    if (failure) throw new AggregateError([failure, error], `the benchmark failed (${failure.message}) and its B3 output was not written (${error.message})`);
    throw error;
  }
  if (failure) throw failure;
  return run;
}
