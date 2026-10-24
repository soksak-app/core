// Reads and restores the active application. The default window checks require an inactive application, so each check
// restores the session's validated frontmost identity when another application is active at cleanup.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// Runs a script with the JavaScript of osascript and returns the JSON result.
function jxa(body) {
  const script = `ObjC.import("AppKit");
function run(argv) { const input = JSON.parse(argv[0]); ${body} }`;
  return (input = {}) => {
    const output = execFileSync("osascript", ["-l", "JavaScript", "-e", script, JSON.stringify(input)], { encoding: "utf8" });
    return output.trim() === "" ? null : JSON.parse(output);
  };
}

const frontmost = jxa(`
const app = $.NSWorkspace.sharedWorkspace.frontmostApplication;
return JSON.stringify(app.isNil() ? null : {
  pid: app.processIdentifier,
  name: ObjC.unwrap(app.localizedName) ?? null,
  bundle: ObjC.unwrap(app.bundleIdentifier) ?? null
});`);

const identifyProcess = jxa(`
const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(input.pid);
return JSON.stringify(app.isNil() ? null : {
  pid: app.processIdentifier,
  name: ObjC.unwrap(app.localizedName) ?? null,
  bundle: ObjC.unwrap(app.bundleIdentifier) ?? null
});`);

const activate = jxa(`
const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(input.pid);
return JSON.stringify(!app.isNil() && app.activateWithOptions(0));`);

export const SESSION_BASELINE_ENV = "SOKSAK_WINDOW_CHECK_BASELINE";

/** The process number of the application that is active now. */
export function frontmostApp() {
  return frontmost()?.pid ?? null;
}

/** The process identity of the application that is active now. */
export function frontmostContext() {
  return frontmost();
}

/** Describes the application of process pid by name and bundle identifier. */
export function describeApp(pid) {
  const app = identifyProcess({ pid });
  return app === null ? `pid ${pid}, no running application` : `pid ${pid}, ${app.name ?? "no name"}, ${app.bundle ?? "no bundle identifier"}`;
}

/** Parses the one canonical baseline context passed to every worker in a window-check session. */
export function parseSessionBaseline(value) {
  if (typeof value !== "string") throw new Error(`${SESSION_BASELINE_ENV} is required`);
  let baseline;
  try {
    baseline = JSON.parse(value);
  } catch (error) {
    throw new Error(`${SESSION_BASELINE_ENV} is not valid JSON: ${error.message}`);
  }
  if (baseline === null || typeof baseline !== "object" || Array.isArray(baseline) ||
      Object.keys(baseline).sort().join(",") !== "bundle,name,pid" ||
      !Number.isSafeInteger(baseline.pid) || baseline.pid <= 0 ||
      typeof baseline.name !== "string" || baseline.name.length === 0 ||
      typeof baseline.bundle !== "string" || baseline.bundle.length === 0) {
    throw new Error(`${SESSION_BASELINE_ENV} must contain exactly a positive pid, a nonempty name and a nonempty bundle`);
  }
  return baseline;
}

/** Captures or validates the caller-declared baseline and returns an environment shared by child test processes. */
export function sessionBaselineEnvironment({ env = process.env, hosts = [], read = frontmostContext } = {}) {
  let baseline;
  if (env[SESSION_BASELINE_ENV] === undefined) {
    baseline = sessionBaseline({ hosts, read });
  } else {
    baseline = parseSessionBaseline(env[SESSION_BASELINE_ENV]);
    assertBaselineIsNotHost(baseline, hosts, (pid) => `pid ${pid}, ${baseline.name}, ${baseline.bundle}`);
  }
  return { [SESSION_BASELINE_ENV]: JSON.stringify(baseline) };
}

/** Reads the propagated baseline and verifies that its PID still identifies the same running application. */
export function sessionBaselineFromEnvironment(env = process.env, { hosts = [], identify = (pid) => identifyProcess({ pid }) } = {}) {
  const baseline = parseSessionBaseline(env[SESSION_BASELINE_ENV]);
  assertBaselineIdentity(baseline, identify);
  assertBaselineIsNotHost(baseline, hosts, (pid) => `pid ${pid}, ${baseline.name}, ${baseline.bundle}`);
  return baseline;
}

function assertBaselineIdentity(baseline, identify) {
  const current = identify(baseline.pid);
  if (current === null || current.pid !== baseline.pid || current.name !== baseline.name || current.bundle !== baseline.bundle) {
    throw new Error(`${SESSION_BASELINE_ENV} identifies pid ${baseline.pid}, ${baseline.name}, ${baseline.bundle}, ` +
      `but that process is not the same running application (${current === null ? "not running" : JSON.stringify(current)})`);
  }
}

function assertBaselineIsNotHost(baseline, hosts, describe) {
  const host = hosts.find(({ pid }) => pid === baseline.pid);
  if (host !== undefined) {
    throw new Error(`the frontmost application before the checks is tested host ${host.name} (${describe(baseline.pid)}); ` +
      `tested hosts: ${hosts.map(({ name, pid }) => `${name} pid ${pid}`).join(", ")}; nothing was measured. ` +
      "Bring another application to the front and run the checks again.");
  }
}

/**
 * Reads the application that is active before the checks as the baseline of the session. When the baseline is one of
 * the hosts to check (hosts, { name, pid }), every synthetic pointer measurement of the session would measure an active
 * application, so the check fails before the first check and names that application and host.
 */
export function sessionBaseline({ hosts, read = frontmostContext, describe = describeApp }) {
  const baseline = read();
  if (baseline === null || !Number.isSafeInteger(baseline.pid) || baseline.pid <= 0 ||
      typeof baseline.name !== "string" || baseline.name.length === 0 ||
      typeof baseline.bundle !== "string" || baseline.bundle.length === 0) {
    throw new Error("the frontmost application has no valid process identity; nothing was measured");
  }
  const host = hosts.find(({ pid }) => pid === baseline.pid);
  if (host !== undefined) {
    throw new Error(`the frontmost application before the checks is tested host ${host.name} (${describe(baseline.pid)}); ` +
      `tested hosts: ${hosts.map(({ name, pid }) => `${name} pid ${pid}`).join(", ")}; nothing was measured. ` +
      "Bring another application to the front and run the checks again.");
  }
  return baseline;
}

/** Activates the application of process pid. It fails when the application cannot be activated. */
export function activateApp(pid) {
  assert.equal(activate({ pid }), true, `application ${pid} could not be activated`);
}

/**
 * After a check, restores the validated session baseline when the checked host is frontmost and waits until that host is
 * inactive. It leaves an unrelated frontmost application undisturbed, but rejects the check result unless the validated
 * session baseline is frontmost after cleanup. The return value is the active application before and after the restore.
 */
export async function restoreFrontmost({ name, baseline, host, hosts, read = frontmostApp, activate = activateApp, inactive }) {
  const before = read();
  if (before === host) {
    activate(baseline);
    await inactive();
  }
  const after = read();
  if (hosts.includes(after)) {
    throw new Error(`${name}: tested host ${after} is frontmost after the check instead of the baseline ${baseline} ` +
      `(frontmost before restoring: ${before})`);
  }
  if (after !== baseline) {
    throw new Error(`${name}: frontmost baseline changed from pid ${baseline} to pid ${after}; check result not accepted ` +
      `(frontmost before restoring: ${before})`);
  }
  return { before, after };
}

const windowsAbove = jxa(`
ObjC.import("CoreGraphics");
const list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1 | 16, 0))).filter((item) => item.kCGWindowLayer === 0);
const own = list.findIndex((item) => item.kCGWindowOwnerPID === input.pid);
if (own < 0) return JSON.stringify(null);
return JSON.stringify(list.slice(0, own).map((item) => ({ owner: item.kCGWindowOwnerName, pid: item.kCGWindowOwnerPID,
  frame: { x: item.kCGWindowBounds.X, y: item.kCGWindowBounds.Y, width: item.kCGWindowBounds.Width, height: item.kCGWindowBounds.Height } })));`);

/**
 * A window of the ordinary layer that is in front of the front window of process pid and covers the whole frame (screen
 * coordinates). It is stated as the reason when the window is covered and the check does not measure. It fails when the
 * window of pid is not in the window list.
 */
export function coveringWindows(pid, frame) {
  const above = windowsAbove({ pid });
  assert.ok(above !== null, `process ${pid} has no window in the window list`);
  return above.filter(({ frame: f }) => f.x <= frame.x && f.y <= frame.y &&
    f.x + f.width >= frame.x + frame.width && f.y + f.height >= frame.y + frame.height);
}

/**
 * Waits for an event that only a window the screen shows produces. When the wait fails, covered() names the windows that
 * cover the window, or returns null when none does; a covered window is stated as the reason, and the error of the wait is
 * the cause. Any other failure of the wait is returned unchanged.
 */
export async function unlessCovered(wait, covered) {
  try {
    return await wait();
  } catch (error) {
    const reason = await covered();
    if (reason === null) throw error;
    throw new Error(`the window is completely covered by ${reason}, so the screen does not show it and its occlusion state stays not visible. ` +
      "Nothing was measured: uncover the window, without activating the application, and run the check again.", { cause: error });
  }
}
