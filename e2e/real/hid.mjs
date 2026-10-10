// The input tool of the real-input-tier window checks. The host diagnostics put events directly into a view, so they do not pass through the window server, the NSApp event dispatch,
// the key window, the first responder or the menu key equivalents. This module sends HID events with CGEventPost and so uses the same
// path as the user. The terminal that runs the checks needs the Accessibility permission. The module uses the pointer and the keyboard of the user, so
// run it only in a run that the user approved, with pnpm -F @soksak/e2e verify:real.
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

const trusted = jxa(`return JSON.stringify($.AXIsProcessTrusted());`);

/** The process that runs the checks must be able to send HID events. Otherwise the events are discarded silently. */
export function requireTrusted() {
  assert.equal(trusted(), true, "the terminal that runs real-input checks has no Accessibility permission; " +
    "posted HID events would be dropped");
}

// The event types and the mouse button values are the values of CGEventTypes.h.
const TYPES = { move: 5, down: 1, up: 2, drag: 6, rightDown: 3, rightUp: 4 };
const FLAGS = { shift: 0x20000, control: 0x40000, option: 0x80000, command: 0x100000 };

const postSteps = jxa(`
ObjC.import("Foundation");
$.NSApplication.sharedApplication;
const types = ${JSON.stringify(TYPES)};
const times = [];
const cursors = { arrow: 0, iBeam: 0, other: 0, missing: 0, runs: [] };
// 표본의 종류가 바뀔 때마다 [종류, 연속 개수] 를 남긴다. 다른 커서가 끼어든 때를 순서로 보인다.
const count = (kind) => {
  cursors[kind]++;
  const last = cursors.runs[cursors.runs.length - 1];
  if (last && last[0] === kind) last[1]++;
  else cursors.runs.push([kind, 1]);
};
const cursorImage = (cursor) => cursor.image.TIFFRepresentation;
const arrowImage = input.sampleCursor ? cursorImage($.NSCursor.arrowCursor) : null;
const textImage = input.sampleCursor ? cursorImage($.NSCursor.IBeamCursor) : null;
const sampleCursor = () => {
  const current = $.NSCursor.currentSystemCursor;
  if (current.isNil()) { count("missing"); return; }
  const image = cursorImage(current);
  if (image.isEqualToData(arrowImage)) count("arrow");
  else if (image.isEqualToData(textImage)) count("iBeam");
  else count("other");
};
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
  if (input.sampleCursor) {
    for (let sample = 0; sample < 4; sample++) {
      delay((step.wait || 0) / 4000);
      sampleCursor();
    }
  } else if (step.wait) delay(step.wait / 1000);
}
return JSON.stringify(input.sampleCursor ? cursors : times);`);

/**
 * Sends HID events in order. step is {type, x, y, modifiers, wait, clicks}. clicks is the number of presses. type is move, down, up, drag,
 * rightDown, rightUp, wheel({lines, unit}) or key({code, down}). Coordinates are screen coordinates (origin at the top left, points).
 * Returns an array of the times (ms, on the same clock as the display time of the recording frames) at which each event was sent.
 */
export function post(steps) {
  return postSteps({ steps: steps.map((step) => ({ wait: 16, ...step })) });
}

/** Reads the system cursor also between HID moves and counts the shapes that appear for only one frame. */
export function postWithCursorSamples(steps) {
  return postSteps({ steps: steps.map((step) => ({ wait: 16, ...step })), sampleCursor: true });
}

/** A click that presses and releases. */
export function click(x, y, modifiers = []) {
  post([{ type: "move", x, y, modifiers }, { type: "down", x, y, modifiers }, { type: "up", x, y, modifiers }]);
}

/** Presses at from, drags to to in steps steps, and releases. */
export function dragPath(from, to, steps = 20) {
  const events = [{ type: "move", ...from }, { type: "down", ...from }];
  for (let i = 1; i <= steps; i++) {
    events.push({ type: "drag", x: from.x + (to.x - from.x) * i / steps, y: from.y + (to.y - from.y) * i / steps });
  }
  events.push({ type: "up", ...to });
  post(events);
}

/** Presses and releases the virtual key code code with modifiers. */
export function key(code, modifiers = []) {
  post([{ type: "key", code, down: true, modifiers }, { type: "key", code, down: false, modifiers }]);
}

/** Key codes. They are the kVK values of Carbon Events.h. */
export const KEYS = { c: 8, v: 9, a: 0, escape: 53, return: 36 };

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

// The screen rectangle of the visible banner of the notification center whose body is input.body. The banner is drawn
// inside the full-screen window of the notification center, so the function finds it in the Accessibility tree and not in the window list. Another process draws the banner, and the application
// under check receives no event when the banner appears, so the function reads again for input.within milliseconds.
const bannerWith = jxa(`
const center = Application("System Events").processes.whose({ bundleIdentifier: "com.apple.notificationcenterui" });
const find = () => {
  if (center.length === 0) return null;
  for (const window of center[0].windows()) {
    for (const group of window.entireContents()) {
      let role = "";
      try { role = group.role(); } catch (error) { continue; }
      if (role !== "AXGroup") continue;
      let texts = [];
      try { texts = group.staticTexts().map((text) => text.name()); } catch (error) { continue; }
      if (texts.includes(input.body)) {
        const [x, y] = group.position();
        const [width, height] = group.size();
        return { x, y, width, height, texts };
      }
    }
  }
  return null;
};
const until = Date.now() + input.within;
let banner = find();
while (!banner && Date.now() < until) {
  delay(0.05);
  banner = find();
}
return JSON.stringify(banner);`);

/** Finds the notification banner whose body is body within within milliseconds and returns {x, y, width, height, texts} (screen coordinates). It returns null when there is none. */
export function waitNotificationBanner(body, within) {
  return bannerWith({ body, within });
}

const finderOpen = jxa(`
const finder = Application("Finder");
finder.open(Path(input.directory));
const window = finder.finderWindows[0];
window.currentView = "list view";
window.bounds = input.bounds;
finder.activate();
window.index = 1;
return JSON.stringify(window.id());`);

const finderClose = jxa(`
const finder = Application("Finder");
const windows = finder.finderWindows.whose({ id: input.id });
if (windows.length > 0) windows[0].close();
return JSON.stringify(true);`);

const finderItem = jxa(`
const window = Application("System Events").processes.byName("Finder").windows[0];
function find(element, depth) {
  if (depth > 8) return null;
  let children = [];
  try { children = element.uiElements(); } catch (error) { return null; }
  for (const child of children) {
    try {
      // 목록 보기의 항목 이름은 값이 이름인 텍스트 칸이다.
      const role = child.role();
      if ((role === "AXTextField" || role === "AXStaticText") && (child.value() === input.name || child.name() === input.name)) {
        const [x, y] = child.position();
        const [width, height] = child.size();
        return { x: x + width / 2, y: y + height / 2 };
      }
    } catch (error) {}
    const found = find(child, depth + 1);
    if (found) return found;
  }
  return null;
}
return JSON.stringify(find(window, 0));`);

const dragBoard = jxa(`
const board = $.NSPasteboard.pasteboardWithName($.NSPasteboardNameDrag);
const types = board.types;
const names = [];
for (let i = 0; i < types.count; i++) names.push(types.objectAtIndex(i).js);
return JSON.stringify({ changeCount: board.changeCount, types: names });`);

/** The change count and the formats of the drag pasteboard. They change when a drag session starts. */
export function dragPasteboard() {
  return dragBoard();
}

/** Opens directory in a Finder window in list view at bounds {x, y, width, height} (screen coordinates) and returns the window number. */
export function openFinderWindow(directory, bounds) {
  return finderOpen({ directory, bounds });
}

/** Closes only the window that openFinderWindow opened. */
export function closeFinderWindow(id) {
  finderClose({ id });
}

/** The screen center of the item name whose name is name in the frontmost Finder window. */
export function finderItemCenter(name) {
  const center = finderItem({ name });
  assert.ok(center, `the Finder window does not show ${name}`);
  return center;
}

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

const activateFinderApp = jxa(`Application("Finder").activate(); return "";`);

/** Makes Finder the active application. It is used to check the window state when the application is activated again. */
export function activateFinder() {
  activateFinderApp();
}
