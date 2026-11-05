// Runs the three-host benchmark B3 (docs/operations/examples.md#three-host-benchmark) on this computer and writes one session folder
// that `make check-b3` judges against docs/spec/performance-goals.json:
//   node scripts/benchmark-b3.mjs --phase 1|final --runs <n> --baseline <checkout>
// `make benchmark-b3 PHASE=1|final RUNS=<n> BASELINE=<checkout>` runs it. The five applications are the mygo, the Wails and the Tauri host of
// this checkout and the Wails and the Tauri host of the BASELINE checkout, the baseline hosts. Before its first run it fails when the
// head of BASELINE differs from the last head of the baseline record or the working tree of BASELINE holds changes outside that head.
// It then builds the release bundles of the five applications, the workspace registry of the diagnostic sidecars and the index of the
// public registry (`make build-registry SIDECARS=diagnostic`, `make build-registry SIDECARS=diagnostic PLUGINS=public`), and fails when a sidecar
// revision of the registry record differs from the last revision of the baseline record for that repository or a sidecar working tree
// held changes. Phase 1 also builds the debug bundles.
//
// Each run of a scenario starts a new application from the executable of its release bundle through the steps `start`, `quit` and
// `remaining` of runPlan (scripts/test-app.mjs), in a new configuration folder under the session folder in target/b3 into which it
// installs the index of that application: the workspace registry for the mygo and the other hosts, the public index for the baseline
// hosts. S0b runs in the application that S3 leaves. A run starts only while swap use is below its share of the swap total and
// fseventsd uses less than its share of a core, and fails when the display mode or the backing scale of a window differs from the run
// conditions of docs/spec/performance-goals.json. It runs the targets of each value of the scenario in the order of the goals, the
// STEP=pointer readings last, each in the checkout of its application with `APP`, `CONFIG`, `CONFIG_DIR`, `SOK`, `PLUGINS` (the
// installed surface plugins), `B3_OUT` and, for a target that takes the trace state of the run, `TRACE`, and with the environment of
// the window checks. Before the first target it activates the first window through input.pointer, because a window opens behind the front
// and a covered window measures another state; a refused activation and a window that stays covered fail the run and measure nothing.
// The runs interleave the applications: one run of each application before the next run of any. A scenario
// whose values no other host compares runs only on the mygo host.
// Phase 1 also runs each scenario once on each application with TRACE=1 to attribute its costs, through the targets that take the
// trace state of the run and name no TRACE of their own, and runs make measure-host-calls on the other and the baseline hosts and make
// measure-trace-share on all five applications from their debug bundles.
//
// The baseline record b3/baseline.json in the git common directory of this checkout (baselineRecordFile), which the measurement target items write:
//   {"schema": 1, "heads": [<40 hex digits>, ...], "sidecars": [{"repository": <path>, "revisions": [<40 hex digits>, ...]}],
//    "plugins": [{"id": <plugin id>, "version": <version>, "sha256": <64 hex digits>}]}
// `heads` are the heads of the baseline branch in order and `revisions` the revisions of each sidecar repository in order; the last
// entry of each list is the one that a run requires. `plugins` are the plugin releases that the baseline hosts install.
// The sidecar revision record <registry>/sidecar-revisions.json of make build-registry SIDECARS=diagnostic:
//   {"sidecars": [{"repository": <path>, "revision": <40 hex digits>, "changes": <whether the working tree held changes>}]}
//
// The output of a target. Every target that B3 runs takes the file of its output: a make target as B3_OUT=<file> (a measurement
// script as --b3-out <file>, an e2e benchmark as the environment variable SOKSAK_B3_OUT) and a check of e2e/ as SOKSAK_B3_OUT, as the
// other run variables. It writes into that file one JSON object, whose form writeB3Out and readB3Out of scripts/b3-out.mjs hold and
// through which the run reads it:
//   {"measurements": {<key>: <number> | "passed" | "failed", ...},
//    "conditions": {"refreshRate": <Hz>, "backingScale": <scale>, "traceState": <diagnostics.performance over the measured interval>,
//                   "logPolicy": {<class>: <level>, ...}, "window": {"width": <points>, "height": <points>},
//                   "occluded": <whether that window is covered>, "active": <whether its application is active>}}
// The keys of "measurements" are the flat camelCase names of the measurements of the target, which its B3_MEASUREMENTS declares; a
// target knows neither the ids of the goals nor which hosts compare a value, so it writes every measurement that it makes. A target
// with an error exits with another code than 0 and writes no output, and that exit fails the run. Each value of
// docs/spec/performance-goals.json names in "measurement" the key that holds it, in the unit of the value, and the run records that
// number under the id of the value; a key that no value names is not recorded. On the mygo host every value of the target requires
// its key, on the other and the baseline hosts the values that are compared with other hosts; a missing key fails the run with the
// value, the target and the key. The verdict of a benchmark of S5 and S7 is its measurement "passed" or "failed", never its exit
// code. The run fails when a target reports a refresh rate or a backing scale other than the run conditions, a window other than
// the window of its scenario in the run conditions, a covered window in a scenario that the run conditions do not name as covered or
// a window that is not covered in one that they name, an application that is not active, or a traceState and a logPolicy other than the diagnostics.performance and the
// classes of the policy of the settings of its measured interval. A target of measure-app-usage, measure-terminal-redraw, measure-object-counts or
// measure-host-allocations measures in traceSettings (scripts/measure-trace.mjs) of the TRACE argument of its entry, which the pointer step
// of measure-app-usage names for each of the two trace states of its outputs, or else of the TRACE of the run. An e2e benchmark takes no
// TRACE of the run and measures in the settings that B3_SETTINGS of e2e/benchmark/measurements.mjs declares for it in the shape of
// its keys in B3_MEASUREMENTS of that module: one settings object for a list of keys, and for an object of states the same states,
// of which the TRACE argument of its entry names one, so it runs once in each state. A state of one that the other lacks fails the
// run and names it.
// The session folder (described in scripts/b3-judge.mjs) holds session.json, baseline.json, sidecar-revisions.json, runs.jsonl,
// attribution.jsonl of phase 1, outputs/ with the output log and the B3_OUT file of each target, and configs/ with the configuration
// folder of each failed run; a passed run removes its configuration folder.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { appendFileSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { basename, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { connect } from '@soksak/client';
import { policyOfSetting } from '@soksak/window-check/log-policy.mjs';
import { displayFailures, GOALS_FILE, readGoals, startConditionFailures, targetConditionFailures } from './b3-judge.mjs';
import { readB3Out } from './b3-out.mjs';
import { runPlan } from './test-app.mjs';
import { parseCpuTime } from './measure-app-usage.mjs';
import { FRAME_RECORDS, traceSettings } from './measure-trace.mjs';
import { B3_MEASUREMENTS, B3_SETTINGS } from '../e2e/benchmark/measurements.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
/** The platform of the releases that the applications install. */
const PLATFORM = 'darwin-arm64';
/** The interval over which the CPU share of fseventsd is read before a run. */
const FSEVENTSD_INTERVAL_S = 5;
/** The applications of a session in the order of each round of runs: name, host and build. */
const APPLICATIONS = [
  ['mygo', 'mygo', 'current'], ['wailsv3', 'wailsv3', 'current'], ['tauriv2', 'tauriv2', 'current'],
  ['baseline-wailsv3', 'wailsv3', 'baseline'], ['baseline-tauriv2', 'tauriv2', 'baseline'],
];
/** A scenario that runs in the application that another scenario leaves. */
const FOLLOWS = { S0b: 'S3' };
/** The declarations of the e2e benchmarks (e2e/benchmark/measurements.mjs): their B3_MEASUREMENTS and their B3_SETTINGS. */
export const BENCHMARKS = Object.freeze({ measurements: B3_MEASUREMENTS, settings: B3_SETTINGS });

/** The trace state of the runs of the session, which the judge reads: the trace off under the default policy. */
export const RUN_TRACE = 0;

/** The trace state of the runs of phase 1 that attribute the costs of each scenario: the trace on. */
export const ATTRIBUTION_TRACE = 1;

/** The targets that take TRACE, which phase 1 also runs with TRACE=1 when their entry names no TRACE. */
const TRACE_TARGETS = ['measure-app-usage', 'measure-terminal-redraw', 'measure-object-counts', 'measure-host-allocations'];
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;

const fail = (where, text) => { throw new Error(`${where}: ${text}`); };
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

/**
 * The file of the baseline record of the checkout `root`: in its git common directory, beside the refs of the baseline branch whose heads it
 * holds. Every worktree of the checkout shares it, a clean of the build outputs does not remove it, and it is never a record of the repository.
 */
export function baselineRecordFile(root) {
  const common = execFileSync('git', ['-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim();
  return join(common, 'b3', 'baseline.json');
}

/** Reads the baseline record from the text of `file`. */
export function readBaselineRecord(text, file) {
  let record;
  try { record = JSON.parse(text); } catch (error) { fail(file, `is not JSON: ${error.message}`); }
  if (!isObject(record) || record.schema !== 1) fail(file, `holds schema ${JSON.stringify(record?.schema)}, expected 1`);
  if (!Array.isArray(record.heads) || record.heads.length === 0 || !record.heads.every((head) => HEX40.test(head))) {
    fail(file, `holds the heads ${JSON.stringify(record.heads)}, expected a list of revisions of 40 hexadecimal digits`);
  }
  if (!Array.isArray(record.sidecars)) fail(file, 'holds no list of sidecars');
  for (const entry of record.sidecars) {
    if (!isObject(entry) || typeof entry.repository !== 'string' || !Array.isArray(entry.revisions) || entry.revisions.length === 0
      || !entry.revisions.every((revision) => HEX40.test(revision))) fail(file, `holds the sidecar ${JSON.stringify(entry)}, expected a repository and its revisions`);
  }
  const repositories = record.sidecars.map((entry) => entry.repository);
  if (new Set(repositories).size !== repositories.length) fail(file, `names a sidecar repository twice: ${repositories.join(', ')}`);
  if (!Array.isArray(record.plugins)) fail(file, 'holds no list of plugins');
  for (const entry of record.plugins) {
    if (!isObject(entry) || typeof entry.id !== 'string' || typeof entry.version !== 'string' || !HEX64.test(entry.sha256)) {
      fail(file, `holds the plugin ${JSON.stringify(entry)}, expected an id, a version and a sha256 of 64 hexadecimal digits`);
    }
  }
  const ids = record.plugins.map((entry) => entry.id);
  if (new Set(ids).size !== ids.length) fail(file, `names a plugin twice: ${ids.join(', ')}`);
  return record;
}

/** Reads the sidecar revision record of the workspace registry from the text of `file`. */
export function readSidecarRevisions(text, file) {
  let record;
  try { record = JSON.parse(text); } catch (error) { fail(file, `is not JSON: ${error.message}`); }
  if (!isObject(record) || !Array.isArray(record.sidecars)) fail(file, 'holds no list of sidecars');
  for (const entry of record.sidecars) {
    if (!isObject(entry) || typeof entry.repository !== 'string') fail(file, `holds the sidecar ${JSON.stringify(entry)} without a repository`);
    if (!HEX40.test(entry.revision)) fail(file, `sidecar ${entry.repository} has the revision ${JSON.stringify(entry.revision)}, expected 40 hexadecimal digits`);
    if (typeof entry.changes !== 'boolean') fail(file, `sidecar ${entry.repository} has changes ${JSON.stringify(entry.changes)}, expected true or false`);
  }
  return record;
}

/** The head of the checkout `path` and the lines of `git status --porcelain` of its working tree, untracked files among them. */
export function readCheckout(path) {
  const git = (...args) => execFileSync('git', ['-C', path, ...args], { encoding: 'utf8' });
  return {
    head: git('rev-parse', 'HEAD').trim(),
    status: git('status', '--porcelain', '--untracked-files=all').split('\n').map((line) => line.trim()).filter((line) => line !== ''),
  };
}

/** The failures of the BASELINE checkout `path` against the baseline record: its head and the changes of its working tree. */
export function baselineCheckoutFailures(record, { head, status }, path) {
  const failures = [];
  const last = record.heads.at(-1);
  if (head !== last) failures.push(`the head ${head} of ${path} differs from the last head ${last} of the baseline record`);
  if (status.length > 0) failures.push(`the working tree of ${path} holds changes outside its head ${head}: ${status.join('; ')}`);
  return failures;
}

/** The failures of the sidecar revision record of the workspace registry against the last revision of each repository of the baseline record. */
export function sidecarRevisionFailures(record, revisions) {
  const failures = [];
  for (const entry of revisions.sidecars) {
    const baseline = record.sidecars.find((item) => item.repository === entry.repository);
    if (!baseline) {
      failures.push(`the registry built ${entry.repository}, for which the baseline record holds no revision`);
      continue;
    }
    const last = baseline.revisions.at(-1);
    if (entry.revision !== last) failures.push(`the registry built ${entry.repository} at ${entry.revision}, which differs from the last revision ${last} of the baseline record`);
    if (entry.changes) failures.push(`the working tree of ${entry.repository} held changes outside ${entry.revision} when the registry built it`);
  }
  for (const baseline of record.sidecars) {
    if (!revisions.sidecars.some((entry) => entry.repository === baseline.repository)) {
      failures.push(`the registry built no revision of ${baseline.repository}, which the baseline record holds`);
    }
  }
  return failures;
}

/**
 * The releases that a configuration folder installed: each plugin and sidecar of its `plugins/installed.json` (null when the file is
 * absent, which installs nothing) with its version and the sha256 of its release in the index that it installed from.
 */
export function installedReleases(installed, index, platform) {
  if (installed === null) return [];
  const plugins = Object.entries(installed.plugins).sort(([a], [b]) => a.localeCompare(b)).map(([id, entry]) => {
    const release = index.plugins.find((plugin) => plugin.id === id)?.versions.find((item) => item.version === entry.version)?.release;
    if (!release) throw new Error(`the index lists no release of ${id} ${entry.version}`);
    return { kind: 'plugin', id, version: entry.version, sha256: release.sha256 };
  });
  const sidecars = Object.entries(installed.sidecars).sort(([a], [b]) => a.localeCompare(b)).map(([name, entry]) => {
    const release = index.sidecars.find((sidecar) => sidecar.name === name)?.versions.find((item) => item.version === entry.version)?.releases[platform];
    if (!release) throw new Error(`the index lists no release of ${name} ${entry.version} for ${platform}`);
    return { kind: 'sidecar', id: name, version: entry.version, sha256: release.sha256 };
  });
  return [...plugins, ...sidecars];
}

/** The failures of the plugin releases that a baseline host installed against the plugins of the baseline record. */
export function baselinePluginFailures(record, releases) {
  const failures = [];
  const plugins = releases.filter((release) => release.kind === 'plugin');
  for (const release of plugins) {
    const expected = record.plugins.find((entry) => entry.id === release.id);
    if (!expected) failures.push(`the baseline host installed ${release.id} ${release.version} ${release.sha256}, which the baseline record does not hold`);
    else if (expected.version !== release.version || expected.sha256 !== release.sha256) {
      failures.push(`the baseline host installed ${release.id} ${release.version} ${release.sha256}, the baseline record holds ${expected.id} ${expected.version} ${expected.sha256}`);
    }
  }
  for (const expected of record.plugins) {
    if (!plugins.some((release) => release.id === expected.id)) failures.push(`the baseline host installed no release of ${expected.id}, which the baseline record holds`);
  }
  return failures;
}

/** The installed plugins whose `plugin.json` declares a surface, by id; `readManifest(path)` reads the manifest in a recorded folder. */
export function surfacePlugins(installed, readManifest) {
  if (installed === null) return [];
  return Object.entries(installed.plugins).filter(([, entry]) => readManifest(entry.path).surface !== undefined).map(([id]) => id).sort();
}

const SIZE_UNITS = { K: 1024, M: 1024 ** 2, G: 1024 ** 3 };

/** The swap use and the swap total, in bytes, of the output of `sysctl -n vm.swapusage`. */
export function parseSwapUsage(text) {
  const match = /total = ([\d.]+)([KMG])\s+used = ([\d.]+)([KMG])/.exec(text);
  if (!match) throw new Error(`sysctl vm.swapusage printed ${JSON.stringify(text.trim())}, which names no total and no used size`);
  return { usedBytes: Number(match[3]) * SIZE_UNITS[match[4]], totalBytes: Number(match[1]) * SIZE_UNITS[match[2]] };
}

/** The CPU time of fseventsd in hundredths of a second in the output of `ps -axo pid=,time=,comm=`, with its process identifier. */
function fseventsdTime(text) {
  const line = text.split('\n').map((entry) => entry.trim().split(/\s+/)).find((fields) => fields.length >= 3 && basename(fields.slice(2).join(' ')) === 'fseventsd');
  if (!line) throw new Error('the process list holds no fseventsd process');
  return { pid: Number(line[0]), centiseconds: Math.round(parseCpuTime(line[1]) * 100) };
}

/** The share of a core that fseventsd used between two process lists `seconds` apart. */
export function fseventsdCores(before, after, seconds) {
  const first = fseventsdTime(before);
  const second = fseventsdTime(after);
  if (first.pid !== second.pid) throw new Error(`fseventsd changed from process ${first.pid} to process ${second.pid} while its CPU time was read`);
  return (second.centiseconds - first.centiseconds) / 100 / seconds;
}

/** The five applications of a session with the paths of their release bundles and the index that each installs. */
export function applicationsOf({ root, baseline }, build = 'release') {
  return APPLICATIONS.map(([name, host, kind]) => {
    const checkout = kind === 'baseline' ? baseline : root;
    // The baseline branch keeps the host code of its revision, whose executables carry the name of that revision.
    const executable = kind === 'baseline' ? `soksak-${host}` : `sok-${host}`;
    const bundle = build === 'release' ? join(checkout, 'target', 'release', host, 'soksak.app') : join(checkout, 'target', 'debug', `${executable}.app`);
    return {
      name, host, build: kind, checkout, bundle,
      executable: join(bundle, 'Contents', 'MacOS', executable), sok: join(bundle, 'Contents', 'MacOS', 'sok'),
      index: join(root, 'target', kind === 'baseline' ? 'registry-public' : 'registry', 'index.json'),
    };
  });
}

/** The scenarios of the goals in their order, S1 before S2 and S10 after S9, each with the scenarios that run in the application that it leaves. */
function scenarioGroups(goals) {
  const number = (scenario) => Number(/^S(\d+)/.exec(scenario)[1]);
  const scenarios = [...new Set(goals.values.map((value) => value.scenario))].sort((a, b) => number(a) - number(b) || a.localeCompare(b));
  return scenarios.filter((scenario) => FOLLOWS[scenario] === undefined)
    .map((scenario) => [scenario, ...scenarios.filter((other) => FOLLOWS[other] === scenario)]);
}

/**
 * The runs of a session in order: for each scenario, `runs` rounds, each with one run of every application that the scenario runs on.
 * A scenario runs on every application when one of its values is compared with the other hosts, and otherwise only on the mygo host.
 */
export function sessionUnits(goals, runs, applications) {
  const units = [];
  for (const scenarios of scenarioGroups(goals)) {
    const compared = goals.values.some((value) => scenarios.includes(value.scenario) && value.relative);
    const runsOn = compared ? applications : applications.filter((entry) => entry.host === 'mygo' && entry.build === 'current');
    for (let run = 1; run <= runs; run += 1) for (const application of runsOn) units.push({ scenarios, run, application });
  }
  return units;
}

/** The targets of the values of a scenario in the order of the goals, each once, with the STEP=pointer readings after every other one. */
export function scenarioTargets(goals, scenario) {
  const targets = [...new Set(goals.values.filter((value) => value.scenario === scenario).map((value) => value.target))];
  const pointer = (target) => target.split(' ').includes('STEP=pointer');
  return [...targets.filter((target) => !pointer(target)), ...targets.filter(pointer)];
}

/**
 * The command of a target for one run of an application: its argv, its folder, its environment and the file `out` of its output, which
 * a make target takes as B3_OUT=<file> and a check of e2e/ as the environment variable SOKSAK_B3_OUT.
 */
export function targetCommand(target, { application, configRoot, configDir, trace, out, plugins, runId, runFolder }) {
  const words = target.split(' ');
  const env = {
    SOKSAK_CONFIG_ROOT: configRoot, SOKSAK_APP: application.host, [`SOKSAK_BINARY_${application.host.toUpperCase()}`]: application.executable,
    SOKSAK_RUN_ID: runId, SOKSAK_RUN_FOLDER: runFolder,
  };
  if (words[0] === 'make') {
    return {
      argv: ['make', '-s', '--no-print-directory', ...words.slice(1), `APP=${application.host}`, `CONFIG=${configDir}`, `CONFIG_DIR=${configDir}`,
        `SOK=${application.sok}`, ...(takesRunTrace(target) ? [`TRACE=${trace}`] : []), `PLUGINS=${plugins.join(' ')}`, `B3_OUT=${out}`],
      cwd: application.checkout, env, out,
    };
  }
  const check = /^e2e\/([\w./-]+\.test\.mjs)$/.exec(target);
  if (words.length === 1 && check) {
    return {
      argv: ['pnpm', '-F', '@soksak/e2e', 'exec', 'node', './run.mjs', '--test', '--test-concurrency=1', '--test-global-setup=./setup.mjs', check[1]],
      cwd: application.checkout, env: { ...env, SOKSAK_B3_OUT: out }, out,
    };
  }
  throw new Error(`the target ${JSON.stringify(target)} is neither a make target nor a check of e2e/`);
}

/** The steps of runPlan of one run: the installation of the index and the start of the application, then its quit and the remaining check. */
export function unitPlan({ application, configRoot, configDir, pluginIds }) {
  const { name } = application;
  return {
    prepare: [
      { name: `registry use ${name}`, phase: 'prepare', kind: 'run', argv: [application.sok, 'registry', 'use', application.index, '--config-dir', configDir], env: {} },
      ...pluginIds.map((id) => ({ name: `install ${id} ${name}`, phase: 'prepare', kind: 'run', argv: [application.sok, 'plugin', 'install', id, '--config-dir', configDir], env: {} })),
      { name: `start ${name}`, phase: 'prepare', kind: 'start', app: name, configDir, output: join(configRoot, `${name}.out`), argv: [application.executable, '--config-dir', configDir] },
    ],
    cleanup: [
      { name: `quit ${name}`, phase: 'cleanup', kind: 'quit', app: name, configDir },
      { name: 'remaining processes', phase: 'cleanup', kind: 'remaining', paths: [configRoot, application.bundle] },
    ],
  };
}

/** Reads the text of a TRACE argument: 0, 1 or the trace state of the frame records. */
function parseTraceState(text, target) {
  if (text === '0' || text === '1') return Number(text);
  if (text === FRAME_RECORDS) return FRAME_RECORDS;
  throw new Error(`${target} names TRACE=${text}, expected 0, 1 or ${FRAME_RECORDS}`);
}

/** Whether `target` takes the trace state of the run: a target of TRACE_TARGETS whose entry names no TRACE. */
function takesRunTrace(target) {
  const [command, name, ...args] = target.split(' ');
  return command === 'make' && TRACE_TARGETS.includes(name) && !args.some((arg) => arg.startsWith('TRACE='));
}

/**
 * The trace state of the measurement of a target: the TRACE argument that its entry names, else the trace state `trace` of the run
 * for a target that takes TRACE, else null. The TRACE of a target of TRACE_TARGETS is 0, 1 or the state of the frame records; the
 * TRACE of an e2e benchmark names one of the states of its declarations, such as the state of each output of a benchmark that
 * measures in two.
 */
export function traceStateOf(target, trace) {
  const words = target.split(' ');
  const named = words.find((word) => word.startsWith('TRACE='));
  if (named === undefined) return takesRunTrace(target) ? trace : null;
  const text = named.slice('TRACE='.length);
  return words[0] === 'make' && TRACE_TARGETS.includes(words[1]) ? parseTraceState(text, target) : text;
}

/** The e2e benchmark that `target` runs: make benchmark-<name> runs <name>, and a check of e2e/ is the benchmark of its file name. */
export function benchmarkOf(target) {
  const [command, name] = target.split(' ');
  if (command === 'make') return name.startsWith('benchmark-') ? name.slice('benchmark-'.length) : null;
  const check = /^e2e\/(?:benchmark\/)?([\w-]+)\.test\.mjs$/.exec(command);
  return name === undefined && check ? check[1] : null;
}

/** The form of one settings object of B3_SETTINGS: the performance switch and the log setting of a measured interval. */
const SETTINGS_FORM = '{"diagnostics.performance": boolean, "diagnostics.log": {class: level}}';

/** Whether `value` is one settings object of SETTINGS_FORM. */
function isSettings(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && isDeepStrictEqual(Object.keys(value).sort(), ['diagnostics.log', 'diagnostics.performance'])
    && typeof value['diagnostics.performance'] === 'boolean'
    && value['diagnostics.log'] !== null && typeof value['diagnostics.log'] === 'object' && !Array.isArray(value['diagnostics.log']);
}

/**
 * The settings in force over the measured interval of `target` with the name of their source, or the reasons why the declarations
 * give none: traceSettings (scripts/measure-trace.mjs) of the trace state of a target of TRACE_TARGETS, and for an e2e benchmark the
 * settings that `benchmarks.settings` (B3_SETTINGS of e2e/benchmark/measurements.mjs) declares for it in the shape of its keys in
 * `benchmarks.measurements` (B3_MEASUREMENTS): one settings object for a list of keys, which takes no TRACE, and the same states as
 * an object of states, whose entry names its state with TRACE.
 */
export function measuredSettings(target, trace, benchmarks) {
  const [command, name] = target.split(' ');
  const state = traceStateOf(target, trace);
  if (command === 'make' && TRACE_TARGETS.includes(name)) return { settings: traceSettings(state), source: `TRACE=${state}` };
  const benchmark = benchmarkOf(target);
  if (benchmark === null) return { reasons: ['runs no target whose settings a declaration gives'] };
  const keys = benchmarks.measurements[benchmark];
  if (keys === undefined) return { reasons: [`e2e/benchmark/measurements.mjs declares no measurements of ${benchmark} in B3_MEASUREMENTS`] };
  const declared = benchmarks.settings[benchmark];
  if (declared === undefined) return { reasons: [`e2e/benchmark/measurements.mjs declares no settings of ${benchmark} in B3_SETTINGS`] };
  const expected = (value, where) => `B3_SETTINGS of ${benchmark}${where} is ${JSON.stringify(value)}, expected one settings object ${SETTINGS_FORM}`;
  if (Array.isArray(keys)) {
    if (!isSettings(declared)) return { reasons: [`${expected(declared, '')} for the list of keys of B3_MEASUREMENTS of ${benchmark}`] };
    if (state !== null) return { reasons: [`names TRACE=${state}, and ${benchmark} measures in one state`] };
    return { settings: declared, source: benchmark };
  }
  const states = Object.keys(keys);
  const reasons = [
    ...Object.keys(declared).filter((each) => !states.includes(each))
      .map((each) => `B3_SETTINGS declares the state ${each} of ${benchmark}, which B3_MEASUREMENTS of ${benchmark} does not hold`),
    ...states.filter((each) => !Object.hasOwn(declared, each))
      .map((each) => `B3_SETTINGS declares no settings of the state ${each} of ${benchmark}, which B3_MEASUREMENTS of ${benchmark} holds`),
    ...states.filter((each) => Object.hasOwn(declared, each) && !isSettings(declared[each]))
      .map((each) => expected(declared[each], ` in the state ${each}`)),
  ];
  if (reasons.length > 0) return { reasons };
  if (state === null) return { reasons: [`names no TRACE, and ${benchmark} measures in the states ${states.join(' and ')}`] };
  if (!states.includes(state)) return { reasons: [`${benchmark} measures in no state ${state}`] };
  return { settings: declared[state], source: `${benchmark} in the state ${state}` };
}

/**
 * The failures of the trace state that a target reports against the settings of its measured interval (measuredSettings): traceState
 * is their diagnostics.performance and logPolicy the classes of the policy that their diagnostics.log puts in force.
 */
function traceFailures(target, conditions, { trace, benchmarks }) {
  const { settings, source, reasons } = measuredSettings(target, trace, benchmarks);
  if (reasons !== undefined) return reasons.map((reason) => `${target}: ${reason}`);
  const failures = [];
  if (conditions.traceState !== settings['diagnostics.performance']) {
    failures.push(`reports traceState ${JSON.stringify(conditions.traceState)}, expected ${settings['diagnostics.performance']} of ${source}`);
  }
  const policy = policyOfSetting(settings['diagnostics.log']).classes;
  if (!isDeepStrictEqual(conditions.logPolicy, policy)) {
    failures.push(`reports logPolicy ${JSON.stringify(conditions.logPolicy)}, expected ${JSON.stringify(policy)} of ${source}`);
  }
  return failures.map((failure) => `${target}: ${failure}`);
}

/**
 * Reads the output of a target from `file` after the target exited with `code`, through readB3Out (scripts/b3-out.mjs), which
 * refuses an output outside its form, and returns the measurements that the entries of its row name, under the ids of those
 * entries, the conditions that it reports, and the failures of the run. A target with an error exits with another code than 0 and
 * writes no output, so that exit fails the run and nothing is read; a benchmark that fails writes the verdict `failed` as its
 * measurement. On the mygo host every entry of the row requires its measurement, on another application the entries that are
 * compared with other hosts. A display or a window outside the run conditions of the scenario, and a trace state or a log policy
 * other than the settings of its measured interval (measuredSettings), with `benchmarks` the B3_MEASUREMENTS (`measurements`) and
 * the B3_SETTINGS (`settings`) of the e2e benchmarks, fail the run.
 */
export function readTargetOutput(file, { goals, scenario, target, application, trace, code, benchmarks }) {
  if (code !== 0) return { values: {}, conditions: null, failures: [`${target} exited with code ${code}`] };
  if (!existsSync(file)) return { values: {}, conditions: null, failures: [`${target} wrote no output ${file}`] };
  let output;
  try { output = readB3Out(file); } catch (error) { return { values: {}, conditions: null, failures: [error.message] }; }
  const { measurements, conditions } = output;
  const entries = goals.values.filter((value) => value.scenario === scenario && value.target === target);
  const values = {};
  const failures = [];
  for (const entry of entries) {
    if (!Object.hasOwn(measurements, entry.measurement)) {
      if (application.host === 'mygo' || entry.relative) failures.push(`${entry.id}: ${target} wrote no measurement ${entry.measurement}`);
      continue;
    }
    const measured = measurements[entry.measurement];
    if ((entry.unit === 'verdict') === (typeof measured === 'string')) values[entry.id] = measured;
    else failures.push(`${entry.id}: ${target} wrote the measurement ${entry.measurement} as ${JSON.stringify(measured)}, expected ${entry.unit === 'verdict' ? 'passed or failed' : 'a number'}`);
  }
  failures.push(...targetConditionFailures(goals, scenario, conditions).map((failure) => `${target}: ${failure}`));
  failures.push(...traceFailures(target, conditions, { trace, benchmarks }));
  return { values, conditions, failures };
}

/** The refresh rate and the backing scale of the windows of the application of `configDir`, which every window shares. */
export async function readDisplay(configDir) {
  const client = await connect({ configDir });
  const displays = [];
  try {
    for (const { window } of await client.request('windows.list')) {
      const status = await client.request('status.get', { window, name: 'host.window' });
      displays.push({ refreshRate: status.refreshRate, backingScale: status.scale });
    }
  } finally {
    client.close();
  }
  if (displays.length === 0) throw new Error('the application lists no window');
  const [first] = displays;
  if (displays.some((display) => display.refreshRate !== first.refreshRate || display.backingScale !== first.backingScale)) {
    throw new Error(`the windows of the application report different displays: ${JSON.stringify(displays)}`);
  }
  return first;
}

/**
 * Makes the first window of the application of a configuration folder the window that a person sees. A window opens behind the front
 * window, and a covered window measures another state, so a run activates it through input.pointer before its first target. A refused
 * activation fails with its message, and a window that stays covered after waitMs fails.
 */
export async function activateWindow(configDir, { waitMs = 5000 } = {}) {
  const client = await connect({ configDir });
  try {
    const [{ window }] = await client.request('windows.list');
    const read = () => client.request('status.get', { window, name: 'host.window' });
    const { content } = await read();
    await client.request('input.pointer', { window, x: content.width / 2, y: 4, phase: 'move', activate: true });
    const until = performance.now() + waitMs;
    let status = await read();
    while (status.occluded !== false && performance.now() < until) {
      await new Promise((resolve) => { setTimeout(resolve, 100); });
      status = await read();
    }
    if (status.occluded !== false) throw new Error(`window ${window} reports occluded ${status.occluded} after its activation`);
  } finally {
    client.close();
  }
}

/** Reads `plugins/installed.json` of a configuration folder, or null when the folder has installed nothing. */
function readInstalled(configDir) {
  const file = join(configDir, 'plugins', 'installed.json');
  return existsSync(file) ? readJson(file) : null;
}

/** Writes a new session folder: session.json, the copies of the baseline record and of the sidecar revision record, and an empty runs.jsonl. */
export function createSession(folder, { phase, runs, applications, builds, toolchains, baseline, sidecars }) {
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'session.json'), `${JSON.stringify({
    schema: 1, phase, runs, applications: applications.map(({ name, host, build }) => ({ name, host, build })), builds, toolchains,
  }, null, 2)}\n`);
  writeFileSync(join(folder, 'baseline.json'), `${JSON.stringify(baseline, null, 2)}\n`);
  writeFileSync(join(folder, 'sidecar-revisions.json'), `${JSON.stringify(sidecars, null, 2)}\n`);
  writeFileSync(join(folder, 'runs.jsonl'), '');
}

/** Appends a run record to `file` of the session folder. */
export function appendRecord(folder, record, file = 'runs.jsonl') {
  appendFileSync(join(folder, file), `${JSON.stringify(record)}\n`);
}

/** Runs a target to its end with its output in `log`; an interrupt of the run ends it with SIGTERM. Resolves with its exit code. */
async function runTargetCommand(command, { log, interrupted }) {
  const output = openSync(log, 'a');
  try {
    const child = spawn(command.argv[0], command.argv.slice(1), { cwd: command.cwd, env: { ...process.env, ...command.env }, stdio: ['ignore', output, output] });
    const stop = () => child.kill('SIGTERM');
    interrupted?.addEventListener('abort', stop, { once: true });
    try {
      const [code, signal] = await Promise.race([
        once(child, 'exit'),
        once(child, 'error').then(([error]) => { throw new Error(`cannot start ${command.argv[0]}: ${error.message}`); }),
      ]);
      return { code: signal === null ? code : signal };
    } finally {
      interrupted?.removeEventListener('abort', stop);
    }
  } finally {
    closeSync(output);
  }
}

/** The readings of the start conditions of a run: the load average, the swap use and the CPU share of fseventsd. */
async function readStartConditions() {
  const before = execFileSync('ps', ['-axo', 'pid=,time=,comm='], { encoding: 'utf8', maxBuffer: 1 << 26 });
  await sleep(FSEVENTSD_INTERVAL_S * 1000);
  const after = execFileSync('ps', ['-axo', 'pid=,time=,comm='], { encoding: 'utf8', maxBuffer: 1 << 26 });
  return {
    loadAverage: loadavg(),
    swap: parseSwapUsage(execFileSync('sysctl', ['-n', 'vm.swapusage'], { encoding: 'utf8' })),
    fseventsdCores: fseventsdCores(before, after, FSEVENTSD_INTERVAL_S),
  };
}

/**
 * Runs the scenarios of one unit in one new application and appends one record for each scenario to the session folder: the start
 * conditions, the display, the values of the targets, the installed releases, the load average at the end and the failures of the run.
 * `context` holds the goals, the session folder, the baseline record, the trace state, the B3_MEASUREMENTS and the B3_SETTINGS of
 * the e2e benchmarks (`benchmarks`), the records file, `write` for the step lines,
 * and the readings and the target runner, which tests inject.
 */
export async function runUnit(unit, context) {
  const {
    goals, session, write, baseline = null, trace = RUN_TRACE, benchmarks, recordsFile = 'runs.jsonl', prefix = '', interrupted,
    readStart = readStartConditions, display = readDisplay, activate = activateWindow, loadAverage = loadavg, runTarget = runTargetCommand,
    targetsOf = (scenario) => scenarioTargets(goals, scenario),
  } = context;
  const { application } = unit;
  const name = `${prefix}${unit.scenarios.join('+')}-${unit.run}-${application.name}`;
  const configRoot = join(session, 'configs', name);
  if (existsSync(configRoot)) throw new Error(`${configRoot} exists; every run starts in a new configuration folder`);
  mkdirSync(configRoot, { recursive: true });
  const configDir = join(configRoot, `soksak-check-${application.host}`);
  const failures = [];
  const values = Object.fromEntries(unit.scenarios.map((scenario) => [scenario, {}]));
  const conditions = Object.fromEntries(unit.scenarios.map((scenario) => [scenario, {}]));
  let installed = [];
  let shown = null;
  write(`run ${name}`);
  const start = await readStart();
  failures.push(...startConditionFailures(goals, start));
  if (failures.length === 0) {
    const index = readJson(application.index);
    const plan = unitPlan({ application, configRoot, configDir, pluginIds: index.plugins.map((plugin) => plugin.id) });
    const children = new Map();
    const started = await runPlan(plan.prepare, { write, children, interrupted });
    failures.push(...started);
    let plugins = [];
    if (started.length === 0) {
      try {
        const record = readInstalled(configDir);
        installed = installedReleases(record, index, PLATFORM);
        if (application.build === 'baseline') failures.push(...baselinePluginFailures(baseline, installed));
        plugins = surfacePlugins(record, (path) => readJson(join(configDir, path, 'plugin.json')));
        shown = await display(configDir);
        failures.push(...displayFailures(goals, shown));
        if (failures.length === 0) await activate(configDir);
      } catch (error) {
        failures.push(error.message);
      }
    }
    // A target that cannot be run fails the run, and the application of the run quits in every case.
    try {
      for (const scenario of started.length === 0 && failures.length === 0 ? unit.scenarios : []) {
        const folder = join(session, 'outputs', name, scenario);
        mkdirSync(folder, { recursive: true });
        for (const [position, target] of targetsOf(scenario).entries()) {
          if (interrupted?.aborted) {
            failures.push(`interrupted by ${interrupted.reason} before ${target}`);
            break;
          }
          const out = join(folder, `${position + 1}.json`);
          const command = targetCommand(target, { application, configRoot, configDir, trace, out, plugins, runId: `b3-${name}-${scenario}-${position + 1}`, runFolder: folder });
          write(`running ${target}`);
          const from = performance.now();
          const { code } = await runTarget(command, { scenario, target, log: join(folder, `${position + 1}.out`), interrupted });
          write(`${code === 0 ? 'passed' : 'failed'} ${target} ${((performance.now() - from) / 1000).toFixed(1)}s${code === 0 ? '' : `: exited with ${code}`}`);
          // A target without entries of its own, such as a debug target of phase 1, writes no output that the run reads.
          if (!goals.values.some((value) => value.scenario === scenario && value.target === target)) {
            if (code !== 0) failures.push(`${target} exited with code ${code}`);
            continue;
          }
          const output = readTargetOutput(out, { goals, scenario, target, application, trace, code, benchmarks });
          Object.assign(values[scenario], output.values);
          if (output.conditions !== null) conditions[scenario][target] = output.conditions;
          failures.push(...output.failures);
        }
      }
    } catch (error) {
      failures.push(error.message);
    }
    failures.push(...await runPlan(plan.cleanup, { write, children }));
  }
  const end = { loadAverage: loadAverage() };
  const records = unit.scenarios.map((scenario) => ({
    scenario, run: unit.run, application: application.name, start, display: shown, end, installed, values: values[scenario], conditions: conditions[scenario],
    failures: [...failures],
  }));
  for (const record of records) appendRecord(session, record, recordsFile);
  if (failures.length === 0) rmSync(configRoot, { recursive: true });
  else {
    // The persistent services of a host that ended without host.quit exit when their folder is removed (docs/spec/persistent-services.md).
    const services = join(configDir, 'services');
    if (existsSync(services)) rmSync(services, { recursive: true });
    for (const failure of failures) write(`failure ${name}: ${failure}`);
    write(`kept ${configRoot}: the run failed`);
  }
  return records;
}

/** The source revision of each checkout and the sha256 of the executable of each application. */
function buildsOf(applications) {
  return Object.fromEntries(applications.map((application) => [application.name, {
    revision: execFileSync('git', ['-C', application.checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    executable: createHash('sha256').update(readFileSync(application.executable)).digest('hex'),
  }]));
}

/** The Go and Rust toolchain versions of the builds. */
function toolchains() {
  return {
    go: execFileSync('go', ['version'], { cwd: ROOT, encoding: 'utf8' }).trim(),
    rust: execFileSync('rustc', ['--version'], { cwd: ROOT, encoding: 'utf8' }).trim(),
  };
}

/**
 * The build steps of a phase: the release bundles of both checkouts and, in phase 1, the debug bundles, one host at a time with the Tauri hosts
 * first, because they take the most disk, and then the two registry indexes.
 */
export function buildSteps(phase, baseline) {
  const step = (name, argv) => ({ name, phase: 'prepare', kind: 'run', argv, env: {} });
  const profiles = phase === '1' ? ['-release', ''] : ['-release'];
  // The intermediate outputs leave before the next build; the bundles and the executables stay, because the runs start them.
  const outputs = (checkout) => ['debug', 'release'].flatMap((profile) => ['build', 'deps', '.fingerprint', 'incremental'].map((name) => join(checkout, 'target', profile, name)));
  const host = (name, target, checkout) => [
    step(`${name} ${target}`, checkout === ROOT ? ['make', target] : ['make', '-C', checkout, target]),
    step(`outputs of ${name} ${target}`, ['rm', '-rf', ...outputs(checkout)]),
  ];
  const each = (name, checkouts) => profiles.flatMap((profile) => checkouts.flatMap(([label, checkout]) => host(label, `build-${name}${profile}`, checkout)));
  const both = [['current', ROOT], ['baseline', baseline]];
  return [
    ...each('tauriv2', both),
    ...each('wailsv3', both),
    ...each('mygo', [['current', ROOT]]),
    step('workspace registry', ['make', 'build-registry', 'SIDECARS=diagnostic']),
    step('public index', ['make', 'build-registry', 'SIDECARS=diagnostic', 'PLUGINS=public']),
  ];
}

/**
 * The runs that phase 1 adds after the runs of the session: each scenario with TRACE=1 once on each application, then the debug targets.
 * A target reruns only when it takes the trace state of the run; a target that names its own TRACE measures in that state in every run.
 */
export function attributionUnits(goals, applications, debugApplications) {
  const units = sessionUnits(goals, 1, applications)
    .filter((unit) => unit.scenarios.some((scenario) => scenarioTargets(goals, scenario).some(takesRunTrace)))
    .map((unit) => ({ ...unit, targets: (scenario) => scenarioTargets(goals, scenario).filter(takesRunTrace) }));
  const debug = debugApplications.map((application) => ({
    scenarios: ['debug'], run: 1, application,
    targets: () => [...(application.host === 'mygo' ? [] : ['make measure-host-calls']), 'make measure-trace-share'],
  }));
  return [...units, ...debug];
}

async function main(argv) {
  const { values } = parseArgs({ args: argv, strict: true, options: { phase: { type: 'string' }, runs: { type: 'string' }, baseline: { type: 'string' } } });
  if (!['1', 'final'].includes(values.phase) || !/^[1-9]\d*$/.test(values.runs ?? '') || !values.baseline) {
    throw new Error('benchmark-b3 requires --phase 1|final --runs <n> --baseline <checkout>');
  }
  const runs = Number(values.runs);
  const write = (line) => process.stdout.write(`${line}\n`);
  const goals = readGoals(readFileSync(GOALS_FILE, 'utf8'), 'docs/spec/performance-goals.json');
  const recordFile = baselineRecordFile(ROOT);
  const baseline = readBaselineRecord(readFileSync(recordFile, 'utf8'), recordFile);
  const checkout = baselineCheckoutFailures(baseline, readCheckout(values.baseline), values.baseline);
  if (checkout.length > 0) {
    for (const failure of checkout) write(`failure ${failure}`);
    return 1;
  }
  const interrupt = new AbortController();
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.once(signal, () => {
      write(`received ${signal}: the session ends its runs and runs the cleanup of the running run`);
      interrupt.abort(signal);
    });
  }
  const built = await runPlan(buildSteps(values.phase, values.baseline), { write, interrupted: interrupt.signal });
  if (built.length > 0) {
    for (const failure of built) write(`failure ${failure}`);
    return 1;
  }
  const revisionFile = join(ROOT, 'target', 'registry', 'sidecar-revisions.json');
  const sidecars = readSidecarRevisions(readFileSync(revisionFile, 'utf8'), revisionFile);
  const revisions = sidecarRevisionFailures(baseline, sidecars);
  if (revisions.length > 0) {
    for (const failure of revisions) write(`failure ${failure}`);
    return 1;
  }
  const applications = applicationsOf({ root: ROOT, baseline: values.baseline });
  const base = join(ROOT, 'target', 'b3');
  mkdirSync(base, { recursive: true });
  const session = mkdtempSync(join(base, `${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}-phase-${values.phase}-`));
  createSession(session, { phase: values.phase, runs, applications, builds: buildsOf(applications), toolchains: toolchains(), baseline, sidecars });
  write(`session ${session}`);
  const context = { goals, session, write, baseline, benchmarks: BENCHMARKS, interrupted: interrupt.signal };
  let failed = 0;
  for (const unit of sessionUnits(goals, runs, applications)) {
    if (interrupt.signal.aborted) break;
    const [record] = await runUnit(unit, context);
    if (record.failures.length > 0) failed += 1;
  }
  if (values.phase === '1') {
    writeFileSync(join(session, 'attribution.jsonl'), '');
    for (const unit of attributionUnits(goals, applications, applicationsOf({ root: ROOT, baseline: values.baseline }, 'debug'))) {
      if (interrupt.signal.aborted) break;
      const [record] = await runUnit(unit, { ...context, trace: ATTRIBUTION_TRACE, recordsFile: 'attribution.jsonl', prefix: 'attribution-', targetsOf: unit.targets });
      if (record.failures.length > 0) failed += 1;
    }
  }
  write(`${failed === 0 && !interrupt.signal.aborted ? 'passed' : 'failed'} session ${session}: ${failed} failed run${failed === 1 ? '' : 's'}${interrupt.signal.aborted ? `, interrupted by ${interrupt.signal.reason}` : ''}; judge it with make check-b3 SESSION=${session}`);
  return failed === 0 && !interrupt.signal.aborted ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
