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
  }
  // 원본이 없는 이벤트는 실제 수정키 상태를 물려받으므로 플래그를 명시한다.
  $.CGEventSetFlags(event, flags);
  $.CGEventPost(0, event);
  // 녹화 프레임의 표시 시각과 같은 시계(mach 시각, 잠자기 제외)로 보낸 시각을 기록한다.
  times.push($.NSProcessInfo.processInfo.systemUptime * 1000);
  if (step.wait) delay(step.wait / 1000);
}
return JSON.stringify(times);`);

/**
 * HID 이벤트를 차례로 보낸다. step 은 {type, x, y, modifiers, wait} 이다. type 은 move, down, up, drag,
 * rightDown, rightUp, wheel({lines, unit}), key({code, down}) 이다. 좌표는 화면 좌표(왼쪽 위 원점, 포인트)다.
 * 각 이벤트를 보낸 시각(ms, 녹화 프레임의 표시 시각과 같은 시계)의 배열을 돌려준다.
 */
export function post(steps) {
  return postSteps({ steps: steps.map((step) => ({ wait: 16, ...step })) });
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

/** 화면 점 (x, y) 에서 맨 앞에 있는 일반 창의 소유 프로세스. */
export function frontWindowAt(x, y) {
  return windowAt({ x, y });
}

const readItems = jxa(`
const board = $.NSPasteboard.generalPasteboard;
const items = [];
const list = board.pasteboardItems;
for (let i = 0; i < list.count; i++) {
  const item = list.objectAtIndex(i);
  const entry = {};
  const types = item.types;
  for (let k = 0; k < types.count; k++) {
    const type = types.objectAtIndex(k).js;
    const data = item.dataForType(type);
    if (!data.isNil()) entry[type] = data.base64EncodedStringWithOptions(0).js;
  }
  items.push(entry);
}
return JSON.stringify({ changeCount: board.changeCount, items });`);

const writeItems = jxa(`
const board = $.NSPasteboard.generalPasteboard;
board.clearContents;
const objects = $.NSMutableArray.array;
for (const entry of input.items) {
  const item = $.NSPasteboardItem.alloc.init;
  for (const [type, value] of Object.entries(entry)) {
    item.setDataForType($.NSData.alloc.initWithBase64EncodedStringOptions(value, 0), type);
  }
  objects.addObject(item);
}
if (input.items.length > 0 && !board.writeObjects(objects)) throw new Error("pasteboard write failed");
return JSON.stringify(board.changeCount);`);

/** 일반 페이스트보드의 모든 항목을 형식별 base64 로 읽는다. */
export function readPasteboard() {
  return readItems();
}

/** 일반 페이스트보드를 items 로 바꾼다. items 는 readPasteboard().items 의 모양이다. */
export function writePasteboard(items) {
  return writeItems({ items });
}

/** 일반 페이스트보드의 텍스트. 텍스트가 없으면 null 이다. */
export function pasteboardText() {
  const { items } = readPasteboard();
  const text = items.find((item) => item["public.utf8-plain-text"] !== undefined)?.["public.utf8-plain-text"];
  return text === undefined ? null : Buffer.from(text, "base64").toString("utf8");
}

/** 검사가 끝나면 페이스트보드의 모든 항목을 되돌린다. */
export function keepPasteboard(s) {
  const saved = readPasteboard();
  s.cleanup(() => writePasteboard(saved.items));
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
