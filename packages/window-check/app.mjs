// Connects to the local endpoint of a running example application, prepares its state and records drags.
//
// The checks do not launch the application. The application must already run with `--config-dir
// <tmpdir>/soksak-check-<app>`, and the harness connects through the endpoint.json of that folder. The specification is
// in docs/spec/endpoint.md and docs/spec/exposure.md.
import { appendFileSync, closeSync, existsSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, EndpointError } from "@soksak/client";
import { activateApp, coveringWindows, frontmostApp, restoreFrontmost } from "./frontmost.mjs";
import { announceStall, pageProcesses, sampleStall } from "./stall-sample.mjs";
import { readEventErrors, readEventOffsets, writeEventOffsets } from "./event-log.mjs";
import { pasteboardDifference, readPasteboard, writePasteboard } from "./pasteboard.mjs";

// The launch declares the application executables that are checked. SOKSAK_BINARY_WAILSV3 and SOKSAK_BINARY_TAURIV2
// hold the executable path inside the bundle of each application (docs/operations/examples.md#window-checks). The
// checks of core find these paths in the build output folder and pass them on; the checks of other repositories declare
// the build to check themselves.
const declared = (name) => {
  const variable = `SOKSAK_BINARY_${name.toUpperCase()}`;
  const path = process.env[variable];
  if (!path) throw new Error(`${variable} is not set; it names the executable of the ${name} application to check`);
  return path;
};

/** The applications to check: the executable and the configuration folder. */
const appNames = process.env.SOKSAK_APP ? [process.env.SOKSAK_APP] : ["wailsv3", "tauriv2"];
if (!appNames.every((name) => ["wailsv3", "tauriv2"].includes(name))) {
  throw new Error(`unknown SOKSAK_APP: ${process.env.SOKSAK_APP}`);
}

export const APPS = Object.fromEntries(appNames.map((name) => [name, {
  name,
  // The executable is read when it is used. Without a declaration, the check that tests that application fails and
  // names the variable.
  get binary() { return declared(name); },
  // default: without an explicit configuration directory or isolated root from the launch, window checks use a
  // disposable temporary endpoint directory.
  configDir: process.env.SOKSAK_CONFIG_DIR ?? join(process.env.SOKSAK_CONFIG_ROOT ?? tmpdir(), `soksak-check-${name}`),
}]));

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

/** The default wait time of one request. It is longer than the document response time of the host. */
const REQUEST = 20_000;

/**
 * The sequential-run lock between check files. A second check run fails without waiting. The lock file holds the number
 * of the owning process; when that process does not exist, the lock is a remnant and is replaced.
 */
const LOCK = join(tmpdir(), "soksak-check.lock");

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
let baselineFrontmost = null;
let baselineCaptured = false;
/**
 * The process numbers of the hosts that the checks of this process opened. A check fails when one of them stays active
 * after the check.
 */
const testedHosts = new Set();

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
 * Connects to one application. When the executable does not exist, it returns null and the check is skipped. The
 * connection is closed when the check ends.
 *
 * Verifies that the process of endpoint.json is the executable of this repository, so that the check does not test an
 * application of another checkout or an earlier build.
 */
export async function open(t, app) {
  if (!existsSync(app.binary)) return null;
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
        "after make e2e-registry-tls, and run them again.",
    );
  }
  const session = new Session(app, client);
  // A check can write the pasteboard of the user. This cleanup saves every item format and verifies the restored
  // pasteboard after all other cleanups have finished. Cleanups run in reverse order of registration, so this one is
  // last.
  const pasteboard = readPasteboard();
  // A full-screen transition or a new project window activates the application. When the check activated it, the check
  // restores the application that was active before at the end. The synthetic drag of the next check requires an
  // inactive application.
  testedHosts.add(client.endpoint.pid);
  const previous = frontmostApp();
  if (!baselineCaptured) {
    baselineFrontmost = previous;
    baselineCaptured = true;
  }
  if (baselineFrontmost !== null && baselineFrontmost !== client.endpoint.pid) {
    session.cleanup(async () => {
      const { before, after } = await restoreFrontmost({
        name: app.name,
        baseline: baselineFrontmost,
        host: client.endpoint.pid,
        hosts: [...testedHosts],
        inactive: () => session.until("host.window", (w) => w.active === false, "the application stayed active after the check"),
      });
      t.diagnostic(`frontmost before the check ${previous}, after the check ${before}, after restoring ${after}`);
    });
  }
  session.cleanup(() => {
    writePasteboard(pasteboard.items);
    const difference = pasteboardDifference(pasteboard.items, readPasteboard().items);
    if (difference !== null) {
      throw new Error(`${app.name}: the pasteboard after the check differs from before it: ${difference}`);
    }
  });
  // A press that the check left open is released after the cleanup of the check. Cleanups run in reverse order of
  // registration.
  session.cleanup(async () => {
    for (const line of await session.releasePresses()) t.diagnostic(line);
  });
  // The cleanup of a check runs before the connection is closed. node:test runs after hooks in registration order.
  t.after(() => finishSession(t, session, () => {
    client.close();
    releaseSlot();
  }));
  const { endpoint } = client;
  if (endpoint.application !== app.name) {
    throw new Error(`${app.configDir}/endpoint.json belongs to ${endpoint.application}, not ${app.name}`);
  }
  assertEndpointUsesCurrentBuild(endpoint, realpathSync(app.binary), statSync(app.binary).mtimeMs);
  session.eventStart = readEventOffsets(app.configDir);
  session.recordingsBefore = recordingFolders(app.configDir);
  await session.markTest("start", t.name);
  return session;
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
    // Every error line written to the application log during the check is kept as a diagnostic, and an error that the
    // check did not declare fails the check. A reload clears the error display of a document, so the log decides. The
    // log is read after the cleanups so that it includes the errors they cause.
    try {
      const { errors, offsets } = readEventErrors(session.app.configDir, session.eventStart);
      writeEventOffsets(session.app.configDir, offsets);
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
    // The end of the test is marked after the cleanups and the error audit, so the range of the test in the log holds the
    // records they cause. The result is fail when the body, a cleanup or the audit failed.
    try {
      await session.markTest("end", t.name, t.passed && failures.length === 0 ? "pass" : "fail");
    } catch (error) {
      failures.push(error);
      t.diagnostic(`cleanup failed: ${error.stack ?? error}`);
    }
    // The cleanup of a check removes the recordings that the check started. A new recording folder that remains after
    // the cleanup fails the check and is removed so that the next check starts from the same state.
    // SOKSAK_KEEP_FAILURE_CAPTURE keeps the recording of a failed check, so only its name is reported.
    const left = recordingFolders(session.app.configDir).filter((name) => !session.recordingsBefore.includes(name))
      .map((name) => join(session.app.configDir, "logs", "captures", name));
    if (left.length && process.env.SOKSAK_KEEP_FAILURE_CAPTURE) {
      for (const folder of left) t.diagnostic(`kept recording: ${folder}`);
    } else if (left.length) {
      for (const folder of left) rmSync(folder, { recursive: true, force: true });
      const error = new Error(`${session.app.name}: the check left ${left.length} recording${left.length === 1 ? "" : "s"}: ` +
        `${left.join(", ")}; a check removes the recordings it starts in its cleanup`);
      failures.push(error);
      t.diagnostic(`cleanup failed: ${error.stack ?? error}`);
    }
  } finally {
    close();
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, `${failures.length} cleanup steps failed`);
}

/** The connection to one application. A request targets one window. */
export class Session {
  constructor(app, client) {
    this.app = app;
    this.client = client;
    this.window = "main";
    this.cleanups = [];
    // The location of the application log that the check starts reading and the format of the errors that the check
    // declares it causes. finishSession uses them.
    this.expectedErrors = [];
    // The recording folders that existed when the session opened. finishSession judges a folder not in this set as a
    // recording that the check left.
    this.recordingsBefore = [];
    // The synthetic presses that stay open from the delivered down until the up of the same button is delivered. They
    // are found by window and button (docs/spec/exposure.md).
    this.presses = new Map();
    // The moment the session opened. step writes the time of each step from it.
    this.started = performance.now();
  }

  /** Writes a step that the check starts with its time since the session opened, so a check that its test time limit
   * ends names the step that ran. */
  step(what) {
    process.stderr.write(`step ${this.app.name} +${((performance.now() - this.started) / 1000).toFixed(1)} s ${what}\n`);
  }

  /** Cleanups to run before the connection is closed. They run in reverse order of registration. */
  cleanup(fn) {
    this.cleanups.push(fn);
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
    other.expectedErrors = this.expectedErrors;
    other.testName = this.testName;
    other.presses = this.presses;
    other.started = this.started;
    other.window = window;
    return other;
  }

  request(method, params = {}, { timeout = REQUEST } = {}) {
    const what = `${this.app.name} ${method} ${params.name ?? ""}`.trimEnd();
    this.step(`${method} ${params.name ?? ""}`.trimEnd());
    // When the host does not answer, the check records at that moment the threads of this host and of its page process
    // in the logs of the configuration folder (F69).
    const sample = async () => {
      const records = sampleStall({
        host: this.client.endpoint.pid, pages: pageProcesses(this.app.configDir), directory: join(this.app.configDir, "logs"),
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
        }
      }
      throw error;
    });
    return within(answer, timeout, what, sample);
  }

  get(name, surface) {
    return this.request("status.get", surface === undefined ? { name } : { name, surface });
  }

  run(name, params = {}, surface, options = {}) {
    return this.request("command.run", surface === undefined ? { name, params } : { name, params, surface }, options);
  }

  rect(name, index, surface) {
    return this.request("dom.rect", compact({ name, index, surface }));
  }

  act(name, action, { index, value, event, surface } = {}) {
    return this.request("dom.act", compact({ name, action, index, value, event, surface }));
  }

  async pointer(x, y, phase, options = {}) {
    // The cooperative activation of macOS rejects a self-activation request of an application that the user has not
    // activated. Like a user who switches applications, the check process activates the application first, and the host
    // then waits for the active state of the key window and the web view.
    if (options.activate) activateApp(this.client.endpoint.pid);
    const button = options.button ?? "left";
    const key = JSON.stringify([this.window, button]);
    const delivered = () => {
      if (phase === "down") this.presses.set(key, { window: this.window, x, y, button });
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
    for (const { window, x, y, button } of [...this.presses.values()]) {
      const session = this.on(window);
      try {
        const began = performance.now();
        await session.until("host.buttons", (value) => value.mask === 0, "a mouse button stayed pressed");
        const waited = Math.round(performance.now() - began);
        await session.pointer(x, y, "up", { button });
        released.push(`released open press: ${button} at ${x},${y} in ${window} after host.buttons reported mask 0 (waited ${waited}ms)`);
      } catch (error) {
        failures.push(new Error(`the synthetic ${button} press at ${x},${y} in ${window} stayed open: ${error.message}`));
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, `${failures.length} synthetic presses stayed open`);
    return released;
  }

  /**
   * Starts a recording. The returned stop sends diagnostics.capture.stop once and returns its result or error. When
   * stop fails, the host may already have ended the recording, so a second stop is not sent. The cleanup of the session
   * sends stop only if none was sent, and removes the recording folder (docs/operations/examples.md).
   */
  async record(params = {}) {
    const { frames } = await this.request("diagnostics.capture.start", params);
    let sent = false;
    this.cleanup(async () => {
      try {
        if (!sent) await this.request("diagnostics.capture.stop", { after: 0 });
      } finally {
        rmSync(frames, { recursive: true, force: true });
      }
    });
    return {
      frames,
      stop: (options = {}) => {
        if (sent) return Promise.reject(new Error(`the stop was already sent for the recording ${frames}`));
        sent = true;
        return this.request("diagnostics.capture.stop", options);
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
    await this.pointer(x, y, "down");
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
    await this.run("host.window.move", { x, y: frame.y });
    await this.until("host.window", (value) => value.frame.x === x && !(value.pointer.x >= value.frame.x &&
      value.pointer.x < value.frame.x + value.frame.width && value.pointer.y >= value.frame.y &&
      value.pointer.y < value.frame.y + value.frame.height), "the window did not move away from the pointer");
  }

  /**
   * Selects the keyboard input source and restores the earlier input source when the check ends. The current input
   * source decides the characters of native keys, so a check that types English selects an English layout first.
   * Selecting an input source does not activate a window.
   */
  async selectInputSource(id) {
    const original = (await this.request("diagnostics.input.source")).current;
    this.cleanup(() => this.request("diagnostics.input.source", { select: original }));
    const selected = await this.request("diagnostics.input.source", { select: id });
    if (selected.current !== id) throw new Error(`${this.app.name}: input source ${id} was not selected (current ${selected.current})`);
  }

  /** A native key with press and release. */
  async press(key, options = {}) {
    await this.key(key, "down", options);
    await this.key(key, "up", options);
  }

  /** Waits by notification until the status satisfies the predicate. */
  until(name, predicate, message, { surface, timeout = REQUEST } = {}) {
    this.step(`until ${name}`);
    return this.client.watch(this.window, name, predicate, { surface, timeout }).catch((error) => {
      if (error.code === "ETIMEDOUT") error.message = `${this.app.name}: ${message} (${error.message})`;
      // When the watch or the first value request fails, the error names the status. The code stays unchanged.
      else if (error instanceof EndpointError) error.message = `${this.app.name} status ${name}: ${error.message}`;
      throw error;
    });
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
   * Collects the transcript lines that the page reports. stop() turns the transcript off and returns the collected
   * lines.
   */
  async transcript() {
    const lines = [];
    const off = this.client.on("diagnostics.log", (params) => {
      if (params?.window === this.window) lines.push(params.line);
    });
    await this.request("diagnostics.transcript", { on: true });
    return {
      lines,
      /** Waits until a line satisfies the predicate. */
      until: (predicate, message, timeout = REQUEST) => new Promise((resolve, reject) => {
        const check = () => {
          if (predicate(lines)) {
            clearTimeout(timer);
            offCheck();
            resolve(lines);
          }
        };
        const offCheck = this.client.on("diagnostics.log", () => queueMicrotask(check));
        const timer = setTimeout(() => {
          offCheck();
          reject(new Error(`${this.app.name}: ${message} within ${timeout} ms:\n${lines.join("\n")}`));
        }, timeout);
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

/**
 * Fails when the promise does not answer within ms. When sample is given, it records the host threads at that moment
 * before failing and writes the path of that record into the error (F69). When recording fails, the error states the
 * reason.
 */
export function within(promise, ms, what, sample) {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(async () => {
      const message = `${what} did not answer within ${ms} ms`;
      if (!sample) return reject(new Error(message));
      try {
        reject(new Error(`${message}; the host's threads at that moment: ${await sample()}`));
      } catch (error) {
        reject(new Error(`${message}; sampling the host failed: ${error.message}`));
      }
    }, ms);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
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
 * window, opens the test project with the settings in a new layout (diagnostics.fixture), reloads the main document and
 * verifies that no display failure occurred in between. Waiting for the surfaces of the layout is done by the
 * preparation of the repository that knows those surfaces.
 */
export async function prepareFixture(s, { settings = {}, performanceTrace = TRACE } = {}) {
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
    if (params?.window === s.window && /^error page host (syncSurfaces|presentSurfaces) failed:/.test(params.line)) {
      presentationErrors.push(params.line);
    }
  });
  const initial = verification.values.length;
  let records;
  try {
    await s.request("diagnostics.fixture", { settings: { ...settings, "diagnostics.performance": performanceTrace } });
    await s.presented();
    if (presentationErrors.length) {
      throw new Error(`test preparation reported presentation errors before reload: ${JSON.stringify(presentationErrors)}; ` +
        `native state: ${JSON.stringify(await s.get("host.window"))}`);
    }
    const before = (await s.get("core.window.document")).timeOrigin;
    await s.run("host.window.reload");
    await s.until("core.window.document", (doc) => doc.timeOrigin !== before && doc.readyState === "complete",
      "the main document did not reload");
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
  const before = (await s.get("core.settings")).values;
  s.cleanup(async () => {
    const now = (await s.get("core.settings")).values;
    const patch = Object.fromEntries(Object.entries(before)
      .filter(([key, value]) => JSON.stringify(now[key]) !== JSON.stringify(value)));
    if (Object.keys(patch).length) await s.run("core.settings.set", { patch, scope: "common" });
  });
}

/**
 * The window position that is fixed for each check application. The first application sits at the upper left of the
 * work area of the main screen and the second at the upper right. The window position of a check therefore does not
 * depend on the position that an earlier check moved it to. When the work area is narrower than the sum of two window
 * widths, the middle overlaps. Two windows at the same position do not hide each other completely (the shadow of the
 * window is visible, V5-86), and a window of another application can cover a check window regardless of this position.
 * Moving a window does not activate the application.
 */
async function place(s) {
  const [screen] = await s.get("host.screens");
  const area = screen.visible;
  const { frame } = await s.get("host.window");
  const x = ["wailsv3", "tauriv2"].indexOf(s.app.name) === 0 ? area.x : area.x + area.width - frame.width;
  const y = area.y;
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
 * recording is removed with remove() when the check ends, whether it passed or not.
 *
 * Fails when the drag does not run at the requested rate (after one retry). A pass of a slow drag is not a pass.
 */
export async function drag(t, s, plan, { capture = false } = {}) {
  let result = await dragOnce(s, plan, capture);
  if (paced(result)) return result;
  t.diagnostic(`the drag took ${result.took}ms for ${result.asked}ms; dragging again`);
  result = await dragOnce(s, plan, capture);
  if (!paced(result)) {
    throw new Error(
      `the drag ran slower than it was asked to, twice (${result.took}ms for ${result.asked}ms). The steps come ` +
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

/**
 * The owner name of the other window that covers the window. It is stated as the reason why the measurement is skipped
 * because the window is covered.
 */
export function coveredBy(s, window) {
  const covering = coveringWindows(s.client.endpoint.pid, window.frame);
  return covering.length ? covering.map(({ owner, frame }) => `${owner} at ${JSON.stringify(frame)}`).join(", ")
    : "windows that together cover it";
}

async function dragOnce(s, plan, capture) {
  // An active window receives the cursor update of AppKit when the layout changes, and the window passes the real
  // pointer position to the page as a move. A diagnostic drag that is synthesized without a button mixes with that
  // move, so it is measured only in an inactive application.
  const window = await s.get("host.window");
  // WebKit delays the painting of a window that another window covers completely, so the latency and the recording in
  // that state are not the screen that a person sees.
  if (window.occluded) {
    throw new Error(`${s.app.name}'s window is completely covered by ${coveredBy(s, window)}, so WebKit renders it less often. ` +
      "Nothing was measured: uncover the window, without activating the application, and run the check again.");
  }
  if (window.active) {
    throw new Error(`${s.app.name}: synthetic drag measurement refused because host.window.active is true; ` +
      `pointer ${JSON.stringify(window.pointer)}; window frame ${JSON.stringify(window.frame)}. ` +
      "An active window can receive AppKit cursor updates at the reported pointer location during the synthetic drag; " +
      "nothing was measured.");
  }
  const ms = Math.max(1, Math.round(plan.ms / 16)) * 16 * 2 * plan.times;
  const result = await s.request("diagnostics.drag", { ...plan, capture }, { timeout: REQUEST + ms * 4 });
  if (!capture) return result;
  if (!process.env.SOKSAK_KEEP_FAILURE_CAPTURE) {
    s.cleanup(() => rmSync(result.frames, { recursive: true, force: true }));
  }
  // Records until the time when the last screen of the drag is displayed.
  const { displayed } = await s.presented();
  const stopped = await s.request("diagnostics.capture.stop", { after: displayed });
  if (stopped.limited) {
    throw new Error("the recording reached its finite frame limit before the gesture completed");
  }
  // When the recording was interrupted for longer than this at once, the screen in between was not recorded. An
  // unmeasured interval is not a pass.
  if (stopped.longestGap > GAP) {
    throw new Error(`the recording has a ${stopped.longestGap.toFixed(0)}ms gap between frames; ` +
      `frames longer than ${GAP}ms apart were not recorded, so this run did not measure the whole gesture`);
  }
  return { ...result, displayed, count: stopped.count, longestGap: stopped.longestGap, frameDir: stopped.frames };
}
