// The trace state of a measurement (docs/operations/examples.md, B3). `make app-usage`, `make terminal-redraw-usage`,
// `make object-counts` and `make host-allocations` take TRACE=0|1 and set its state with core.settings.change before they
// measure: TRACE=0 is the performance trace off under the default log policy, and TRACE=1 is the trace on with the class
// `frame` at `debug`. TRACE has no default: each run records its trace state, so a target that kept the state it found would
// measure a state that it did not set. A third state, FRAME_RECORDS, is the trace off under the policy that stores the class
// `frame` at `debug`, in which `make app-usage STEP=pointer` repeats its move to read the steps of the frame records.
import { policyOfSetting, untilPolicy } from "@soksak/window-check/log-policy.mjs";

/** The trace state of the frame records: the trace off under the policy that stores the class `frame` at `debug`. */
export const FRAME_RECORDS = "frame-records";

/**
 * Reads TRACE as one of the trace states that a target measures: 0 and 1, and FRAME_RECORDS for a target that lists it. No
 * value and any other text are an error that names the states of the target.
 */
export function parseTrace(text, states = [0, 1]) {
  const names = states.map(String);
  const expected = `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`;
  if (text === undefined || text === "") throw new Error(`TRACE must be ${expected}, not set`);
  const index = names.indexOf(text);
  if (index === -1) throw new Error(`TRACE must be ${expected}, not ${JSON.stringify(text)}`);
  return states[index];
}

/**
 * The settings of a trace state: 0, 1 or FRAME_RECORDS; any other value is an error that names it. The performance trace stores its events in the class `call` at the level `debug`
 * (docs/spec/events.json), so the trace on also stores that class at `debug`, as the window checks do (prepareFixture of
 * @soksak/window-check); the value `{}` of `diagnostics.log` is the default policy (docs/spec/settings.md).
 */
export function traceSettings(trace) {
  if (trace === 0) return { "diagnostics.log": {}, "diagnostics.performance": false };
  if (trace === 1) return { "diagnostics.log": { call: "debug", frame: "debug" }, "diagnostics.performance": true };
  if (trace === FRAME_RECORDS) return { "diagnostics.log": { frame: "debug" }, "diagnostics.performance": false };
  throw new Error(`the trace state must be 0, 1 or FRAME_RECORDS (${JSON.stringify(FRAME_RECORDS)}), not ${JSON.stringify(trace)}`);
}

/**
 * Sets the trace state (0, 1 or FRAME_RECORDS) in the common scope through `run(command, params)`, which runs a declared command of the application,
 * and resolves when the policy file of the configuration folder holds the policy of the state; a policy that the file does
 * not hold within `limit` ms rejects with the policy that it holds. The policy is set before the trace, so the trace that
 * turns on stores its first events under the policy of the state.
 */
export async function applyTrace(run, trace, configDir, limit) {
  const settings = traceSettings(trace);
  for (const [key, value] of Object.entries(settings)) {
    await run("core.settings.change", { key, value, scope: "common" });
  }
  await untilPolicy(configDir, policyOfSetting(settings["diagnostics.log"]), limit);
}
