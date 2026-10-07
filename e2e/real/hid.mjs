// 실제 입력 등급 창 검사의 입력 도구. 호스트 진단은 이벤트를 뷰에 직접 넣으므로 창 서버, NSApp 이벤트 분배,
// 키 창, 첫 응답자, 메뉴 키 대응을 거치지 않는다. 이 모듈은 CGEventPost 로 HID 이벤트를 보내 사용자와 같은
// 경로를 쓴다. 검사를 실행하는 터미널에 손쉬운 사용 권한이 있어야 하며, 사용자의 포인터와 키보드를 쓰므로
// 사용자가 승인한 실행에서만 pnpm -F @soksak/e2e verify:real 로 실행한다.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";


// osascript 의 JavaScript 로 스크립트를 실행하고 JSON 결과를 돌려준다.
function jxa(body) {
  const script = `ObjC.import("CoreGraphics"); ObjC.import("AppKit"); ObjC.import("ApplicationServices");
function run(argv) { const input = JSON.parse(argv[0]); ${body} }`;
  return (input = {}) => {
    const output = execFileSync("osascript", ["-l", "JavaScript", "-e", script, JSON.stringify(input)], { encoding: "utf8" });
    return output.trim() === "" ? null : JSON.parse(output);
  };
}

const trusted = jxa(`return JSON.stringify($.AXIsProcessTrusted());`);

/** 검사를 실행하는 프로세스가 HID 이벤트를 보낼 수 있어야 한다. 없으면 이벤트가 조용히 버려진다. */
export function requireTrusted() {
  assert.equal(trusted(), true, "the terminal that runs real-input checks has no Accessibility permission; " +
    "posted HID events would be dropped");
}

// 이벤트 종류와 마우스 버튼 값은 CGEventTypes.h 의 값이다.
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
 * HID 이벤트를 차례로 보낸다. step 은 {type, x, y, modifiers, wait, clicks} 이다. clicks 는 누름 횟수다. type 은 move, down, up, drag,
 * rightDown, rightUp, wheel({lines, unit}), key({code, down}) 이다. 좌표는 화면 좌표(왼쪽 위 원점, 포인트)다.
 * 각 이벤트를 보낸 시각(ms, 녹화 프레임의 표시 시각과 같은 시계)의 배열을 돌려준다.
 */
export function post(steps) {
  return postSteps({ steps: steps.map((step) => ({ wait: 16, ...step })) });
}

/** HID 이동 사이에도 시스템 커서를 읽어 한 프레임만 나타나는 모양을 센다. */
export function postWithCursorSamples(steps) {
  return postSteps({ steps: steps.map((step) => ({ wait: 16, ...step })), sampleCursor: true });
}

/** 누르고 떼는 클릭이다. */
export function click(x, y, modifiers = []) {
  post([{ type: "move", x, y, modifiers }, { type: "down", x, y, modifiers }, { type: "up", x, y, modifiers }]);
}

/** from 에서 눌러 steps 걸음으로 to 까지 끌고 뗀다. */
export function dragPath(from, to, steps = 20) {
  const events = [{ type: "move", ...from }, { type: "down", ...from }];
  for (let i = 1; i <= steps; i++) {
    events.push({ type: "drag", x: from.x + (to.x - from.x) * i / steps, y: from.y + (to.y - from.y) * i / steps });
  }
  events.push({ type: "up", ...to });
  post(events);
}

/** 가상 키 코드 code 를 modifiers 와 함께 누르고 뗀다. */
export function key(code, modifiers = []) {
  post([{ type: "key", code, down: true, modifiers }, { type: "key", code, down: false, modifiers }]);
}

/** 키 코드. Carbon Events.h 의 kVK 값이다. */
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

// 알림 센터가 보이는 배너 가운데 본문이 input.body 인 것의 화면 사각형. 배너는 알림 센터의 화면 전체 창 안에
// 그려지므로 창 목록이 아니라 손쉬운 사용 트리에서 찾는다. 배너는 다른 프로세스가 그리고, 검사하는
// 애플리케이션은 배너가 나타날 때 사건을 받지 않으므로 input.within 밀리초 동안 다시 읽는다.
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

/** 본문이 body 인 알림 배너를 within 밀리초 안에 찾아 {x, y, width, height, texts}(화면 좌표) 로 돌려준다. 없으면 null. */
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

/** 끌기 페이스트보드의 변경 횟수와 형식. 끌기 세션이 시작되면 바뀐다. */
export function dragPasteboard() {
  return dragBoard();
}

/** directory 를 목록 보기의 Finder 창으로 bounds {x, y, width, height}(화면 좌표) 에 열고 창 번호를 돌려준다. */
export function openFinderWindow(directory, bounds) {
  return finderOpen({ directory, bounds });
}

/** openFinderWindow 가 연 창만 닫는다. */
export function closeFinderWindow(id) {
  finderClose({ id });
}

/** 맨 앞 Finder 창에서 이름이 name 인 항목 이름의 화면 가운데. */
export function finderItemCenter(name) {
  const center = finderItem({ name });
  assert.ok(center, `the Finder window does not show ${name}`);
  return center;
}

/** 화면 점 (x, y) 에서 맨 앞에 있는 일반 창의 소유 프로세스. */
export function frontWindowAt(x, y) {
  return windowAt({ x, y });
}


/** 설정 디렉터리의 endpoint.json 이 적은 애플리케이션 프로세스. */
export function appPid(app) {
  return JSON.parse(readFileSync(join(app.configDir, "endpoint.json"), "utf8")).pid;
}

/** 창 안의 rect(s.rect 의 결과) 중심을 화면 좌표로 바꾼다. */
export async function screenCenter(s, rect) {
  const { frame, content } = await s.get("host.window");
  return {
    x: frame.x + content.x + rect.document.x + rect.x + rect.width / 2,
    y: frame.y + content.y + rect.document.y + rect.y + rect.height / 2,
  };
}

/**
 * 창을 활성화하고 rect 중심에서 맨 앞 창이 이 애플리케이션인지 확인한 뒤 그 화면 좌표를 돌려준다. 다른 창이
 * 앞에 있으면 보낸 이벤트는 그 창으로 가므로 검사는 실패한다.
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

// 시스템 커서를 AppKit 표준 커서와 그림으로 비교한다. 표준 커서는 NSApplication 이 있어야 만들어진다.
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

/** 지금 화면의 시스템 커서 이름: arrow, openHand, closedHand, pointingHand, iBeam, resizeLeftRight, resizeUpDown,
 * columnResize, rowResize, other, 또는 null. */
export function systemCursor() {
  return readCursor();
}

const activateFinderApp = jxa(`Application("Finder").activate(); return "";`);

/** Finder 를 활성 애플리케이션으로 만든다. 다시 활성화될 때의 창 상태를 검사하려고 쓴다. */
export function activateFinder() {
  activateFinderApp();
}
