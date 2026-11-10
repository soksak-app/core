// Connects to the local endpoint of a running example application, prepares its state and records drags.
//
// The checks do not launch the application. The application must already run with `--config-dir
// <tmpdir>/soksak-check-<app>`, and the harness connects through the endpoint.json of that folder. The specification is
// in docs/spec/endpoint.md and docs/spec/exposure.md.
import { appendFileSync, closeSync, existsSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, EndpointError } from "@soksak/client";
import { activateApp, coveringWindows } from "./frontmost.mjs";
import { STALL_AFTER, announceStall, pageProcesses, sampleStall } from "./stall-sample.mjs";
import { untilEndpoint } from "./endpoint-wait.mjs";
import { joinedFailure } from "./failure.mjs";
import { endWatches } from "./folder-wait.mjs";
import { readEventErrors, sessionEventBoot, sessionEventStart } from "./event-log.mjs";
import { exitEvidence } from "./host-exit.mjs";
import { policyFile, policyOfSetting, readPolicy, requireStored, untilPolicy } from "./log-policy.mjs";
import { policyAllows } from "@soksak/log-contract";
import { readPasteboard, restorableItems, restoreFailure, writePasteboard } from "./pasteboard.mjs";

// The launch declares the application executables that are checked. SOKSAK_BINARY_WAILSV3, SOKSAK_BINARY_TAURIV2 and SOKSAK_BINARY_MYGO
// hold the executable path inside the bundle of each application (docs/operations/examples.md#window-checks). The
// checks of core find these paths in the build output folder and pass them on; the checks of other repositories declare
// the build to check themselves.
const declared = (name) => {
  const variable = `SOKSAK_BINARY_${name.toUpperCase()}`;
  const path = process.env[variable];
  if (!path) throw new Error(`${variable} is not set; it names the executable of the ${name} application to check`);
  return path;
};

// The applications that SOKSAK_APP may name, and the set that a session covers when SOKSAK_APP is unset.
export const APP_NAMES = ["wailsv3", "tauriv2", "mygo"];

/**
 * The applications that a window session covers. SOKSAK_APP names one application of APP_NAMES; when it is unset, the
 * session covers every application of APP_NAMES. An application of the set whose executable is missing fails the check (open), and an
 * application outside the set is not opened.
 */
export function requiredApps(env) {
  if (!env.SOKSAK_APP) return [...APP_NAMES];
  if (!APP_NAMES.includes(env.SOKSAK_APP)) throw new Error(`unknown SOKSAK_APP: ${env.SOKSAK_APP}`);
  return [env.SOKSAK_APP];
}

/**
 * Whether the required set holds every application of APP_NAMES, so that a check that compares the hosts of the session
 * with each other is part of the session; it then compares every application of APPS. A session of one application
 * compares nothing.
 */
export function requiresAll(env) {
  const names = requiredApps(env);
  return APP_NAMES.every((name) => names.includes(name));
}

/** The applications to check: the executable and the configuration folder. */
export const APPS = Object.fromEntries(requiredApps(process.env).map((name) => [name, {
  name,
  // The executable is read when it is used. Without a declaration, the check that tests that application fails and
  // names the variable.
  get binary() { return declared(name); },
  // default: without an explicit configuration directory or isolated root from the launch, window checks use a
  // disposable temporary endpoint directory.
  configDir: process.env.SOKSAK_CONFIG_DIR ?? join(process.env.SOKSAK_CONFIG_ROOT ?? tmpdir(), `soksak-check-${name}`),
}]));

/**
 * The processes of the applications of the run: each application of APP_NAMES whose configuration folder in the root of the run
 * holds an endpoint, whether or not the session checks it. A run starts every application of its root without activation, so a
 * check of the window order leaves their windows out of the windows of the applications that a person uses.
 */
export function runProcesses(env = process.env) {
  const root = env.SOKSAK_CONFIG_ROOT ?? tmpdir();
  return APP_NAMES.map((name) => join(root, `soksak-check-${name}`, "endpoint.json")).filter((file) => existsSync(file))
    .map((file) => JSON.parse(readFileSync(file, "utf8")).pid);
}

// The applications that have a main page: their host draws the workbench in a web page; the mygo host draws it in native
// UI and has no main page (docs/spec/hosts.md#mygo-host).
const MAIN_PAGE_NAMES = ["wailsv3", "tauriv2"];

/**
 * The applications of APPS that have a main page. A window check whose subject is the main page or a modal web view
 * iterates this list; every other window check iterates Object.values(APPS).
 */
export const MAIN_PAGE_APPS = Object.values(APPS).filter((app) => MAIN_PAGE_NAMES.includes(app.name));

/** Verifies that the running endpoint is not older than the current build. */
export function assertEndpointUsesCurrentBuild(endpoint, resolvedBinary, binaryMtimeMs) {
  if (endpoint.executable !== resolvedBinary) {
    throw new Error(`process ${endpoint.pid} runs ${endpoint.executable}, not ${resolvedBinary}; restart the application from this checkout`);
  }
  const startedMs = Date.parse(endpoint.started);
  if (!Number.isFinite(startedMs)) {
    throw new Error(`process ${endpoint.pid} has invalid endpoint start time ${endpoint.started}`);
  }
  if (!Number.isFinite(binaryMtimeMs)) {
    throw new Error(`current build has invalid modification time ${binaryMtimeMs}`);
  }
  if (binaryMtimeMs > startedMs + 1000) {
    throw new Error(
      `process ${endpoint.pid} started at ${endpoint.started} before the current build ` +
      `mtime ${new Date(binaryMtimeMs).toISOString()}; restart the application from this checkout`,
    );
  }
}

// The time limit (ms) for the end of the folder watches that the waits of a check started, at the end of the check.
const WATCH_END_LIMIT = 10_000;

/**
 * The sequential-run lock between check files. A second check run fails without waiting. The lock file holds the number
 * of the owning process; when that process does not exist, the lock is a remnant and is replaced.
 */
const LOCK = join(tmpdir(), "sok-check.lock");

function running(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

let locked = false;
const sessionTails = new Map();
/** Rejects at once a duplicate session of a Node test that operates the windows of the same application. */
export async function acquireWindowCheckSlot(appName) {
  if (sessionTails.has(appName)) {
    throw new Error(
      `an application window check is already active for ${appName}; ` +
      "run the e2e package with its declared --test-concurrency=1 entry point",
    );
  }
  const current = {};
  sessionTails.set(appName, current);
  let released = false;
  return () => {
    if (released) throw new Error(`window check slot for ${appName} was released twice`);
    released = true;
    if (sessionTails.get(appName) === current) sessionTails.delete(appName);
  };
}

function lock() {
  if (locked) return;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(LOCK, "wx");
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      locked = true;
      process.once("exit", () => {
        try {
          if (readFileSync(LOCK, "utf8") === String(process.pid)) unlinkSync(LOCK);
        } catch (error) {
          // When the lock file does not exist, another run has already removed it. Any other error is reported.
          if (error.code !== "ENOENT") throw error;
        }
      });
      return;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const owner = Number(readFileSync(LOCK, "utf8"));
      if (owner === process.pid) {
        locked = true;
        return;
      }
      if (Number.isInteger(owner) && owner > 0 && running(owner)) {
        throw new Error(`window checks are already running in process ${owner} (${LOCK}); nothing was measured`);
      }
      unlinkSync(LOCK);
    }
  }
  throw new Error(`could not take the window check lock ${LOCK}`);
}

/**
 * Connects to one application. An application outside the required set returns null without reading its executable. An
 * application of the required set whose executable does not exist fails with an error that names the executable. The
 * connection is closed when the check ends.
 *
 * Verifies that the process of endpoint.json is the executable of this repository, so that the check does not test an
 * application of another checkout or an earlier build.
 */
/** The record of an application whose document stopped replying, in its configuration folder (F351). */
const unresponsivePath = (configDir) => join(configDir, "unresponsive.json");

/** The error of an application that has a record of a document that stopped replying, or null without the record. */
function unresponsiveError(app, consequence = "this request is not sent") {
  const path = unresponsivePath(app.configDir);
  if (!existsSync(path)) return null;
  const record = JSON.parse(readFileSync(path, "utf8"));
  return new Error(`${app.name} stopped replying in the check "${record.check}" at ${record.request}, so ${consequence}; ${record.error}`);
}

/**
 * The record of an application whose host process exited, in its configuration folder. The check that finds the exit fails with
 * it, and each later check of the application is reported as not run because of it: those checks cannot run, and starting the
 * application again would hide the exit.
 */
const exitedPath = (configDir) => join(configDir, "exited.json");

/** Whether process pid runs; a process of another user that runs refuses the signal with EPERM. */
function processRuns(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/** The process of endpoint.json when it names one that no longer runs, or null. */
function exitedEndpointPid(configDir) {
  let endpoint;
  try {
    endpoint = JSON.parse(readFileSync(join(configDir, "endpoint.json"), "utf8"));
  } catch {
    return null;
  }
  return Number.isInteger(endpoint?.pid) && !processRuns(endpoint.pid) ? endpoint.pid : null;
}

/** Records that the host process pid of the application exited, as the check named check found, and returns the failure of that check. */
function hostExited(app, pid, check, how) {
  const evidence = exitEvidence(app.configDir, pid);
  writeFileSync(exitedPath(app.configDir), `${JSON.stringify({ check, pid, evidence })}\n`);
  return new Error(`${app.name} process ${pid} ${how}, and its later checks do not run; ${evidence}`);
}

/** The reason that a check of the application does not run, when an earlier check found its host process exited, or null. */
function exitedReason(app) {
  const path = exitedPath(app.configDir);
  if (!existsSync(path)) return null;
  const record = JSON.parse(readFileSync(path, "utf8"));
  return `not run: ${app.name} process ${record.pid} exited, found by the check "${record.check}"; ${record.evidence}`;
}

/** Whether the workbench of the window answers one status request; a reply in any form, also an error, shows that it runs. */
async function workbenchReplies(client, window) {
  try {
    await client.request("status.get", { window, name: "core.workbench.error" });
    return true;
  } catch (error) {
    return !(error instanceof EndpointError && /did not reply within/.test(error.message));
  }
}

// A Node after-hook failure prevents later after hooks from running. Own all
// sessions of a test in one hook, and report failures only after every session
// has run its full audit and released its connection and window-check slot.
const sessionFinishes = new WeakMap();
function afterSession(t, finish, dispose) {
  let finishes = sessionFinishes.get(t);
  if (!finishes) {
    finishes = [];
    sessionFinishes.set(t, finishes);
    t.after(async () => {
      const failures = [];
      try {
        for (const completion of finishes) {
          try { await completion.finish(); } catch (error) {
            failures.push(error);
            t.diagnostic(`session cleanup failed: ${error.stack ?? error}`);
          }
        }
        // Disposal is a parent-owned second phase: every session has finished
        // its audit, end mark, stall drain and connection/slot release first.
        for (const completion of finishes) {
          try { completion.dispose(!t.passed || failures.length > 0); } catch (error) {
            failures.push(error);
            t.diagnostic(`session recording disposal failed: ${error.stack ?? error}`);
          }
        }
      } finally {
        sessionFinishes.delete(t);
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length) throw joinedFailure(`${failures.length} session cleanups failed`, failures);
    });
  }
  finishes.push({ finish, dispose });
}

export async function open(t, app, { clipboard = false, inactive = false } = {}) {
  if (typeof inactive !== "boolean") throw new TypeError("inactive must be a boolean");
  if (typeof clipboard !== "boolean") throw new TypeError("clipboard must be a boolean");
  if (!requiredApps(process.env).includes(app.name)) return null;
  if (!existsSync(app.binary)) {
    throw new Error(
      `${app.binary} does not exist; ${app.name} is in the window check set, so the check fails. Build the application ` +
        "or select another one with SOKSAK_APP.",
    );
  }
  // An application whose document stopped replying in an earlier check of this configuration fails the check at once (F351).
  const stopped = unresponsiveError(app, "this check does not run");
  if (stopped) throw stopped;
  // An application whose host process exited in an earlier check reports this check as not run because of that exit; the check
  // that found the exit failed with it.
  const notRun = exitedReason(app);
  if (notRun !== null) {
    if (typeof t.skip === "function") t.skip(notRun);
    throw new Error(notRun);
  }
  // A host process that exited between checks leaves endpoint.json naming it: this check finds the exit and fails with it.
  const exited = exitedEndpointPid(app.configDir);
  if (exited !== null) throw hostExited(app, exited, t.name, `exited before the check "${t.name}", so nothing was measured`);
  lock();
  const releaseSlot = await acquireWindowCheckSlot(app.name);
  let client;
  try {
    client = await connect({ configDir: app.configDir });
  } catch (error) {
    releaseSlot();
    throw new Error(
      `${app.name} is not running, so nothing was measured (${error.message}). These checks drive an ` +
        "application that is already open and never open one themselves: a window that opens takes " +
        `the screen and the keyboard from whoever is using the machine. Start it once with ` +
        `\`${app.binary} --config-dir "${app.configDir}" --registry-ca "${join(process.env.SOKSAK_CONFIG_ROOT ?? tmpdir(), "soksak-check-registry-tls", "ca.pem")}"\` ` +
        "after make create-test-certificates, and run them again.",
    );
  }
  const session = new Session(app, client);
  // The record of an application that stops replying names the check (F351).
  session.check = t.name;
  // Register ownership before any preparation can fail. A rejected open finishes
  // immediately; the after hook observes that completed cleanup without releasing twice.
  let finished;
  const pendingDisposal = [];
  const finish = () => finished ??= finishSessionAudit(t, session, () => {
    try { session.client.close(); } finally { releaseSlot(); }
  }, pendingDisposal);
  afterSession(t, finish, preserve => disposeSessionRecordings(t, pendingDisposal, preserve));
  try {
    // The cleanup reads the errors after this position and the recordings beside these, so both are taken before a check of
    // the endpoint can end the session.
    session.eventStart = sessionEventStart(app.configDir);
    // The errors of this session are the errors of the host of this boot and of the processes it started (files of earlier boots are not judged).
    session.eventBoot = sessionEventBoot(app.configDir, client.endpoint.pid);
    session.recordingsBefore = recordingFolders(app.configDir);
    if (clipboard) {
      const pasteboard = readPasteboard();
      session.cleanup(() => {
        const { items, skipped } = restorableItems(pasteboard);
        for (const line of skipped) t.diagnostic(`${app.name}: pasteboard ${line}`);
        const written = writePasteboard(items);
        const failure = restoreFailure(items, written, readPasteboard());
        if (failure !== null) throw new Error(`${app.name}: the pasteboard after the check differs from before it: ${failure}`);
      });
    }
    // Reverse cleanup order releases presses before restoring clipboard; input-source
    // restoration is inserted at the beginning and therefore runs after both.
    session.cleanup(async () => {
      for (const line of await session.releasePresses()) t.diagnostic(line);
    });
    const { endpoint } = client;
    if (endpoint.application !== app.name) {
      throw new Error(`${app.configDir}/endpoint.json belongs to ${endpoint.application}, not ${app.name}`);
    }
    assertEndpointUsesCurrentBuild(endpoint, realpathSync(app.binary), statSync(app.binary).mtimeMs);
    if (inactive) {
      const baseline = await inactiveObservation(session);
      session.verifyInactive = async () => {
        const after = await inactiveObservation(session);
        if (after.pid !== baseline.pid || after.started !== baseline.started) throw new Error(`${app.name}: inactive endpoint boot changed`);
        if (after.count !== baseline.count) throw new Error(`${app.name}: activation count changed from ${baseline.count} to ${after.count}`);
        t.diagnostic(`${app.name}: inactive proof pid=${after.pid} started=${after.started} activation count ${baseline.count}→${after.count}, registered=true active=false`);
      };
    }
    await session.markTest("start", t.name);
    return session;
  } catch (error) {
    try { await finish(); } catch (cleanupError) {
      finished = Promise.resolve();
      throw joinedFailure("session preparation and cleanup failed", [error, cleanupError]);
    }
    throw error;
  }
}

// This opt-in proof observes only this application's registered native source.
// Reread endpoint.json: a cached connection identity cannot establish boot stability.
async function inactiveObservation(session) {
  const { readEndpoint } = await import("@soksak/client");
  const state = await session.get("host.window");
  const endpoint = await readEndpoint(session.app.configDir);
  const connected = session.client.endpoint;
  if (!Number.isInteger(endpoint.pid) || endpoint.pid <= 0 || typeof endpoint.started !== "string" ||
      !Number.isFinite(Date.parse(endpoint.started)) || endpoint.pid !== connected.pid || endpoint.started !== connected.started) {
    throw new Error(`${session.app.name}: inactive endpoint boot differs from its connection`);
  }
  const observation = state?.activationObservation;
  if (state?.active !== false) throw new Error(`${session.app.name}: inactive proof requires active:false`);
  if (observation?.registered !== true) throw new Error(`${session.app.name}: activation observation is not registered`);
  const count = observation.count;
  if (typeof count !== "string" || !/^(0|[1-9][0-9]*)$/.test(count) || BigInt(count) > 18_446_744_073_709_551_615n) {
    throw new Error(`${session.app.name}: activation count must be a canonical uint64 decimal string`);
  }
  return { pid: endpoint.pid, started: endpoint.started, count };
}

/** The names of the recording folders under logs/captures of the configuration folder; none without the folder. */
export function recordingFolders(configDir) {
  const captures = join(configDir, "logs", "captures");
  if (!existsSync(captures)) return [];
  return readdirSync(captures, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

/**
 * Runs every cleanup of the session in reverse order of registration and then calls close. When one cleanup fails (for
 * example, when the application does not respond), the remaining cleanups still run and the failures are reported
 * together. node:test does not print an error that the after hook throws for a check whose body already failed, so each
 * failure is also reported as a diagnostic.
 */
export async function finishSession(t, session, close) {
  // Direct callers own a complete single-session scope and retain immediate
  // disposal semantics. open() instead gives its parent hook the disposal plan.
  return finishSessionAudit(t, session, close);
}

function disposeSessionRecordings(t, folders, preserve) {
  const failures = [];
  for (const folder of folders) {
    if (preserve || failures.length) {
      t.diagnostic(`kept recording: ${folder}`);
      continue;
    }
    try { rmSync(folder, { recursive: true, force: true }); } catch (error) {
      failures.push(error);
      t.diagnostic(`cleanup failed: ${error.stack ?? error}`);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw joinedFailure(`${failures.length} recording disposals failed`, failures);
}

async function finishSessionAudit(t, session, close, pendingDisposal) {
  const failures = [];
  try {
    for (const clean of session.cleanups.reverse()) {
      try {
        await clean();
      } catch (error) {
        failures.push(error);
        t.diagnostic(`cleanup failed: ${error.stack ?? error}`);
      }
    }
    // The cleanups may start stall samples too, so the samples are awaited after them and before the error audit.
    await settleStallSamples(t, session, failures);
    // Every error line written to the application log during the check is kept as a diagnostic, and an error that the
    // check did not declare fails the check. A reload clears the error display of a document, so the log decides. The
    // log is read after the cleanups so that it includes the errors they cause.
    try {
      // The errors of the check are the errors between its start mark and its end mark. An error outside the marks of every
      // check is not read here: the audit of the run reports it as a finding (docs/operations/examples.md#window-checks).
      const { errors } = readEventErrors(session.app.configDir, session.eventStart, session.eventBoot);
      for (const line of errors) t.diagnostic(`application error: ${line}`);
      const undeclared = errors.filter((line) => !session.expectedErrors.some((pattern) => pattern.test(line)));
      if (undeclared.length) {
        throw new Error(`${session.app.name}: the application logged ${undeclared.length} error${undeclared.length === 1 ? "" : "s"} ` +
          `that the check did not declare:\n${undeclared.join("\n")}`);
      }
    } catch (error) {
      failures.push(error);
      t.diagnostic(`cleanup failed: ${error.stack ?? error}`);
    }
    // A folder watch that a wait of the check started ends with the check (folder-wait.mjs).
    for (const error of await endWatches(WATCH_END_LIMIT)) {
      failures.push(error);
      t.diagnostic(`cleanup failed: ${error.stack ?? error}`);
    }
    // Verify after the test's own cleanups, before any successful evidence deletion.
    // A failed proof enters the normal preservation/error path.
    if (session.verifyInactive) {
      try { await session.verifyInactive(); } catch (error) {
        failures.push(error);
        t.diagnostic(`cleanup failed: ${error.stack ?? error}`);
      }
    }
    // A failed check keeps every recording that its cleanups left so the frames remain available for diagnosis. A
    // recording left by an otherwise successful check is itself a failure; preserve it for the same reason.
    const left = recordingFolders(session.app.configDir).filter((name) => !session.recordingsBefore.includes(name))
      .map((name) => join(session.app.configDir, "logs", "captures", name));
    const remaining = left.map((folder) => ({ folder, identity: realpathSync(folder) }));
    const untracked = remaining.filter(({ identity }) => !session.recordings.has(identity)).map(({ folder }) => folder);
    const failedRecordings = remaining.filter(({ identity }) => session.failedRecordings.has(identity));
    if (left.length && (!t.passed || failures.length || untracked.length || failedRecordings.length)) {
      if (untracked.length && t.passed && failures.length === 0) {
        const error = new Error(`${session.app.name}: the check left ${untracked.length} untracked recording${untracked.length === 1 ? "" : "s"}: ` +
          `${untracked.join(", ")}; the recordings were preserved`);
        failures.push(error);
        t.diagnostic(`cleanup failed: ${error.stack ?? error}`);
      }
      if (failedRecordings.length && t.passed && failures.length === 0) {
        const details = failedRecordings.map(({ folder, identity }) => `${folder}: ${session.failedRecordings.get(identity)}`);
        const error = new Error(`${session.app.name}: ${failedRecordings.length} recording${failedRecordings.length === 1 ? "" : "s"} failed: ` +
          `${details.join(", ")}; the recordings were preserved`);
        failures.push(error);
        t.diagnostic(`cleanup failed: ${error.stack ?? error}`);
      }
      for (const folder of left) t.diagnostic(`kept recording: ${folder}`);
    } else if (pendingDisposal) {
      pendingDisposal.push(...left);
    } else {
      for (const folder of left) {
        try {
          rmSync(folder, { recursive: true, force: true });
        } catch (error) {
          failures.push(error);
          t.diagnostic(`cleanup failed: ${error.stack ?? error}`);
        }
      }
    }
    // The end of the test is marked after the cleanups, error audit and recording check, so the range in the log holds
    // every record they cause. The result is fail when the body, a cleanup, the audit or recording check failed.
    try {
      await session.markTest("end", t.name, t.passed && failures.length === 0 ? "pass" : "fail");
    } catch (error) {
      failures.push(error);
      t.diagnostic(`cleanup failed: ${error.stack ?? error}`);
    }
  } finally {
    // The end mark is a request that may start a stall sample, and a sample stores its dump through the connection, so
    // every sample ends before the connection is closed.
    await settleStallSamples(t, session, failures);
    close();
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw joinedFailure(`${failures.length} cleanup steps failed`, failures);
}

/**
 * Waits for every stall sample that the session holds, including a sample that starts while it waits. A sample that
 * recorded the host is reported as a diagnostic, and a failed sample is a failure with its reason.
 */
async function settleStallSamples(t, session, failures) {
  while (session.stallSamples.size) {
    const held = [...session.stallSamples];
    session.stallSamples.clear();
    for (const { line, error } of await Promise.all(held)) {
      if (error) {
        failures.push(error);
        t.diagnostic(`cleanup failed: ${error.stack ?? error}`);
      } else {
        t.diagnostic(`stall sample: ${line}`);
      }
    }
  }
}


/** The connection to one application. A request targets one window. */
export class Session {
  constructor(app, client) {
    this.app = app;
    this.client = client;
    this.window = "main";
    this.cleanups = [];
    this.recordings = new Set();
    this.failedRecordings = new Map();
    this.inputSourceRestore = { original: null, capture: null, requester: this };
    // The location of the application log that the check starts reading and the format of the errors that the check
    // declares it causes. finishSession uses them.
    this.expectedErrors = [];
    // The recording folders that existed when the session opened. finishSession judges a folder not in this set as a
    // recording that the check left.
    this.recordingsBefore = [];
    // The synthetic presses that stay open from the delivered down until the up of the same button is delivered. They
    // are found by window and button (docs/spec/exposure.md).
    this.presses = new Map();
    // The stall samples that requests of the session started after STALL_AFTER, each as a promise of {line} or {error}.
    // finishSession waits for each one and reports it, so no sample process outlives the check.
    this.stallSamples = new Set();
    // The moment the session opened. step writes the time of each step from it.
    this.started = performance.now();
  }

  /** Writes a step that the check starts with its time since the session opened, so a check that its test time limit
   * ends names the step that ran. */
  step(what) {
    process.stderr.write(`step ${this.app.name} +${((performance.now() - this.started) / 1000).toFixed(1)} s ${what}\n`);
  }

  /**
   * Quits the application through diagnostics.host.relaunch, which starts it again with the same executable and arguments,
   * connects to the new process once it has written its endpoint.json and waits until its page is ready
   * (docs/spec/endpoint.md#diagnostic-builds). The new process reads the files that the check left in the configuration
   * folder, such as the log policy.
   */
  async relaunch() {
    const previous = this.client.endpoint.pid;
    // The watch starts before the request, so an endpoint that the new process writes at once is not missed.
    const next = untilEndpoint(this.app.configDir, previous, 60000);
    this.step(`relaunch process ${previous}`);
    await this.request("diagnostics.host.relaunch");
    let endpoint;
    try {
      endpoint = await next;
    } catch (error) {
      // A process that exited and that no process replaced is an exit of the application, which ends its later checks too.
      if (processRuns(previous)) throw error;
      throw hostExited(this.app, previous, this.check ?? null,
        `exited in the check "${this.check}" and no process took its place (${error.message})`);
    }
    this.client.close();
    this.client = await connect({ configDir: this.app.configDir });
    if (this.client.endpoint.pid !== endpoint.pid) {
      throw new Error(`${this.app.name}: the relaunch connected to process ${this.client.endpoint.pid}, not ${endpoint.pid}`);
    }
    this.step(`relaunched as process ${endpoint.pid}`);
    // The new process writes endpoint.json before its page loads, and the page answers the status and command requests of
    // the check and of its cleanups, so the relaunch ends when every window reports a ready page.
    await this.until("host.windows", (list) => list.length > 0 && list.every((w) => w.ready),
      `the page of process ${endpoint.pid} did not become ready`);
  }

  /** Cleanups to run before the connection is closed. They run in reverse order of registration. */
  cleanup(fn) {
    this.cleanups.push(fn);
  }

  /** Registers a capture folder so the session removes it only after the whole check succeeds. */
  trackRecording(frames) {
    if (typeof frames !== "string" || frames === "") throw new Error("trackRecording requires a frame folder");
    const identity = realpathSync(frames);
    this.recordings.add(identity);
    return identity;
  }

  /**
   * The format of the error lines that this check causes on purpose and that are written to the application log. Those
   * errors are not a failure of the check.
   */
  expectError(pattern) {
    this.expectedErrors.push(pattern);
    this.appendMark({ kind: "expect_error", pattern: pattern.source, flags: pattern.flags });
  }

  /**
   * Declares that the test causes the event `event` (the full name of the catalog) in the logs of the application. The
   * judgment of the test by the log fails with the missing name when the range of the test holds no such event.
   */
  expectEvent(event) {
    if (typeof event !== "string" || event === "") throw new Error(`expectEvent needs an event name, found ${JSON.stringify(event)}`);
    this.appendMark({ kind: "expect_event", event });
  }

  /**
   * Closes this window with the ordinary close action. When the document of the closing window disappears before it
   * answers the request, the code is 1003, which also means the window is closed.
   */
  async close() {
    const code = await failure(this.run("host.window.close"));
    if (code !== null && code !== 1003) throw new Error(`${this.app.name}: closing ${this.window} failed with ${code}`);
  }

  /** A session that targets another window. It uses the same connection. */
  on(window) {
    const other = new Session(this.app, this.client);
    other.cleanups = this.cleanups;
    other.inputSourceRestore = this.inputSourceRestore;
    other.recordings = this.recordings;
    other.failedRecordings = this.failedRecordings;
    other.expectedErrors = this.expectedErrors;
    other.testName = this.testName;
    other.presses = this.presses;
    other.stallSamples = this.stallSamples;
    other.started = this.started;
    other.window = window;
    return other;
  }

  /**
   * Sends one request of the window. It ends by its answer or by the close of the connection; it has no time limit
   * (docs/spec/exposure.md: a command has no time limit). A request pending after STALL_AFTER records the host threads.
   */
  request(method, params = {}, ...rest) {
    if (rest.length > 0) throw new TypeError(`request ${method} takes no options: a request ends by its answer or the close of the connection`);
    const what = `${this.app.name} ${method} ${params.name ?? ""}`.trimEnd();
    // A request to an application that stopped replying, such as a cleanup of the same check, fails at once (F351).
    const stopped = unresponsiveError(this.app);
    if (stopped) return Promise.reject(stopped);
    this.step(`${method} ${params.name ?? ""}`.trimEnd());
    // When the host does not answer, the check records at that moment the threads of this host and of its page process
    // in the logs of the configuration folder (F69).
    const sample = async () => {
      const records = await sampleStall({
        host: this.client.endpoint.pid, pages: await pageProcesses(this.client.endpoint.pid), directory: join(this.app.configDir, "logs"),
      });
      // The host stores the path of its dump as an event so that the dump is found from the log (docs/spec/logging.md#entrances).
      const stored = await announceStall((name, params) => this.client.request(name, params), this.window, records);
      return `${records.join(", ")}; ${stored}`;
    };
    // The error keeps the name of the failed request. The code stays unchanged.
    const answer = this.client.request(method, { window: this.window, ...params }).catch(async (error) => {
      if (error instanceof EndpointError) {
        error.message = `${what}: ${error.message}`;
        // A request that the host ended while waiting for the answer of the page is also an unanswered stall, so that
        // moment is recorded.
        if (/did not reply within/.test(error.message)) {
          try {
            error.message += `; the host's threads at that moment: ${await sample()}`;
          } catch (failure) {
            error.message += `; sampling the host failed: ${failure.message}`;
          }
          // A workbench that does not reply to one more request either has stopped, so the later checks of the application fail at
          // once with this record instead of each waiting for its own timeouts (F351).
          if (!(await workbenchReplies(this.client, this.window))) {
            error.message += `; ${this.app.name} does not reply to a probe either, so its later checks fail at once`;
            writeFileSync(unresponsivePath(this.app.configDir),
              `${JSON.stringify({ check: this.check ?? null, request: what, error: error.message })}\n`);
          }
        }
      }
      throw error;
    });
    return whilePending(answer, what, sample, (text) => this.step(text),
      (started) => this.stallSamples.add(started.then((line) => ({ line }), (error) => ({ error }))));
  }

  get(name, surface) {
    return this.request("status.get", surface === undefined ? { name } : { name, surface });
  }

  run(name, params = {}, surface, ...rest) {
    if (rest.length > 0) throw new TypeError(`run ${name} takes no options: a command ends by its answer or the close of the connection`);
    return this.request("command.run", surface === undefined ? { name, params } : { name, params, surface });
  }

  rect(name, index, surface) {
    return this.request("element.rect", compact({ name, index, surface }));
  }

  act(name, action, { index, value, event, surface } = {}) {
    return this.request("element.act", compact({ name, action, index, value, event, surface }));
  }

  async pointer(x, y, phase, options = {}) {
    // The cooperative activation of macOS rejects a self-activation request of an application that the user has not
    // activated. Like a user who switches applications, the check process activates the application first, and the host
    // then waits for the active state of the key window and the web view.
    if (options.activate) activateApp(this.client.endpoint.pid);
    const button = options.button ?? "left";
    // Each named pointer holds its own press of each button (docs/spec/exposure.md#named-pointers).
    const named = options.pointer === undefined ? {} : { pointer: options.pointer };
    const key = JSON.stringify([this.window, options.pointer ?? "main", button]);
    const delivered = () => {
      if (phase === "down") this.presses.set(key, { window: this.window, ...named, x, y, button });
      if (phase === "up") this.presses.delete(key);
    };
    try {
      const result = await this.request("input.pointer", { x, y, phase, ...options });
      delivered();
      return result;
    } catch (error) {
      // 1005 means that the press or release was delivered but the notification that the document received it was late.
      // The press state of the window changed as delivered.
      if (error.code === 1005) delivered();
      // Whether the rejected event was a press or a release decides whether an open press remains, so the error names
      // the step and the location.
      error.message = `input.pointer ${phase} of the ${button} button at ${x},${y} in ${this.window}: ${error.message}`;
      throw error;
    }
  }

  /**
   * Sends up at its position for each press that the session left open. A rejected release leaves the press open, and
   * unless it is ended the check cannot press in that window (1008). While a person holds a button, input.pointer
   * rejects a release with 1007, so the cleanup first waits by notification until host.buttons reports mask 0, then
   * sends the release and requires that it is delivered (docs/spec/exposure.md). It returns a line with the waited time
   * for each ended press, and it reports the presses that it could not end together.
   */
  async releasePresses() {
    const failures = [];
    const released = [];
    for (const { window, pointer, x, y, button } of [...this.presses.values()]) {
      const session = this.on(window);
      try {
        const began = performance.now();
        await session.until("host.buttons", (value) => value.mask === 0, "a mouse button stayed pressed");
        const waited = Math.round(performance.now() - began);
        await session.pointer(x, y, "up", pointer === undefined ? { button } : { button, pointer });
        const of = pointer === undefined ? "" : ` of pointer ${pointer}`;
        released.push(`released open press: ${button}${of} at ${x},${y} in ${window} after host.buttons reported mask 0 (waited ${waited}ms)`);
      } catch (error) {
        const of = pointer === undefined ? "" : ` of pointer ${pointer}`;
        failures.push(new Error(`the synthetic ${button} press${of} at ${x},${y} in ${window} stayed open: ${error.message}`));
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw joinedFailure(`${failures.length} synthetic presses stayed open`, failures);
    return released;
  }

  /**
   * Starts a recording. The returned stop sends diagnostics.capture.stop once and returns its result or error. When
   * stop fails, the host may already have ended the recording, so a second stop is not sent. The cleanup sends stop only
   * if none was sent. finishSession removes the folder only after every cleanup and the error audit succeed.
   * The folder of a failed check is its evidence: stop writes its whole reply, every layout transaction included, to
   * stop.json, and keep(name, value) writes a value that the check judged, such as its displayed states, to <name>.json.
   */
  async record(params = {}) {
    // Frame identity is decoded from the captured pixels of the window, which a window that is covered whole does not present.
    if (params.frameIdentity) requireUncovered(this, await this.get("host.window"));
    const { frames } = await this.request("diagnostics.capture.start", params);
    let sent = false;
    const identity = this.trackRecording(frames);
    this.cleanup(async () => {
      try {
        if (!sent) await this.request("diagnostics.capture.stop", { after: 0 });
      } catch (error) {
        this.failedRecordings.set(identity, error);
        throw error;
      }
    });
    return {
      frames,
      stop: (options = {}) => {
        if (sent) return Promise.reject(new Error(`the stop was already sent for the recording ${frames}`));
        sent = true;
        return this.request("diagnostics.capture.stop", options).then((result) => {
          requireCallbackStatusArtifact(result, frames);
          writeFileSync(join(frames, "stop.json"), JSON.stringify(result));
          return result;
        }).catch((error) => {
          this.failedRecordings.set(identity, error);
          throw error;
        });
      },
      keep: (name, value) => {
        if (!/^[a-z][a-z-]*$/.test(name)) throw new Error(`a kept value needs a plain name, not ${JSON.stringify(name)}`);
        writeFileSync(join(frames, `${name}.json`), JSON.stringify(value));
      },
    };
  }

  /**
   * Marks the start or the end of the test `name` in the event log of the application (`diagnostics.test.mark`) and appends
   * `{run, app, name, kind, boot, seq, ts_us}` to marks.jsonl in SOKSAK_RUN_FOLDER, so a test is a range of positions
   * `(boot, seq)`. `result` (`pass`, `fail` or `skip`) belongs to the end mark. Returns the position `{boot, seq}`.
   * The single condition: without SOKSAK_RUN_ID the check does not run under a test runner that keeps a run, so nothing is
   * marked and null is returned.
   */
  async markTest(kind, name, result) {
    const run = process.env.SOKSAK_RUN_ID;
    if (!run) return null;
    const folder = process.env.SOKSAK_RUN_FOLDER;
    if (!folder) throw new Error("SOKSAK_RUN_ID is set but SOKSAK_RUN_FOLDER is not; the runner sets both");
    const position = await this.request("diagnostics.test.mark", result === undefined ? { kind, name, run } : { kind, name, run, result });
    if (kind === "start") this.testName = name;
    this.appendMark({ kind, name, boot: position.boot, seq: position.seq });
    return position;
  }

  /**
   * Appends a record of the test under the run to marks.jsonl: `{run, app, config, name, ...record, ts_us}`, where `config`
   * is the configuration folder of the application, so the audit of a run finds the logs of the applications it used from
   * the marks. A declaration (`expect_error`, `expect_event`) belongs to the test that started in this session. Nothing is
   * written without SOKSAK_RUN_ID (see markTest).
   */
  appendMark(record) {
    const run = process.env.SOKSAK_RUN_ID;
    if (!run) return;
    const folder = process.env.SOKSAK_RUN_FOLDER;
    if (!folder) throw new Error("SOKSAK_RUN_ID is set but SOKSAK_RUN_FOLDER is not; the runner sets both");
    const name = record.name ?? this.testName;
    if (name === undefined) throw new Error(`${this.app.name}: the ${record.kind} declaration comes before the start mark of the test`);
    const ts_us = Math.round((performance.timeOrigin + performance.now()) * 1000);
    appendFileSync(join(folder, "marks.jsonl"), `${JSON.stringify({ run, app: this.app.name, config: this.app.configDir, name, ...record, ts_us })}\n`);
  }

  /** Waits until the records the application wrote so far are in its event log. */
  flushLog() {
    return this.request("diagnostics.log.flush");
  }

  key(key, phase, options = {}) {
    return this.request("input.key", { key, phase, ...options });
  }

  /** A native click with press and release. */
  async click(x, y) {
    await this.until("host.buttons", (value) => value.mask === 0, "a mouse button stayed pressed");
    await this.pointer(x, y, "down");
    await this.until("host.buttons", (value) => value.mask === 0, "a mouse button stayed pressed");
    await this.pointer(x, y, "up");
  }

  /**
   * In activation-tier checks, moves the window to the left or right of the pointer so that the system pointer is
   * outside the window. The key window of an active application receives the pointer position as a move, so a pointer
   * inside the window would interleave a move between the synthetic press and release. When the window fits on neither
   * side, the window width is reduced to fit the wider side.
   */
  async keepPointerOutside() {
    const window = await this.get("host.window");
    const { pointer } = window;
    const inside = (rect) => pointer.x >= rect.x && pointer.x < rect.x + rect.width &&
      pointer.y >= rect.y && pointer.y < rect.y + rect.height;
    if (!inside(window.frame)) return;
    const screen = (await this.get("host.screens")).find((item) => inside(item));
    if (!screen) throw new Error(`${this.app.name}: the pointer ${JSON.stringify(pointer)} is on no screen`);
    const area = screen.visible;
    const left = Math.floor(pointer.x - area.x);
    const right = Math.floor(area.x + area.width - pointer.x) - 1;
    const width = Math.min(window.frame.width, Math.max(left, right));
    if (width < window.frame.width) {
      await this.run("host.window.resize", { width, height: window.content.height });
      await this.until("host.window", (value) => value.frame.width === width,
        `the window did not narrow to ${width} points beside the pointer`);
    }
    const frame = (await this.get("host.window")).frame;
    const x = left >= frame.width ? area.x : area.x + area.width - frame.width;
    const candidate = { x, y: frame.y, width: frame.width, height: frame.height };
    await this.run("host.window.move", { x, y: frame.y });
    try {
      await this.until("host.window", (value) => value.frame.x === x && !(value.pointer.x >= value.frame.x &&
        value.pointer.x < value.frame.x + value.frame.width && value.pointer.y >= value.frame.y &&
        value.pointer.y < value.frame.y + value.frame.height), "the window did not move away from the pointer");
    } catch (error) {
      let actual;
      try {
        actual = await this.get("host.window");
      } catch (readError) {
        throw joinedFailure(`${this.app.name}: pointer-outside placement failed and final geometry could not be read`, [error, readError]);
      }
      const details = {
        initialPointer: pointer,
        screenVisible: area,
        candidate,
        actual: { frame: actual.frame, pointer: actual.pointer },
      };
      error.message = `${error.message}; keepPointerOutside=${JSON.stringify(details)}`;
      throw error;
    }
  }

  /**
   * Selects the keyboard input source of `role` (`latin`, `korean` or `japanese`, docs/spec/endpoint.md) and restores the earlier
   * input source when the check ends. The current input source decides the characters of native keys, so a check that types
   * English selects the `latin` role first. The earlier input source is restored by the `source` value that the endpoint reported
   * for it, which the check never reads, so a person's input source without a role is restored too. Selecting an input source does
   * not activate a window.
   */
  async selectInputSource(role) {
    const inputSourceRestore = this.inputSourceRestore;
    if (!inputSourceRestore.capture) {
      inputSourceRestore.capture = this.request("diagnostics.input.source").then(({ source }) => {
        inputSourceRestore.original = source;
        this.cleanups.unshift(() => inputSourceRestore.requester.request("diagnostics.input.source", {
          restore: inputSourceRestore.original,
        }));
      });
    }
    await inputSourceRestore.capture;
    const selected = await this.request("diagnostics.input.source", { select: role });
    if (selected.current !== role) throw new Error(`${this.app.name}: input source ${role} was not selected (current ${selected.current})`);
  }

  /** A native key with press and release. */
  async press(key, options = {}) {
    await this.key(key, "down", options);
    await this.key(key, "up", options);
  }

  /**
   * Waits by notification until the status satisfies the predicate and returns that status value. The predicate returns true or
   * false (client watch refuses any other answer). A wait on a status of a surface starts when the
   * surface has registered the status, because a view surface registers its exposure after its phase `ready`. The wait has no
   * time limit: it ends by the value, a failed answer, an error of the predicate or the close of the connection.
   */
  async until(name, predicate, message, options = {}) {
    if (Object.hasOwn(options, "timeout")) throw new TypeError(`until ${name} takes no timeout: a wait ends by its event or the close of the connection`);
    const { surface, ...rest } = options;
    if (Object.keys(rest).length > 0) throw new TypeError(`until ${name} has no option ${Object.keys(rest).join(", ")}`);
    if (surface !== undefined) await this.registered(surface, [`status ${name}`]);
    this.step(`until ${name}`);
    return this.client.watch(this.window, name, predicate, { surface }).catch((error) => {
      // When the watch or the first value request fails, the error names the status. The code stays unchanged.
      if (error instanceof EndpointError) error.message = `${this.app.name} status ${name}: ${error.message}`;
      // A watch that ended by the close of the connection or by an error of the predicate names what did not arrive.
      else error.message = `${this.app.name}: ${message} (${error.message})`;
      throw error;
    });
  }

  /**
   * Waits until the surface has registered every entry of `entries` (`status <name>`, `command <name>` or `element <name>`, as
   * `core.surfaces` lists them). The phase `ready` of a view surface means that the view declared its composition; the view
   * registers its exposure after that (docs/spec/native-surfaces.md), so a check that runs a command or reads a status of a
   * new view waits here.
   */
  registered(surface, entries, message = `surface ${surface} did not register ${entries.join(", ")}`) {
    return this.until("core.surfaces", (surfaces) => surfaces.some((item) =>
      item.surface === surface && entries.every((entry) => item.exposes.includes(entry))), message);
  }

  /**
   * Collects every change of the status, including the value at the start of the watch. stop() ends the watch and
   * returns the collected values.
   */
  async collect(name) {
    const values = [];
    const off = this.client.on("status.changed", (params) => {
      if (params?.window === this.window && params?.name === name && params?.surface === undefined) {
        values.push(params.value);
      }
    });
    await this.request("status.watch", { name });
    values.push(await this.get(name));
    return {
      values,
      stop: async () => {
        await this.request("status.unwatch", { name });
        off();
        return values;
      },
    };
  }

  /**
   * Waits until the main page and the visible application document show the current layout. The result is the display
   * time { displayed } of that screen.
   */
  presented() {
    return this.run("host.window.presented");
  }

  /** Waits until host.windows reports count windows and the page of every window is ready. */
  windows(count, message) {
    return this.until("host.windows", (list) => list.length === count && list.every((w) => w.ready), message);
  }

  /** The visible surfaces; with plugin given, only the surfaces of that plugin. The entries of core.surfaces. */
  async surfaces(plugin) {
    const all = await this.get("core.surfaces");
    return all.filter((surface) => surface.visible && (plugin === undefined || surface.plugin === plugin));
  }

  /**
   * Collects the transcript lines that the workbench reports. stop() turns the transcript off and returns the collected
   * lines. The workbench sends each line as the record workbench.record.info, declared in `catalog`; a policy file of the configuration
   * folder that does not store that record is an error at once that names the record and the policy
   * (docs/spec/logging.md#policy), because a wait on the lines would end only at its deadline.
   */
  async transcript(catalog) {
    if (catalog === undefined) throw new Error("transcript: give the catalog that declares workbench.record.info, the record of the transcript lines");
    requireStored(readPolicy(this.app.configDir), catalog, ["workbench.record.info"], policyFile(this.app.configDir));
    const lines = [];
    const off = this.client.on("diagnostics.log", (params) => {
      if (params?.window === this.window) lines.push(params.line);
    });
    await this.request("diagnostics.transcript", { on: true });
    return {
      lines,
      /** Waits until a line satisfies the predicate. The wait ends by that line or by the close of the connection. */
      until: (predicate, message, ...rest) => new Promise((resolve, reject) => {
        if (rest.length > 0) throw new TypeError("transcript until takes no time limit: it ends by its line or the close of the connection");
        let settled = false;
        const end = () => {
          settled = true;
          offCheck();
        };
        const check = () => {
          if (settled || !predicate(lines)) return;
          end();
          resolve(lines);
        };
        const offCheck = this.client.on("diagnostics.log", () => queueMicrotask(check));
        this.client.ended.then((error) => {
          if (settled) return;
          end();
          reject(new Error(`${this.app.name}: ${message} before ${error.message}:\n${lines.join("\n")}`));
        });
        check();
      }),
      stop: async () => {
        off();
        await this.request("diagnostics.transcript", { on: false });
        return lines;
      },
    };
  }
}

function compact(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

/** Fails when the promise does not answer within ms. A search of a check that has its own end uses it; a request does not. */
export function within(promise, ms, what) {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not answer within ${ms} ms`)), ms);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

/**
 * Returns the promise unchanged and records the host threads when it is still pending at STALL_AFTER (F69). The record ends no
 * wait. A request still pending at STALL_AFTER starts the host and page samples in the same turn, so a stall keeps its stacks.
 * The sample goes on after the promise answers, so hold receives its promise, which resolves to the reported line or rejects
 * with the reason of the failed sample; the session waits for it. The line also goes to report.
 */
export function whilePending(promise, what, sample, report, hold) {
  if (typeof report !== "function") throw new Error("whilePending needs a report function");
  if (typeof hold !== "function") throw new Error("whilePending needs a hold function");
  const stall = setTimeout(() => {
    const pending = `${what} still pending after ${STALL_AFTER} ms`;
    hold(sample().then(
      (text) => {
        const line = `${pending}; the host's threads at that moment: ${text}`;
        report(line);
        return line;
      },
      (error) => {
        const line = `${pending}; sampling the host failed: ${error.message}`;
        report(line);
        throw new Error(line);
      },
    ));
  }, STALL_AFTER);
  return promise.finally(() => clearTimeout(stall));
}

/** Returns the code of the EndpointError when the request fails, and null when it succeeds. */
export async function failure(promise) {
  try {
    await promise;
    return null;
  } catch (error) {
    if (error instanceof EndpointError) return error.code;
    throw error;
  }
}

/** The content size that both hosts use for a new window. The checks start from this size. */
const START = { width: 1200, height: 760 };

/**
 * Puts the window into the start state of a check. It closes the other windows, restores the size and position of the
 * window, opens the test project with the settings in a new layout (diagnostics.fixture), starts the workbench again and
 * verifies that no display failure occurred in between. Waiting for the surfaces of the layout is done by the
 * preparation of the repository that knows those surfaces.
 *
 * `log` is the value of the setting `diagnostics.log` that the check declares (docs/spec/logging.md#policy); the default
 * `{}` is the default policy, which stores only `error`. `reads` names the records below `error` that the check reads, declared
 * in `catalog`; a record that the declared policy does not store is an error before the preparation changes anything. The
 * performance trace stores its events in the class `call` at the level `debug`, so with `performanceTrace` the policy stores
 * that class at least at `debug`. A check that does not measure stores the class `lifecycle` at least at `info`, so a failed check
 * keeps the open and the close of each sidecar session; a check with `measure` runs under the policy that it declares, which is the
 * default policy without `log`. The preparation waits until the policy file of the configuration folder holds the policy.
 */
export async function prepareFixture(s, { settings = {}, performanceTrace = TRACE, log = {}, reads = [], catalog, measure = false } = {}) {
  if (Object.hasOwn(settings, "diagnostics.log")) {
    throw new Error("prepareFixture: the check declares its log policy with log, not with the setting diagnostics.log");
  }
  const traced = performanceTrace && !policyAllows(policyOfSetting(log), "call", "debug") ? { ...log, call: "debug" } : log;
  // A failed check keeps the lifecycle of its processes: a sidecar writes the open and the close of each session in the class
  // lifecycle at the level info, and a session that a view lost leaves no other record of who closed it. A check that measures
  // runs under the policy that it declares, because the policy has one level per class for every writer and the stored events
  // are part of the cost it measures.
  const kept = measure || policyAllows(policyOfSetting(traced), "lifecycle", "info") ? traced : { ...traced, lifecycle: "info" };
  const policy = policyOfSetting(kept);
  requireStored(policy, catalog, reads, "the declaration of the check");
  // Remember the values before the preparation changes the settings. A person also uses the check application, so the
  // values return when the check ends (F129).
  await keepCommonSettings(s);
  for (const window of await s.get("host.windows")) {
    if (window.window !== s.window) await s.on(window.window).close();
  }
  await s.windows(1, "extra windows did not close");
  await s.run("host.window.maximize", { on: false });
  await s.run("host.window.resize", START);
  await s.until("host.window", (w) => w.content.width === START.width && w.content.height === START.height,
    "the window did not return to its start size");
  await place(s);
  // A display failure during the fixture replacement is not covered up and passed by the normal state of the next
  // document.
  const verification = await s.collect("core.verify");
  const presentationErrors = [];
  const offErrors = s.client.on("diagnostics.log", (params) => {
    if (params?.window === s.window && /^error workbench host (syncSurfaces|presentSurfaces) failed:/.test(params.line)) {
      presentationErrors.push(params.line);
    }
  });
  const initial = verification.values.length;
  let records;
  try {
    await s.request("diagnostics.fixture", { settings: { ...settings, "diagnostics.performance": performanceTrace, "diagnostics.log": kept } });
    await untilPolicy(s.app.configDir, policy);
    await s.presented();
    if (presentationErrors.length) {
      throw new Error(`test preparation reported presentation errors before reload: ${JSON.stringify(presentationErrors)}; ` +
        `native state: ${JSON.stringify(await s.get("host.window"))}`);
    }
    const before = (await s.get("core.window.workbench")).start;
    await s.run("host.window.reload");
    await s.until("core.window.workbench", (workbench) => workbench.start !== before && workbench.readyState === "complete",
      "the workbench did not start again");
  } finally {
    offErrors();
    records = await verification.stop();
  }
  const failed = records.slice(initial).flatMap((value) => value?.rows ?? [])
    .filter((row) => row.name === "Surface presentation" && !row.ok);
  if (failed.length) throw new Error(`test preparation reported presentation errors: ${JSON.stringify(failed)}`);
  if (presentationErrors.length) throw new Error(`test preparation reported presentation errors: ${JSON.stringify(presentationErrors)}`);
}

/**
 * Remembers the current shared settings and restores the changed values when the check ends. A check that changes
 * shared settings calls this after its preparation. The check application is also used by people, so a value changed by
 * a check must not remain.
 */
export async function keepCommonSettings(s) {
  // The common values, not the effective ones: a value that the project of the check overrides is not a common value.
  const before = (await s.get("core.settings")).common;
  s.cleanup(async () => {
    const now = (await s.get("core.settings")).common;
    const patch = Object.fromEntries(Object.entries(before)
      .filter(([key, value]) => JSON.stringify(now[key]) !== JSON.stringify(value)));
    if (Object.keys(patch).length) await s.run("core.settings.set", { patch, scope: "common" });
  });
}

/**
 * The window position that is fixed for each check application, in the visible work area `area` of the main screen,
 * for a window of the frame `frame`. All three sit at the top edge of the area: wailsv3 at the left edge, tauriv2 at the
 * right edge and mygo horizontally centred, at `area.x + floor((area.width - frame.width) / 2)`. The centre differs from
 * both edge positions whenever the window is narrower than the area, and it keeps the window inside the area as the two
 * edge positions do; it is rounded down so that, like the edge positions of an area and a frame in whole points, it is
 * a whole point. The window position of a check therefore does not depend on the position that an earlier check moved
 * it to. When the work area is narrower than the sum of two window widths, the windows overlap. Two
 * windows at the same position do not hide each other completely (the shadow of the window is visible, V5-86), and a
 * window of another application can cover a check window regardless of this position.
 */
export function windowPosition(name, area, frame) {
  const left = {
    wailsv3: area.x,
    tauriv2: area.x + area.width - frame.width,
    mygo: area.x + Math.floor((area.width - frame.width) / 2),
  };
  if (!Object.hasOwn(left, name)) throw new Error(`windowPosition: unknown application ${name}`);
  return { x: left[name], y: area.y };
}

/** Moves the window of the session to its windowPosition. Moving a window does not activate the application. */
async function place(s) {
  const [screen] = await s.get("host.screens");
  const { frame } = await s.get("host.window");
  const { x, y } = windowPosition(s.app.name, screen.visible, frame);
  if (frame.x === x && frame.y === y) return;
  await s.run("host.window.move", { x, y });
  await s.until("host.window", (w) => w.frame.x === x && w.frame.y === y, `the window did not move to its check frame ${x},${y}`);
}

// SOKSAK_PERFORMANCE_TRACE=1 turns the performance trace on in every check preparation to keep the order of
// registration losses. Other values are rejected.
export const TRACE = { undefined: false, "1": true }[process.env.SOKSAK_PERFORMANCE_TRACE];
if (TRACE === undefined) throw new Error(`SOKSAK_PERFORMANCE_TRACE must be unset or 1, not ${process.env.SOKSAK_PERFORMANCE_TRACE}`);

/**
 * Runs a boundary drag with the host clock. With capture, it records the window and returns the frame folder. The
 * recording is removed when the check passes and kept when the check fails.
 *
 * Fails when the drag does not run at the requested rate. A pass of a slow drag is not a pass, and a second drag that
 * runs at the rate would make the check pass by chance, so the first drag that is not paced fails the check.
 */
export async function drag(s, plan, { capture = false, frameIdentity } = {}) {
  if (frameIdentity !== undefined && typeof frameIdentity !== "boolean") {
    throw new TypeError("frameIdentity must be a boolean");
  }
  if (frameIdentity === true && capture !== true) {
    throw new TypeError("frameIdentity requires capture to be true");
  }
  const result = await dragOnce(s, plan, capture, frameIdentity === true);
  if (!paced(result)) {
    // The waits before the presses are not in took; they and the load of the machine tell a late host from a busy one.
    throw new Error(
      `the drag did not run at the rate it was asked to: it took ${result.took}ms for ${result.asked}ms, not between ` +
        `${Math.round(result.asked / MARGIN)}ms and ${Math.round(result.asked * MARGIN)}ms; pressWaits ` +
        `${JSON.stringify(result.pressWaits ?? null)}; 1-minute load average ${loadavg()[0].toFixed(2)}. The steps come ` +
        "from the host, whose clock is not held wherever the window is. Nothing was measured: an unrendered area " +
        "shows itself at the speed a person drags at, and a slow drag passing is not a pass.",
    );
  }
  return result;
}

const MARGIN = 1.25;

/**
 * The allowed limit (ms) of the display interval between recorded frames. During a drag the screen changes with every
 * frame.
 */
const GAP = 100;

const paced = ({ took, asked }) => took <= asked * MARGIN && took >= asked / MARGIN;

/** The status of a stream callback whose window did not change since the last frame (SCFrameStatusIdle). */
const IDLE = 1;

/**
 * Whether the recorder saw the window unchanged through the longest gap between the complete frames of the callback status
 * file `path`: every callback inside that gap is idle, and no two callbacks, with the frames at its ends, are more than
 * GAP apart.
 */
function sawUnchanged(path) {
  const callbacks = readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).map((row) => ({
    status: row.status,
    complete: row.status === 0 && typeof row.frame === "string",
    ms: Number(BigInt(row.displayTime) * BigInt(row.machTimebaseNumerator) / BigInt(row.machTimebaseDenominator)) / 1e6,
  }));
  const frames = callbacks.map((callback, index) => ({ ...callback, index })).filter((callback) => callback.complete);
  let widest = null;
  for (let i = 1; i < frames.length; i++) {
    if (!widest || frames[i].ms - frames[i - 1].ms > widest[1].ms - widest[0].ms) widest = [frames[i - 1], frames[i]];
  }
  if (!widest) return false;
  const inside = callbacks.slice(widest[0].index + 1, widest[1].index);
  if (inside.length === 0 || inside.some((callback) => callback.status !== IDLE)) return false;
  const times = [widest[0], ...inside, widest[1]].map((callback) => callback.ms);
  return times.every((ms, i) => i === 0 || ms - times[i - 1] <= GAP);
}

function requireCallbackStatusArtifact(result, frames) {
  const expected = join(frames, "callback-status.jsonl");
  if (result.callbackStatus !== expected || !existsSync(expected)) {
    throw new Error(`capture stop callback status artifact is missing or has the wrong path: expected ${expected}, got ${result.callbackStatus}`);
  }
  return expected;
}

/**
 * The owner name of the other window that covers the window. It is stated as the reason why the measurement is skipped
 * because the window is covered.
 */
export function coveredBy(s, window, windows) {
  const covering = coveringWindows(s.client.endpoint.pid, window.frame, windows);
  return covering.length ? covering.map(({ owner, frame }) => `${owner} at ${JSON.stringify(frame)}`).join(", ")
    : "windows that together cover it";
}

/**
 * Refuses a measurement of the pixels of a window that host.window `window` of session `s` reports `occluded`: WebKit renders a
 * window that is covered whole less often, so its frames do not show what the check does. The error names the covering windows
 * (coveredBy, from the window list that `windows` gives, the window list of the screen by default) and states that nothing was
 * measured.
 */
export function requireUncovered(s, window, windows) {
  if (!window.occluded) return;
  throw new Error(`${s.app.name}'s window is completely covered by ${coveredBy(s, window, windows)}, so WebKit renders it less often. ` +
    "Nothing was measured: uncover the window, without activating the application, and run the check again.");
}

/** The holds of the covered drawing, by the connection of a session and its window. */
const coveredHolds = new WeakMap();

/**
 * Holds the covered drawing of the window of session `s` (diagnostics.window.draw-covered): its image regions draw and its
 * document regions render while the window is occluded or minimized, and the window keeps reporting its occlusion
 * (docs/spec/native-surfaces.md#image-regions). The drawing is one state of the window, so every hold of it on one connection
 * shares it: the first hold turns it on and the last release turns it off, and a gesture that holds it for its own duration
 * does not end the drawing that a check holds for its whole run. Returns the release, which ends this hold once.
 */
export async function holdCovered(s) {
  let windows = coveredHolds.get(s.client);
  if (!windows) coveredHolds.set(s.client, windows = new Map());
  const window = s.window ?? "main";
  const held = windows.get(window) ?? 0;
  windows.set(window, held + 1);
  if (held === 0) {
    try {
      await s.request("diagnostics.window.draw-covered", { draw: true });
    } catch (error) {
      windows.set(window, windows.get(window) - 1);
      throw error;
    }
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    const left = windows.get(window) - 1;
    windows.set(window, left);
    if (left === 0) await s.request("diagnostics.window.draw-covered", { draw: false });
  };
}

async function dragOnce(s, plan, capture, frameIdentity) {
  // An active window receives the cursor update of AppKit when the layout changes, and the window passes the real
  // pointer position to the page as a move. A diagnostic drag that is synthesized without a button mixes with that
  // move, so it is measured only in an inactive application.
  const window = await s.get("host.window");
  if (window.active) {
    throw new Error(`${s.app.name}: synthetic drag measurement refused because host.window.active is true; ` +
      `pointer ${JSON.stringify(window.pointer)}; window frame ${JSON.stringify(window.frame)}. ` +
      "An active window can receive AppKit cursor updates at the reported pointer location during the synthetic drag; " +
      "nothing was measured.");
  }
  // An inactive application shows a new window behind the frontmost window, where its image regions do not draw. The drag
  // holds the covered drawing for its duration, so the recording holds the regions; the window keeps its place and keeps
  // reporting its occlusion, and a covered drawing that the check holds stays on after the drag (holdCovered).
  const release = await holdCovered(s);
  try {
    return await dragDrawing(s, plan, capture, frameIdentity);
  } finally {
    await release();
  }
}

async function dragDrawing(s, plan, capture, frameIdentity) {
  const result = await s.request("diagnostics.drag", {
    ...plan,
    capture,
    ...(frameIdentity ? { frameIdentity: true } : {}),
  });
  if (!capture) return result;
  s.trackRecording(result.frames);
  // Records until the time when the last screen of the drag is displayed.
  const { displayed } = await s.presented();
  const stopped = await s.request("diagnostics.capture.stop", { after: displayed });
  const callbackStatus = requireCallbackStatusArtifact(stopped, result.frames);
  if (stopped.limited) {
    throw new Error("the recording reached its finite frame limit before the gesture completed");
  }
  // A drag changes the screen with every frame, so recorded frames more than GAP apart fail the check, and the error
  // says which of the two it was: the recorder saw the window unchanged through the gap, or it saw nothing.
  if (stopped.longestGap > GAP) {
    const gap = stopped.longestGap.toFixed(0);
    const load = `1-minute load average ${loadavg()[0].toFixed(2)}`;
    throw new Error(sawUnchanged(callbackStatus)
      ? `the window presented nothing new for ${gap}ms (the recorder saw it unchanged); a drag changes the screen ` +
        `with every frame, so a presentation more than ${GAP}ms apart fails; ${load}`
      : `the recording has a ${gap}ms gap between frames; frames longer than ${GAP}ms apart were not recorded, so ` +
        `this run did not measure the whole gesture; ${load}`);
  }
  return {
    ...result,
    callbackStatus,
    displayed,
    count: stopped.count,
    longestGap: stopped.longestGap,
    frameDir: stopped.frames,
    ...(frameIdentity ? { frameIdentity: stopped.frameIdentity } : {}),
  };
}
