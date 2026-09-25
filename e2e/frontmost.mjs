// 활성 애플리케이션을 읽고 되돌린다. 기본 창 검사는 비활성 애플리케이션을 전제하므로, 애플리케이션을 활성화하는
// 검사는 끝날 때 앞서 활성이던 애플리케이션을 다시 활성화한다.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// osascript 의 JavaScript 로 스크립트를 실행하고 JSON 결과를 돌려준다.
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
return JSON.stringify(app.isNil() ? null : app.processIdentifier);`);

const activate = jxa(`
const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(input.pid);
return JSON.stringify(!app.isNil() && app.activateWithOptions(0));`);

/** 지금 활성인 애플리케이션의 프로세스 번호. */
export function frontmostApp() {
  return frontmost();
}

/** 프로세스 pid 의 애플리케이션을 활성화한다. 활성화할 수 없으면 실패한다. */
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
 * 프로세스 pid 의 맨 앞 창보다 앞에 있으면서 frame(화면 좌표)을 모두 덮는 일반 층 창. 창이 가려져 검사가 재지
 * 않을 때 그 까닭으로 적는다. pid 의 창이 창 목록에 없으면 실패한다.
 */
export function coveringWindows(pid, frame) {
  const above = windowsAbove({ pid });
  assert.ok(above !== null, `process ${pid} has no window in the window list`);
  return above.filter(({ frame: f }) => f.x <= frame.x && f.y <= frame.y &&
    f.x + f.width >= frame.x + frame.width && f.y + f.height >= frame.y + frame.height);
}
