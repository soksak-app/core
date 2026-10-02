import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { APPS, fresh, open } from "./app.mjs";

/** 프로세스의 RSS(KB). */
function resident(pid) {
  const text = execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim();
  assert.match(text, /^\d+$/, `RSS of ${pid} was not measurable`);
  return Number(text);
}

/** 프로세스의 physical footprint(바이트). 상주 메모리는 해제한 page 를 할당기가 붙들고 있으면 줄지 않는다. */
function footprint(pid) {
  const match = execFileSync("footprint", ["-p", String(pid), "-f", "bytes"], { encoding: "utf8" }).match(/Footprint: (\d+) B/);
  assert.ok(match, `footprint of ${pid} was not measurable`);
  return Number(match[1]);
}

/**
 * WebKit 의 메모리 압박 해제를 요청하고 page process 의 footprint 가 bound 아래로 내려온 값을 돌려준다. WebKit 은
 * 같은 process 에서 다시 읽은 이전 문서를 querySelectorAll 결과 캐시에 두었다가 이 해제 때 놓는다
 * (docs/operations/private-native-apis.md). 해제 알림은 이 컴퓨터의 모든 WebKit process 가 받고, 해제가 끝났음을
 * 알리는 이벤트가 없으므로 수집 요청과 측정을 상한 횟수까지 되풀이한다.
 */
async function released(session, pid, bound) {
  execFileSync("notifyutil", ["-p", "org.WebKit.lowMemory"]);
  const samples = [];
  for (let attempt = 0; attempt < 20; attempt++) {
    await session.request("diagnostics.page.collect", {});
    samples.push(footprint(pid));
    if (samples.at(-1) <= bound) return samples;
  }
  return samples;
}

const RELOADS = 20;

for (const app of Object.values(APPS)) {
  test(`${app.name}: repeated reload keeps the host and the released page memory bounded`, { timeout: 300000 }, async (t) => {
    const session = await open(t, app);
    if (!session) return;
    await fresh(session);
    const { pageProcess } = await session.get("host.window");
    assert.ok(Number.isInteger(pageProcess) && pageProcess > 0, `the app page has no WebContent process: ${pageProcess}`);
    const first = await released(session, pageProcess, Infinity);
    // 검사가 연결한 호스트의 process. 같은 이름의 다른 앱이나 번들 안의 사이드카는 재지 않는다.
    const host = session.client.endpoint.pid;
    const hostBefore = resident(host);
    for (let i = 0; i < RELOADS; i++) await session.run("host.window.reload");
    const hostAfter = resident(host);
    assert.equal((await session.get("host.window")).pageProcess, pageProcess, "a reload changed the page process");
    const bound = first[0] + 32 * 1024 * 1024;
    const after = await released(session, pageProcess, bound);
    t.diagnostic(`page footprint ${first[0]} B, after ${RELOADS} reloads and release ${after.join(",")} B; host RSS ${hostBefore} -> ${hostAfter} KB`);
    assert.ok(hostAfter - hostBefore < 64 * 1024, `host RSS grew ${hostAfter - hostBefore} KB over ${RELOADS} reloads`);
    assert.ok(after.at(-1) <= bound,
      `the released page footprint grew ${after.at(-1) - first[0]} B over ${RELOADS} reloads: ${after.join(",")}`);
  });
}
