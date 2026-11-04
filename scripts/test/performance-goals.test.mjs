// The performance goals of the three hosts (docs/spec/hosts.md#performance-goals): docs/spec/performance-goals.json holds their
// numeric bounds, and the tables of the section Performance goals of docs/spec/hosts.md and of docs/spec/hosts.ko.md are copies of
// that file. Each test renders the rows of the file in the language of a document and compares them with the rows of its tables.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { B3_MEASUREMENTS as BENCHMARK_MEASUREMENTS, B3_SETTINGS as BENCHMARK_SETTINGS } from "../../e2e/benchmark/measurements.mjs";
import { ATTRIBUTION_TRACE, benchmarkOf, measuredSettings, RUN_TRACE, traceStateOf } from "../e2e-b3.mjs";
import { B3_MEASUREMENTS as APP_USAGE_MEASUREMENTS } from "../measure-app-usage.mjs";
import { B3_MEASUREMENTS as HOST_ALLOCATION_MEASUREMENTS } from "../measure-host-allocations.mjs";
import { B3_MEASUREMENTS as OBJECT_COUNT_MEASUREMENTS } from "../measure-object-counts.mjs";
import { B3_MEASUREMENTS as TERMINAL_REDRAW_MEASUREMENTS } from "../measure-terminal-redraw.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const FILE = "docs/spec/performance-goals.json";
const read = (path) => readFileSync(join(ROOT, path), "utf8");

/** The words of the rendered rows in each language. */
const WORDS = {
  en: {
    conditions: {
      runs: (n) => ["Runs of each application in a session", `${n}`],
      refreshRate: (n) => ["Refresh rate of the display mode", `${n} Hz`],
      backingScale: (n) => ["Backing scale of each window", `${n}`],
      swapUseBelow: (n) => ["Swap use at the start of a run", `below ${n} of the swap total`],
      fseventsdCoreBelow: (n) => ["CPU share of `fseventsd` at the start of a run", `below ${n} of a core`],
      window: (size) => [["Content size of the window of each scenario", `${size.width}×${size.height} points`]],
      scenarioWindows: (sizes) => Object.entries(sizes).map(([scenario, size]) => [`Content size of the window of ${scenario}`, `${size.width}×${size.height} points`]),
    },
    over: { median: "median", each: "each run" },
    bound: {
      equals: (n, unit) => (unit === "verdict" ? n : `equals ${n}`),
      atMost: (n, unit) => `at most ${n} ${unit}`,
      atLeast: (n, unit) => `at least ${n} ${unit}`,
      below: (n, unit) => `below ${n} ${unit}`,
    },
    relative: "each other host and baseline host",
  },
  ko: {
    conditions: {
      runs: (n) => ["session에서 각 application의 run 수", `${n}`],
      refreshRate: (n) => ["display mode의 refresh rate", `${n} Hz`],
      backingScale: (n) => ["각 window의 backing scale", `${n}`],
      swapUseBelow: (n) => ["run 시작 시 swap 사용량", `swap 전체의 ${n} 미만`],
      fseventsdCoreBelow: (n) => ["run 시작 시 `fseventsd`의 CPU 비율", `core 하나의 ${n} 미만`],
      window: (size) => [["각 scenario의 window content 크기", `${size.width}×${size.height} point`]],
      scenarioWindows: (sizes) => Object.entries(sizes).map(([scenario, size]) => [`${scenario}의 window content 크기`, `${size.width}×${size.height} point`]),
    },
    over: { median: "median", each: "각 run" },
    bound: {
      equals: (n, unit) => (unit === "verdict" ? n : `정확히 ${n}`),
      atMost: (n, unit) => `${n} ${unit} 이하`,
      atLeast: (n, unit) => `${n} ${unit} 이상`,
      below: (n, unit) => `${n} ${unit} 미만`,
    },
    relative: "각 other host와 baseline host",
  },
};

/** The rows of the run condition table and of the value table that the file gives in the language `lang`. */
function renderedRows(goals, lang) {
  const words = WORDS[lang];
  // A condition renders one row, and a window condition the rows of its sizes.
  const condition = (key, n) => {
    const render = words.conditions[key];
    assert.ok(render, `${FILE} holds the condition ${key}, which the test does not render`);
    return typeof n === "object" ? render(n) : [render(n)];
  };
  const conditions = [...condition("runs", goals.runs), ...Object.entries(goals.conditions).flatMap(([key, n]) => condition(key, n))];
  const values = goals.values.map((value) => {
    const entries = Object.entries(value.bound ?? {});
    assert.ok(entries.length <= 1, `${value.id} has ${entries.length} bounds`);
    const bound = entries.map(([kind, n]) => {
      const render = words.bound[kind];
      assert.ok(render, `${value.id} has the bound ${kind}, which the test does not render`);
      return `${render(n, value.unit)}${value.constant === undefined ? "" : ` (\`${value.constant}\`)`}`;
    })[0] ?? "—";
    const compared = value.relative ? words.relative : value.against === undefined ? "—" : `\`${value.against}\``;
    return [`\`${value.id}\``, value.goal, value.scenario, `\`${value.target}\``, `\`${value.measurement}\``, value.unit, words.over[value.over], bound, compared];
  });
  return { conditions, values };
}

/** The cells of each table row of the section `## Performance goals` of a document, by table, without the header and rule rows. */
function documentTables(text, path) {
  const start = text.indexOf("\n## Performance goals\n");
  assert.notEqual(start, -1, `${path} has no section Performance goals`);
  const end = text.indexOf("\n## ", start + 1);
  const section = text.slice(start, end === -1 ? undefined : end);
  const tables = [];
  let rows = null;
  for (const line of section.split("\n")) {
    if (!line.startsWith("|")) {
      rows = null;
      continue;
    }
    if (rows === null) {
      rows = [];
      tables.push(rows);
      continue;
    }
    if (/^\|(?:\s*-+\s*\|)+$/.test(line)) continue;
    rows.push(line.slice(1, -1).split(/(?<!\\)\|/).map((cell) => cell.trim()));
  }
  return tables;
}

test("docs/spec/performance-goals.json names each value once and compares a value only with a value that it holds", { timeout: 1000 }, () => {
  const goals = JSON.parse(read(FILE));
  const ids = goals.values.map((value) => value.id);
  assert.deepEqual(ids.filter((id, index) => ids.indexOf(id) !== index), [], "these values are named twice");
  const unknown = goals.values.filter((value) => value.against !== undefined && !ids.includes(value.against)).map((value) => value.id);
  assert.deepEqual(unknown, [], "these values are compared with a value that the file does not hold");
  const constants = goals.values.filter((value) => value.constant !== undefined).map((value) => value.constant).sort();
  assert.deepEqual(constants, ["IDLE_TAB_BOUND_KB", "SPLIT_LOAD_GROWTH_BOUND_KB"]);
});

/**
 * The ending of the measurement key of each unit: a target writes each measurement in the unit of the value that names it, and
 * its key says that unit, so a key of a count carries none of these endings and a verdict is `verdict` or ends in `Verdict`.
 */
const UNIT_ENDINGS = { s: "Seconds", ms: "Ms", KB: "Kb", "frames/s": "PerSecond", verdict: "Verdict" };

test("each value of docs/spec/performance-goals.json names the measurement of its target that holds it, once in that target and in the unit of the value", { timeout: 1000 }, () => {
  const goals = JSON.parse(read(FILE));
  const failures = [];
  const keys = new Map();
  for (const value of goals.values) {
    const key = value.measurement;
    if (typeof key !== "string" || !/^[a-z][a-zA-Z0-9]*$/.test(key)) {
      failures.push(`${value.id} names no camelCase measurement: ${JSON.stringify(key)}`);
      continue;
    }
    const ending = UNIT_ENDINGS[value.unit];
    const endings = Object.values(UNIT_ENDINGS).filter((other) => key.endsWith(other) || key === other.toLowerCase());
    if (value.unit === "count" ? endings.length > 0 : !(key.endsWith(ending) || key === ending.toLowerCase())) {
      failures.push(`${value.id} has the unit ${value.unit}, and its measurement ${key} ${value.unit === "count" ? "names a unit" : `does not end in ${ending}`}`);
    }
    const named = keys.get(`${value.target}\0${key}`);
    if (named !== undefined) failures.push(`${value.id} and ${named} name the measurement ${key} of ${value.target}`);
    keys.set(`${value.target}\0${key}`, value.id);
  }
  assert.deepEqual(failures, []);
});

/**
 * The measurement scripts of the make targets that B3 runs; the recipe of each target in the Makefile runs its script. A make target
 * of an e2e benchmark runs the benchmark of its name, and a check of e2e/ is the benchmark of its file name.
 */
const MEASUREMENT_SCRIPTS = {
  "app-usage": "scripts/measure-app-usage.mjs",
  "terminal-redraw-usage": "scripts/measure-terminal-redraw.mjs",
  "object-counts": "scripts/measure-object-counts.mjs",
  "host-allocations": "scripts/measure-host-allocations.mjs",
};

/** The recipe lines of the root make target `name`. */
function recipeOf(makefile, name) {
  const lines = makefile.split("\n");
  const start = lines.findIndex((line) => line.startsWith(`${name}:`));
  assert.notEqual(start, -1, `the Makefile has no target ${name}`);
  const recipe = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith("\t")) break;
    recipe.push(line);
  }
  return recipe.join("\n");
}

/**
 * The failures of the measurements of `values`: each measurement is a key that the declaration of its target holds in each trace
 * state in which the target measures, which traceStateOf of scripts/e2e-b3.mjs gives: the TRACE argument of the target, else both
 * RUN_TRACE of the runs of the session and ATTRIBUTION_TRACE of the runs of phase 1 for a target that takes the trace state of the
 * run. `declarations` holds the keys of each measurement script by the name of its make target
 * (`scripts`) and of each e2e benchmark (`benchmarks`). A list of keys holds the keys of every trace state that the target takes;
 * a benchmark that declares a list takes no TRACE.
 */
function measurementFailures(values, makefile, declarations) {
  const failures = [];
  for (const value of values) {
    const [command, name] = value.target.split(" ");
    const states = [...new Set([traceStateOf(value.target, RUN_TRACE), traceStateOf(value.target, ATTRIBUTION_TRACE)])];
    const [state] = states;
    let source;
    let keys;
    if (command === "make" && Object.hasOwn(MEASUREMENT_SCRIPTS, name)) {
      const script = MEASUREMENT_SCRIPTS[name];
      if (!recipeOf(makefile, name).includes(`node ${script}`)) {
        failures.push(`${value.id}: the recipe of make ${name} does not run ${script}`);
        continue;
      }
      [source, keys] = [name, declarations.scripts[name]];
    } else {
      const benchmark = benchmarkTarget(value.target, makefile);
      if (benchmark.reason !== undefined) {
        failures.push(`${value.id}: ${benchmark.reason}`);
        continue;
      }
      [source, keys] = [benchmark.name, declarations.benchmarks[benchmark.name]];
      if (keys === undefined) {
        failures.push(`${value.id}: e2e/benchmark/measurements.mjs declares no measurements of ${source}`);
        continue;
      }
      if (Array.isArray(keys) && state !== null) {
        failures.push(`${value.id}: ${value.target} names TRACE=${state}, and ${source} measures in one trace state`);
        continue;
      }
    }
    if (!Array.isArray(keys) && state === null) {
      failures.push(`${value.id}: ${value.target} names no TRACE, and ${source} measures in the trace states ${Object.keys(keys).join(" and ")}`);
      continue;
    }
    for (const each of states) {
      const held = Array.isArray(keys) ? keys : keys[String(each)];
      if (held === undefined) failures.push(`${value.id}: ${source} measures in no trace state ${each}`);
      else if (!held.includes(value.measurement)) failures.push(`${value.id}: ${value.target} declares no measurement ${value.measurement} in the trace state ${each}`);
    }
  }
  return failures;
}

/** The e2e benchmark that `target` runs (benchmarkOf of scripts/e2e-b3.mjs), whose make target runs it through its recipe. */
function benchmarkTarget(target, makefile) {
  const benchmark = benchmarkOf(target);
  if (benchmark === null) return { reason: `${target} is no target whose measurements a script declares` };
  const [command, name] = target.split(" ");
  if (command === "make" && !recipeOf(makefile, name).includes(`benchmark:${benchmark}`)) return { reason: `the recipe of make ${name} does not run the benchmark ${benchmark}` };
  return { name: benchmark };
}

/** The declarations of the targets that B3 runs: B3_MEASUREMENTS of each measurement script and of the e2e benchmarks. */
const DECLARATIONS = {
  scripts: { "app-usage": APP_USAGE_MEASUREMENTS, "terminal-redraw-usage": TERMINAL_REDRAW_MEASUREMENTS, "object-counts": OBJECT_COUNT_MEASUREMENTS,
    "host-allocations": HOST_ALLOCATION_MEASUREMENTS },
  benchmarks: BENCHMARK_MEASUREMENTS,
};

test("each measurement of docs/spec/performance-goals.json is a key that the target of its value declares in B3_MEASUREMENTS", { timeout: 1000 }, () => {
  assert.deepEqual(measurementFailures(JSON.parse(read(FILE)).values, read("Makefile"), DECLARATIONS), []);
});

test("each e2e benchmark of docs/spec/performance-goals.json measures in the settings that B3_SETTINGS declares for it and the state that its TRACE names", { timeout: 1000 }, () => {
  const benchmarks = { measurements: BENCHMARK_MEASUREMENTS, settings: BENCHMARK_SETTINGS };
  const failures = JSON.parse(read(FILE)).values.filter((value) => benchmarkOf(value.target) !== null)
    .flatMap((value) => (measuredSettings(value.target, RUN_TRACE, benchmarks).reasons ?? []).map((reason) => `${value.id}: ${reason}`));
  assert.deepEqual(failures, []);
});

test("a target that takes the trace state of the run declares its measurement in the trace states 0 and 1, and a target that names TRACE in that state", { timeout: 1000 }, () => {
  const declarations = { scripts: { "app-usage": { 0: ["applicationCpuSeconds", "hitTestP90Ms"], 1: ["applicationCpuSeconds"], "frame-records": ["hitTestP90Ms"] } }, benchmarks: {} };
  const value = (id, target, measurement) => ({ id, target, measurement });
  assert.deepEqual(measurementFailures([
    value("cpu", "make app-usage STATE=S1 STEP=pointer", "applicationCpuSeconds"),
    value("hit-test", "make app-usage STATE=S1 STEP=pointer", "hitTestP90Ms"),
    value("frame-records", "make app-usage STATE=S1 STEP=pointer TRACE=frame-records", "hitTestP90Ms"),
    value("named", "make app-usage STATE=S1 STEP=pointer TRACE=1", "hitTestP90Ms"),
  ], read("Makefile"), declarations), [
    "hit-test: make app-usage STATE=S1 STEP=pointer declares no measurement hitTestP90Ms in the trace state 1",
    "named: make app-usage STATE=S1 STEP=pointer TRACE=1 declares no measurement hitTestP90Ms in the trace state 1",
  ]);
});

/** Compares the tables of the section Performance goals of the document `path` with the rows of the file in the language `lang`. */
function assertTablesCopy(lang, path) {
  const expected = renderedRows(JSON.parse(read(FILE)), lang);
  const tables = documentTables(read(path), path);
  assert.equal(tables.length, 2, `${path} has ${tables.length} tables in the section Performance goals, expected the run conditions and the values`);
  assert.deepEqual(tables[0], expected.conditions, `the run condition table of ${path} differs from ${FILE}`);
  assert.deepEqual(tables[1], expected.values, `the value table of ${path} differs from ${FILE}`);
}

test("the tables of the section Performance goals of docs/spec/hosts.md are copies of docs/spec/performance-goals.json", { timeout: 1000 }, () => {
  assertTablesCopy("en", "docs/spec/hosts.md");
});

test("the tables of the section Performance goals of docs/spec/hosts.ko.md are copies of docs/spec/performance-goals.json", { timeout: 1000 }, () => {
  assertTablesCopy("ko", "docs/spec/hosts.ko.md");
});
