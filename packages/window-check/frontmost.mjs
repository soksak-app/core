// Reads the active application for diagnostic messages, activates a tested host on request and finds the windows that
// cover a window. Frontmost state is not a criterion of a check result.
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

const activate = jxa(`
const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(input.pid);
return JSON.stringify(!app.isNil() && app.activateWithOptions(0));`);

/** The process number of the application that is active now. */
export function frontmostApp() {
  return frontmost()?.pid ?? null;
}

/** Activates the application of process pid. It fails when the application cannot be activated. */
export function activateApp(pid) {
  assert.equal(activate({ pid }), true, `application ${pid} could not be activated`);
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
