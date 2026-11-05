// Judges a session folder of the three-host benchmark (docs/operations/examples.md#three-host-benchmark) against the performance
// goals of docs/spec/performance-goals.json (docs/spec/hosts.md#performance-goals). It starts no application: it reads the folder,
// applies the run conditions, every bound, the relative criteria, the regression rule and the comparisons of a value with another
// value of the mygo host, prints each value with its runs, its spread and its result, and exits with status 1 when a value or a run
// fails. `make check-b3 SESSION=<folder>` runs it.
//
//   node scripts/b3-judge.mjs --session <folder>
//
// A session folder, which `make benchmark-b3` (scripts/benchmark-b3.mjs) writes, holds:
//
//   session.json            {"schema": 1, "phase": "1" | "final", "runs": <runs of each application>,
//                            "applications": [{"name": <application>, "host": "mygo" | "wailsv3" | "tauriv2", "build": "current" | "baseline"}, ...],
//                            "builds": {<application>: {"revision": <source revision>, "executable": <sha256 of the executable>}},
//                            "toolchains": {"go": <go version>, "rust": <rustc version>}}
//   baseline.json           the copy of the baseline record that the session read
//   sidecar-revisions.json  the copy of the sidecar revision record of the workspace registry
//   runs.jsonl              one run record per line, in the order of the runs:
//                           {"scenario": <scenario>, "run": <1..runs>, "application": <application>,
//                            "start": {"loadAverage": [<1 min>, <5 min>, <15 min>], "swap": {"usedBytes": <n>, "totalBytes": <n>}, "fseventsdCores": <n>},
//                            "display": {"refreshRate": <Hz>, "backingScale": <scale>} | null, "end": {"loadAverage": [<1 min>, <5 min>, <15 min>]},
//                            "installed": [{"kind": "plugin" | "sidecar", "id": <id>, "version": <version>, "sha256": <hash>}],
//                            "values": {<value id>: <number> | "passed" | "failed"},
//                            "conditions": {<target>: <the conditions that the target reported, described in scripts/benchmark-b3.mjs>},
//                            "failures": [<text>]}
//   attribution.jsonl       phase 1: the records of the runs with TRACE=1 and of the debug targets, which the judge does not read
//   outputs/, configs/      the output log and the B3_OUT file of each target, and the configuration folder of each failed run
//
// The session has the five applications: the mygo host and the two other hosts of the build `current`, and one baseline host of
// the build `baseline` for each other host. A run record whose `failures` is not empty is a failed run.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const GOALS_FILE = join(ROOT, "docs", "spec", "performance-goals.json");

/** The units of a value; a time, a CPU time and a footprint fail above, a frame rate fails below. */
const UNITS = { count: null, verdict: null, s: "above", ms: "above", KB: "above", "frames/s": "below" };
const BOUNDS = ["equals", "atMost", "atLeast", "below"];
/** The numeric run conditions; the window conditions are the content size of the window of each scenario and of the scenarios that differ. */
const CONDITIONS = ["refreshRate", "backingScale", "swapUseBelow", "fseventsdCoreBelow"];
const WINDOW_CONDITIONS = ["window", "scenarioWindows"];
const VALUE_KEYS = new Set(["id", "goal", "scenario", "target", "measurement", "unit", "over", "bound", "relative", "against", "constant"]);
const VERDICTS = new Set(["passed", "failed"]);
const HOSTS = ["mygo", "wailsv3", "tauriv2"];
const OTHER_HOSTS = ["wailsv3", "tauriv2"];

const fail = (where, text) => { throw new Error(`${where}: ${text}`); };
const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const positive = (value) => typeof value === "number" && Number.isFinite(value) && value > 0;

/** Reads the performance goals from the text of `file`, and rejects a file that does not hold the format that the judge applies. */
export function readGoals(text, file) {
  let goals;
  try { goals = JSON.parse(text); } catch (error) { fail(file, `is not JSON: ${error.message}`); }
  if (!isObject(goals) || goals.schema !== 1) fail(file, `holds schema ${JSON.stringify(goals?.schema)}, expected 1`);
  if (!Number.isInteger(goals.runs) || goals.runs < 1) fail(file, `holds runs ${JSON.stringify(goals.runs)}, expected a positive integer`);
  if (!isObject(goals.conditions)) fail(file, "holds no conditions object");
  const keys = Object.keys(goals.conditions).sort();
  const expected = [...CONDITIONS, ...WINDOW_CONDITIONS];
  if (JSON.stringify(keys) !== JSON.stringify([...expected].sort())) fail(file, `holds the conditions ${keys.join(", ")}, expected ${expected.join(", ")}`);
  for (const key of CONDITIONS) if (!positive(goals.conditions[key])) fail(file, `holds the condition ${key} ${JSON.stringify(goals.conditions[key])}, expected a positive number`);
  const isSize = (size) => isObject(size) && Object.keys(size).length === 2 && positive(size.width) && positive(size.height);
  if (!isSize(goals.conditions.window)) fail(file, `holds the condition window ${JSON.stringify(goals.conditions.window)}, expected {width, height} of positive numbers`);
  if (!isObject(goals.conditions.scenarioWindows)) fail(file, `holds the condition scenarioWindows ${JSON.stringify(goals.conditions.scenarioWindows)}, expected an object`);
  for (const [scenario, size] of Object.entries(goals.conditions.scenarioWindows)) {
    if (!isSize(size)) fail(file, `holds the window of ${scenario} ${JSON.stringify(size)}, expected {width, height} of positive numbers`);
  }
  if (!Array.isArray(goals.values) || goals.values.length === 0) fail(file, "holds no values");
  const ids = new Set();
  for (const value of goals.values) {
    const where = `${file}: value ${JSON.stringify(value?.id)}`;
    if (!isObject(value) || typeof value.id !== "string") fail(file, `holds a value without an id: ${JSON.stringify(value)}`);
    for (const key of Object.keys(value)) if (!VALUE_KEYS.has(key)) fail(where, `has the key ${key}, which the judge does not apply`);
    if (ids.has(value.id)) fail(where, "is named twice");
    ids.add(value.id);
    if (!/^G[1-8]$/.test(value.goal)) fail(where, `has the goal ${JSON.stringify(value.goal)}, expected G1 to G8`);
    if (!/^S\d+b?$/.test(value.scenario)) fail(where, `has the scenario ${JSON.stringify(value.scenario)}`);
    if (!value.id.startsWith(`${value.goal}-${value.scenario}-`)) fail(where, `does not start with its goal and scenario ${value.goal}-${value.scenario}-`);
    if (typeof value.target !== "string" || value.target === "") fail(where, "names no target");
    if (typeof value.measurement !== "string" || !/^[a-z][a-zA-Z0-9]*$/.test(value.measurement)) fail(where, `names the measurement ${JSON.stringify(value.measurement)}, expected a camelCase key of the output of its target`);
    if (!Object.hasOwn(UNITS, value.unit)) fail(where, `has the unit ${JSON.stringify(value.unit)}, expected one of ${Object.keys(UNITS).join(", ")}`);
    if (value.over !== "median" && value.over !== "each") fail(where, `is judged over ${JSON.stringify(value.over)}, expected median or each`);
    if (value.bound !== undefined) {
      const kinds = isObject(value.bound) ? Object.keys(value.bound) : [];
      if (kinds.length !== 1 || !BOUNDS.includes(kinds[0])) fail(where, `has the bound ${JSON.stringify(value.bound)}, expected one of ${BOUNDS.join(", ")}`);
      const limit = value.bound[kinds[0]];
      if (value.unit === "verdict" ? !(kinds[0] === "equals" && limit === "passed") : !(typeof limit === "number" && Number.isFinite(limit))) {
        fail(where, `has the bound ${JSON.stringify(value.bound)}, which does not fit the unit ${value.unit}`);
      }
    }
    if (value.relative !== undefined && value.relative !== true) fail(where, `has relative ${JSON.stringify(value.relative)}, expected true or no key`);
    if ((value.relative || value.against !== undefined) && UNITS[value.unit] === null) fail(where, `compares a value of the unit ${value.unit}, which has no bounded side`);
    if (value.constant !== undefined && !/^[A-Z][A-Z0-9_]*$/.test(value.constant)) fail(where, `has the constant ${JSON.stringify(value.constant)}`);
  }
  for (const scenario of Object.keys(goals.conditions.scenarioWindows)) {
    if (!goals.values.some((value) => value.scenario === scenario)) fail(file, `holds a window of ${scenario}, which no value names`);
  }
  for (const value of goals.values.filter((entry) => entry.against !== undefined)) {
    const reference = goals.values.find((entry) => entry.id === value.against);
    if (!reference) fail(`${file}: value "${value.id}"`, `is compared with ${value.against}, which the file does not hold`);
    if (reference.unit !== value.unit) fail(`${file}: value "${value.id}"`, `is compared with ${value.against} of the unit ${reference.unit}`);
  }
  return goals;
}

/** Reads the session folder `folder`: session.json and the run records of runs.jsonl. */
export function readSession(folder) {
  const sessionFile = join(folder, "session.json");
  let session;
  try { session = JSON.parse(readFileSync(sessionFile, "utf8")); } catch (error) { fail(sessionFile, `cannot be read: ${error.message}`); }
  const runsFile = join(folder, "runs.jsonl");
  let text;
  try { text = readFileSync(runsFile, "utf8"); } catch (error) { fail(runsFile, `cannot be read: ${error.message}`); }
  const records = text.split("\n").filter((line) => line !== "").map((line, index) => {
    try { return JSON.parse(line); } catch (error) { return fail(`${runsFile}:${index + 1}`, `is not JSON: ${error.message}`); }
  });
  if (!isObject(session) || session.schema !== 1) fail(sessionFile, `holds schema ${JSON.stringify(session?.schema)}, expected 1`);
  return { ...session, records, folder };
}

/**
 * The failures of the start conditions of `goals` in the readings `start` of a run: swap use below its share of the swap total, where a
 * swap total of zero holds no swap in use, the CPU share of fseventsd below its share of a core, and a load average.
 */
export function startConditionFailures(goals, start) {
  const failures = [];
  const { swapUseBelow, fseventsdCoreBelow } = goals.conditions;
  const swap = start?.swap;
  if (!(Number.isFinite(swap?.usedBytes) && swap.usedBytes >= 0 && Number.isFinite(swap?.totalBytes) && swap.totalBytes >= 0)) {
    failures.push(`the run records no swap use (${JSON.stringify(swap)})`);
  } else if (!(swap.usedBytes === 0 || swap.usedBytes < swapUseBelow * swap.totalBytes)) {
    failures.push(`swap use ${swap.usedBytes} B is not below ${swapUseBelow} of the swap total ${swap.totalBytes} B`);
  }
  const cores = start?.fseventsdCores;
  if (!Number.isFinite(cores)) failures.push(`the run records no CPU share of fseventsd (${JSON.stringify(cores)})`);
  else if (!(cores < fseventsdCoreBelow)) failures.push(`fseventsd uses ${cores} of a core, not below ${fseventsdCoreBelow}`);
  if (!isLoadAverage(start?.loadAverage)) failures.push(`the run records no load average at its start (${JSON.stringify(start?.loadAverage)})`);
  return failures;
}

/** The failures of the display conditions of `goals` in the display `display` of a run: its refresh rate and the backing scale of its window. */
export function displayFailures(goals, display) {
  const failures = [];
  if (display?.refreshRate !== goals.conditions.refreshRate) failures.push(`the display mode runs at ${JSON.stringify(display?.refreshRate)} Hz, expected ${goals.conditions.refreshRate} Hz`);
  if (display?.backingScale !== goals.conditions.backingScale) failures.push(`the backing scale of the window is ${JSON.stringify(display?.backingScale)}, expected ${goals.conditions.backingScale}`);
  return failures;
}

/** The content size of the window of `scenario` in points, which the run conditions of `goals` give. */
export function scenarioWindow(goals, scenario) {
  return goals.conditions.scenarioWindows[scenario] ?? goals.conditions.window;
}

/**
 * The failures of the conditions that a target of `scenario` reported for its measurement: its refresh rate and its backing scale
 * against the run conditions, and the content size of its window against the window of the scenario.
 */
export function targetConditionFailures(goals, scenario, conditions) {
  const failures = displayFailures(goals, conditions);
  const expected = scenarioWindow(goals, scenario);
  const window = conditions?.window;
  if (window?.width !== expected.width || window?.height !== expected.height) {
    failures.push(`the window is ${window?.width}×${window?.height} points, expected ${expected.width}×${expected.height} points`);
  }
  return failures;
}

const isLoadAverage = (load) => Array.isArray(load) && load.length === 3 && load.every(Number.isFinite);

/**
 * The failures of the run conditions of `goals` in a run record: its start conditions, its display, the display and the window that
 * each of its targets reported and its load average at its end.
 */
export function runConditionFailures(goals, record) {
  const failures = [...startConditionFailures(goals, record.start), ...displayFailures(goals, record.display)];
  if (!isObject(record.conditions)) failures.push(`the run records no conditions of its targets (${JSON.stringify(record.conditions)})`);
  else for (const [target, conditions] of Object.entries(record.conditions)) failures.push(...targetConditionFailures(goals, record.scenario, conditions).map((text) => `${target}: ${text}`));
  if (!isLoadAverage(record.end?.loadAverage)) failures.push(`the run records no load average at its end (${JSON.stringify(record.end?.loadAverage)})`);
  return failures;
}

/** The median of numbers. */
export function median(numbers) {
  const sorted = [...numbers].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** The spread of numbers: their lowest and their highest. */
export const spread = (numbers) => ({ low: Math.min(...numbers), high: Math.max(...numbers) });

/** Whether the spread `a` lies wholly on the bounded side `side` ("above" or "below") of the spread `b`. */
export function whollyBeyond(a, b, side) {
  return side === "above" ? a.low > b.high : a.high < b.low;
}

/** Whether one number or verdict meets a bound `{kind: limit}`. */
export function meetsBound(bound, measured) {
  const [[kind, limit]] = Object.entries(bound);
  if (kind === "equals") return measured === limit;
  if (kind === "atMost") return measured <= limit;
  if (kind === "atLeast") return measured >= limit;
  return measured < limit;
}

const BOUND_TEXT = { equals: "equals", atMost: "at most", atLeast: "at least", below: "below" };
const boundText = (value) => {
  const [[kind, limit]] = Object.entries(value.bound);
  return `${BOUND_TEXT[kind]} ${limit}${value.unit === "verdict" || value.unit === "count" ? "" : ` ${value.unit}`}`;
};
const spreadText = ({ low, high }) => `${low}..${high}`;

/** Checks the applications of a session: the mygo host, the two other hosts and one baseline host of each other host. */
function sessionApplications(session) {
  const applications = session.applications;
  if (!Array.isArray(applications)) fail("session.json", `holds the applications ${JSON.stringify(applications)}, expected a list`);
  const find = (host, build) => applications.filter((entry) => entry.host === host && entry.build === build);
  const roles = { mygo: find("mygo", "current"), others: OTHER_HOSTS.map((host) => find(host, "current")), baselines: OTHER_HOSTS.map((host) => find(host, "baseline")) };
  const expected = [roles.mygo, ...roles.others, ...roles.baselines];
  if (applications.length !== 5 || expected.some((list) => list.length !== 1) || applications.some((entry) => !HOSTS.includes(entry.host))) {
    fail("session.json", `holds the applications ${JSON.stringify(applications)}, expected the mygo host, the Wails and the Tauri host of the build current and the Wails and the Tauri host of the build baseline`);
  }
  const names = applications.map((entry) => entry.name);
  if (new Set(names).size !== names.length || names.some((name) => typeof name !== "string" || name === "")) fail("session.json", `names the applications ${JSON.stringify(names)}`);
  return {
    mygo: roles.mygo[0].name,
    others: roles.others.map(([entry]) => entry.name),
    baselineOf: Object.fromEntries(OTHER_HOSTS.map((host, index) => [roles.others[index][0].name, roles.baselines[index][0].name])),
    compared: [...roles.others, ...roles.baselines].map(([entry]) => entry.name),
  };
}

/**
 * Judges a session against the goals and returns `{lines, failures}`: one line for each value of each application with its runs,
 * its median and its spread, one line for each criterion with its result, one line for each failed run or missing reading, and one
 * line `not measured` for each value that an application records in no run and that no criterion needs of it.
 */
export function judgeSession(goals, session) {
  const lines = [];
  let failures = 0;
  const failed = (line) => { failures += 1; lines.push(`failed ${line}`); };
  const apps = sessionApplications(session);
  if (session.runs !== goals.runs) failed(`session: it holds ${JSON.stringify(session.runs)} runs of each application, the goals require ${goals.runs}`);
  const scenarios = new Set(goals.values.map((value) => value.scenario));
  const names = new Set(session.applications.map((entry) => entry.name));
  const ids = new Set(goals.values.map((value) => value.id));
  const readings = new Map();
  const seen = new Set();
  for (const record of session.records) {
    const where = `run ${record.run} of ${record.application} in ${record.scenario}`;
    if (!scenarios.has(record.scenario) || !names.has(record.application) || !Number.isInteger(record.run) || record.run < 1 || record.run > session.runs) {
      failed(`${where}: the session has no such scenario, application or run`);
      continue;
    }
    if (seen.has(where)) {
      failed(`${where}: the session records it twice`);
      continue;
    }
    seen.add(where);
    if (!Array.isArray(record.failures)) failed(`${where}: it records no list of failures (${JSON.stringify(record.failures)})`);
    // A failed run fails the session with the failures that it recorded; the run conditions are applied to each run that recorded none.
    else if (record.failures.length > 0) for (const text of record.failures) failed(`${where}: ${text}`);
    else for (const text of runConditionFailures(goals, record)) failed(`${where}: ${text}`);
    for (const [id, measured] of Object.entries(record.values ?? {})) {
      const value = goals.values.find((entry) => entry.id === id);
      if (!ids.has(id) || value.scenario !== record.scenario) {
        failed(`${where}: it records ${id}, which is no value of ${record.scenario}`);
        continue;
      }
      const valid = value.unit === "verdict" ? VERDICTS.has(measured) : typeof measured === "number" && Number.isFinite(measured);
      if (!valid) {
        failed(`${where}: it records ${id} as ${JSON.stringify(measured)}, which is no ${value.unit === "verdict" ? "verdict" : "number"}`);
        continue;
      }
      readings.set(`${id}\n${record.application}`, [...(readings.get(`${id}\n${record.application}`) ?? []), { run: record.run, measured }]);
    }
  }
  // The runs of a value of an application in run order, or null after a line that names the missing runs.
  const runsOf = (value, application) => {
    const found = (readings.get(`${value.id}\n${application}`) ?? []).sort((a, b) => a.run - b.run);
    if (found.length !== session.runs) {
      failed(`${value.id} ${application}: the session records ${found.length} of its ${session.runs} runs`);
      return null;
    }
    return found.map((entry) => entry.measured);
  };
  const described = new Map();
  const describe = (value, application) => {
    const key = `${value.id}\n${application}`;
    if (!described.has(key)) {
      const runs = runsOf(value, application);
      described.set(key, runs);
      if (runs !== null) {
        const numeric = value.unit !== "verdict";
        lines.push(`value ${value.id} ${application}: runs ${runs.join(" ")}${numeric ? `, median ${median(runs)}, spread ${spreadText(spread(runs))}` : ""}`);
      }
    }
    return described.get(key);
  };
  for (const value of goals.values) {
    const mine = describe(value, apps.mygo);
    if (value.bound !== undefined && mine !== null) {
      const measured = value.over === "median" ? [median(mine)] : mine;
      const missed = measured.filter((entry) => !meetsBound(value.bound, entry));
      const text = `${value.id} ${apps.mygo}: ${value.over === "median" ? `median ${measured[0]}` : `runs ${mine.join(" ")}`}, ${boundText(value)}`;
      if (missed.length === 0) lines.push(`passed ${text}`);
      else failed(text);
    }
    if (value.relative && mine !== null) {
      const side = UNITS[value.unit];
      for (const other of apps.compared) {
        const theirs = describe(value, other);
        if (theirs === null) continue;
        const beyond = whollyBeyond(spread(mine), spread(theirs), side);
        const text = `${value.id} ${apps.mygo} against ${other}: spread ${spreadText(spread(mine))} against ${spreadText(spread(theirs))}, ${beyond ? "" : "not "}wholly ${side}`;
        if (beyond) failed(text);
        else lines.push(`passed ${text}`);
      }
    }
    if (value.relative) {
      const side = UNITS[value.unit];
      for (const other of apps.others) {
        const theirs = describe(value, other);
        const base = describe(value, apps.baselineOf[other]);
        if (theirs === null || base === null) continue;
        const beyond = whollyBeyond(spread(theirs), spread(base), side);
        const text = `${value.id} regression of ${other} against ${apps.baselineOf[other]}: spread ${spreadText(spread(theirs))} against ${spreadText(spread(base))}, ${beyond ? "" : "not "}wholly ${side}`;
        if (beyond) failed(text);
        else lines.push(`passed ${text}`);
      }
    }
    if (value.against !== undefined && mine !== null) {
      const reference = describe(goals.values.find((entry) => entry.id === value.against), apps.mygo);
      if (reference === null) continue;
      const beyond = whollyBeyond(spread(mine), spread(reference), "above");
      const text = `${value.id} ${apps.mygo} against ${value.against}: spread ${spreadText(spread(mine))} against ${spreadText(spread(reference))}, ${beyond ? "" : "not "}wholly above`;
      if (beyond) failed(text);
      else lines.push(`passed ${text}`);
    }
  }
  // The readings that no criterion compares, such as a value of an other host that only the mygo host is judged by, are printed too.
  for (const key of readings.keys()) {
    const [id, application] = key.split("\n");
    describe(goals.values.find((entry) => entry.id === id), application);
  }
  // A value that a host records in no run has no result: no line of the runs above says so, so this line does. The missing readings of
  // a host that a criterion needs already failed above.
  for (const value of goals.values) {
    for (const { name } of session.applications) {
      if (!described.has(`${value.id}\n${name}`)) lines.push(`not measured ${value.id} ${name}`);
    }
  }
  return { lines, failures };
}

function main(argv) {
  const { values } = parseArgs({ args: argv, strict: true, options: { session: { type: "string" } } });
  if (values.session === undefined) throw new Error("--session names the session folder of make benchmark-b3");
  const goals = readGoals(readFileSync(GOALS_FILE, "utf8"), "docs/spec/performance-goals.json");
  const { lines, failures } = judgeSession(goals, readSession(values.session));
  for (const line of lines) process.stdout.write(`${line}\n`);
  process.stdout.write(`${failures === 0 ? "passed" : "failed"} session ${values.session}: ${failures} failure${failures === 1 ? "" : "s"}\n`);
  return failures === 0 ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
