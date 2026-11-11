// Reads the active application for diagnostic messages and finds the windows that cover a window. Frontmost state is not a criterion of a check result.
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

/** The process number of the application that is active now. */
export function frontmostApp() {
  return frontmost()?.pid ?? null;
}

// The windows of the ordinary layer on the screen, front to back.
const windowList = jxa(`
ObjC.import("CoreGraphics");
const list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1 | 16, 0))).filter((item) => item.kCGWindowLayer === 0);
return JSON.stringify(list.map((item) => ({ owner: item.kCGWindowOwnerName, pid: item.kCGWindowOwnerPID,
  frame: { x: item.kCGWindowBounds.X, y: item.kCGWindowBounds.Y, width: item.kCGWindowBounds.Width, height: item.kCGWindowBounds.Height } })));`);

/**
 * The place of the front window of process pid in a window list ordered front to back: the number of windows in front of
 * it. It fails when the process has no window in the list.
 */
export function placeIn(list, pid) {
  const place = list.findIndex((item) => item.pid === pid);
  assert.ok(place >= 0, `process ${pid} has no window in the window list`);
  return place;
}

/**
 * The number of windows of other processes behind the front window of process pid in a window list ordered front to back,
 * without the windows of the processes in except. It fails when the process has no window in the list.
 */
export function behindIn(list, pid, except = []) {
  const place = placeIn(list, pid);
  return list.slice(place + 1).filter((item) => item.pid !== pid && !except.includes(item.pid)).length;
}

/** The number of windows of other processes behind the front window of process pid on the screen, without those of except. */
export function windowsBehind(pid, except = []) {
  return behindIn(windowList(), pid, except);
}

/** The place of the front window of process pid among the windows of the ordinary layer on the screen. */
export function windowPlace(pid) {
  return placeIn(windowList(), pid);
}
