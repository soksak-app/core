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

const identify = jxa(`
const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(input.pid);
return JSON.stringify(app.isNil() ? null : { name: ObjC.unwrap(app.localizedName) ?? null, bundle: ObjC.unwrap(app.bundleIdentifier) ?? null });`);

const activate = jxa(`
const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(input.pid);
return JSON.stringify(!app.isNil() && app.activateWithOptions(0));`);

/** 지금 활성인 애플리케이션의 프로세스 번호. */
export function frontmostApp() {
  return frontmost();
}

/** 프로세스 pid 의 애플리케이션을 이름과 bundle identifier 로 적는다. */
export function describeApp(pid) {
  const app = identify({ pid });
  return app === null ? `pid ${pid}, no running application` : `pid ${pid}, ${app.name ?? "no name"}, ${app.bundle ?? "no bundle identifier"}`;
}

/**
 * 검사 전 활성 애플리케이션을 세션의 기준 baseline 으로 읽는다. 기준이 검사할 호스트(hosts, { name, pid }) 중
 * 하나이면 세션의 모든 합성 포인터 측정이 활성 애플리케이션을 재게 되므로, 첫 검사 전에 그 애플리케이션과 호스트를
 * 밝혀 실패한다.
 */
export function sessionBaseline({ hosts, read = frontmostApp, describe = describeApp }) {
  const baseline = read();
  const host = hosts.find(({ pid }) => pid === baseline);
  if (host !== undefined) {
    throw new Error(`the frontmost application before the checks is tested host ${host.name} (${describe(baseline)}); ` +
      `tested hosts: ${hosts.map(({ name, pid }) => `${name} pid ${pid}`).join(", ")}; nothing was measured. ` +
      "Bring another application to the front and run the checks again.");
  }
  return baseline;
}

/** 프로세스 pid 의 애플리케이션을 활성화한다. 활성화할 수 없으면 실패한다. */
export function activateApp(pid) {
  assert.equal(activate({ pid }), true, `application ${pid} could not be activated`);
}

/**
 * 검사가 끝난 뒤 활성 애플리케이션을 세션의 기준 baseline 으로 되돌리고 확인한다. 검사한 호스트 host 가 활성이면
 * 기준을 다시 활성화하고 호스트가 비활성이 되기를 기다린다. 그 뒤 세션이 연 호스트(hosts) 중 하나가 활성이면
 * 실패한다. 검사는 다른 애플리케이션을 활성화하지 않으므로, 다른 애플리케이션이 활성이면 사용자가 바꾼 것이며
 * 그 애플리케이션을 빼앗지 않는다. 반환값은 복원 전후의 활성 애플리케이션이다.
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
 * 프로세스 pid 의 맨 앞 창보다 앞에 있으면서 frame(화면 좌표)을 모두 덮는 일반 층 창. 창이 가려져 검사가 재지
 * 않을 때 그 까닭으로 적는다. pid 의 창이 창 목록에 없으면 실패한다.
 */
export function coveringWindows(pid, frame) {
  const above = windowsAbove({ pid });
  assert.ok(above !== null, `process ${pid} has no window in the window list`);
  return above.filter(({ frame: f }) => f.x <= frame.x && f.y <= frame.y &&
    f.x + f.width >= frame.x + frame.width && f.y + f.height >= frame.y + frame.height);
}
