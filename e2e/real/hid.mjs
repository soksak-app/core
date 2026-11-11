// The input tool of the check under e2e/real/ that keeps real input: the cursor check of the card chrome reads the system cursor,
// which follows the pointer of the window server, so it posts HID events with CGEventPost and brings the window of the application
// to the front. Every other window check drives the application with the input that its host emulates inside the application. The
// terminal that runs the check needs the Accessibility permission. Run it only with `make test-app-real` in a run that the user
// approved.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";


// Runs a script as osascript JavaScript and returns the JSON result.
function jxa(body) {
  const script = `ObjC.import("CoreGraphics"); ObjC.import("AppKit"); ObjC.import("ApplicationServices");
function run(argv) { const input = JSON.parse(argv[0]); ${body} }`;
  return (input = {}) => {
    const output = execFileSync("osascript", ["-l", "JavaScript", "-e", script, JSON.stringify(input)], { encoding: "utf8" });
    return output.trim() === "" ? null : JSON.parse(output);
  };
}

/** Whether the process that runs this script has the Accessibility permission; it reads the permission and asks for nothing. */
export const trusted = jxa(`return JSON.stringify($.AXIsProcessTrusted());`);

/** The process that runs the checks must be able to send HID events. Otherwise the events are discarded silently. */
export function requireTrusted() {
  assert.equal(trusted(), true, "the terminal that runs real-input checks has no Accessibility permission; " +
    "posted HID events would be dropped");
}


const TYPES = { move: 5, down: 1, up: 2, drag: 6, rightDown: 3, rightUp: 4 };
const FLAGS = { shift: 0x20000, control: 0x40000, option: 0x80000, command: 0x100000 };

const postSteps = jxa(`
ObjC.import("Foundation");
$.NSApplication.sharedApplication;
const types = ${JSON.stringify(TYPES)};
const times = [];
for (const step of input.steps) {
  let event;
  const flags = (step.modifiers || []).reduce((sum, name) => sum + ${JSON.stringify(FLAGS)}[name], 0);
  if (step.type === "wheel") {
    event = $.CGEventCreateScrollWheelEvent2(null, step.unit === "pixel" ? 0 : 1, 1, step.lines, 0, 0);
    $.CGEventSetLocation(event, { x: step.x, y: step.y });
  } else if (step.type === "key") {
    event = $.CGEventCreateKeyboardEvent(null, step.code, step.down);
  } else {
    const button = step.type === "rightDown" || step.type === "rightUp" ? 1 : 0;
    event = $.CGEventCreateMouseEvent(null, types[step.type], { x: step.x, y: step.y }, button);
    // 창 서버는 게시된 이벤트의 누름 횟수를 세지 않는다. 두 번 누름은 kCGMouseEventClickState(1)에 2 를 싣는다.
    if (step.clicks) $.CGEventSetIntegerValueField(event, 1, step.clicks);
  }
  // 원본이 없는 이벤트는 HID 시스템 수정키 플래그를 물려받으므로 플래그를 명시한다.
  $.CGEventSetFlags(event, flags);
  $.CGEventPost(0, event);
  // 녹화 프레임의 표시 시각과 같은 시계(mach 시각, 잠자기 제외)로 보낸 시각을 기록한다.
  times.push($.NSProcessInfo.processInfo.systemUptime * 1000);
  if (step.wait) delay(step.wait / 1000);
}
return JSON.stringify(times);`);

/**
 * Sends HID events in order. step is {type, x, y, modifiers, wait, clicks}. clicks is the number of presses. type is move, down, up, drag,
 * rightDown, rightUp, wheel({lines, unit}) or key({code, down}). Coordinates are screen coordinates (origin at the top left, points).
 * Returns an array of the times (ms, on the same clock as the display time of the recording frames) at which each event was sent.
 */
export function post(steps) {
  return postSteps({ steps: steps.map((step) => ({ wait: 16, ...step })) });
}

const windowAt = jxa(`
const list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1 | 16, 0)));
for (const item of list) {
  if (item.kCGWindowLayer !== 0) continue;
  const b = item.kCGWindowBounds;
  if (input.x >= b.X && input.x < b.X + b.Width && input.y >= b.Y && input.y < b.Y + b.Height) {
    return JSON.stringify({ pid: item.kCGWindowOwnerPID, owner: item.kCGWindowOwnerName });
  }
}
return JSON.stringify(null);`);

/** The process that owns the frontmost ordinary window at the screen point (x, y). */
export function frontWindowAt(x, y) {
  return windowAt({ x, y });
}

/** The application process that endpoint.json of the configuration directory names. */
export function appPid(app) {
  return JSON.parse(readFileSync(join(app.configDir, "endpoint.json"), "utf8")).pid;
}

/** Converts the center of a rect in the window (the result of s.rect) to screen coordinates. */
export async function screenCenter(s, rect) {
  const { frame, content } = await s.get("host.window");
  return {
    x: frame.x + content.x + rect.document.x + rect.x + rect.width / 2,
    y: frame.y + content.y + rect.document.y + rect.y + rect.height / 2,
  };
}

/**
 * Activates the window, confirms that the frontmost window at the center of rect belongs to this application, and returns its screen coordinates. If another window is
 * in front, the events that were sent go to that window, so the check fails.
 */
export async function bringFront(s, app, rect) {
  await s.pointer(rect.document.x + rect.x + rect.width / 2, rect.document.y + rect.y + rect.height / 2,
    "move", { activate: true });
  await s.until("host.window", (window) => window.active === true && window.key === true,
    "the window did not become the key window of the active application");
  const point = await screenCenter(s, rect);
  const front = frontWindowAt(point.x, point.y);
  assert.equal(front?.pid, appPid(app), `the frontmost window at ${point.x},${point.y} belongs to ` +
    `${front?.owner} (${front?.pid}), not ${app.name}`);
  return point;
}

// Compares the system cursor with the AppKit standard cursors by image. A standard cursor can be created only when an NSApplication exists.
const readCursor = jxa(`
$.NSApplication.sharedApplication;
const current = $.NSCursor.currentSystemCursor;
if (current.isNil()) return JSON.stringify(null);
const image = (cursor) => cursor.image.TIFFRepresentation;
const names = { arrow: $.NSCursor.arrowCursor, openHand: $.NSCursor.openHandCursor, closedHand: $.NSCursor.closedHandCursor,
  pointingHand: $.NSCursor.pointingHandCursor, iBeam: $.NSCursor.IBeamCursor,
  resizeLeftRight: $.NSCursor.resizeLeftRightCursor, resizeUpDown: $.NSCursor.resizeUpDownCursor,
  columnResize: $.NSCursor.columnResizeCursor, rowResize: $.NSCursor.rowResizeCursor };
for (const name of Object.keys(names)) {
  if (image(current).isEqualToData(image(names[name]))) return JSON.stringify(name);
}
return JSON.stringify("other");`);

/** The name of the system cursor on the screen now: arrow, openHand, closedHand, pointingHand, iBeam, resizeLeftRight, resizeUpDown,
 * columnResize, rowResize, other, or null. */
export function systemCursor() {
  return readCursor();
}
