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
 * 창이 가진 웹 문서의 목록. 다시 읽기가 이전 페이지의 표면 문서, 문서 영역, 그림 영역을 남기면 목록이 커진다. 문서 id 는
 * 다시 읽을 때마다 새로 정해지므로 수만 비교한다.
 */
function inventory(window) {
  return {
    webviews: window.webviews.length,
    surfaces: window.surfaces.map((surface) => surface.id).sort(),
    documents: window.documents.length,
    regions: window.regions.length,
  };
}

const RELOADS = 20;

// 같은 WebContent process 에서 다시 읽은 이전 문서는 WebKit 이 querySelectorAll 결과 캐시에 두었다가 메모리 압박 때
// 놓는다(docs/operations/private-native-apis.md). 그 동작은 native/darwin 의 webview_process_test 가 재현하고, 이
// 검사는 앱이 가진 것만 판정한다. page footprint 는 판정하지 않고 기록한다.
for (const app of Object.values(APPS)) {
  test(`${app.name}: repeated reload keeps the host memory and the window documents bounded`, { timeout: 300000 }, async (t) => {
    const session = await open(t, app);
    if (!session) return;
    await fresh(session);
    const { pageProcess } = await session.get("host.window");
    assert.ok(Number.isInteger(pageProcess) && pageProcess > 0, `the app page has no WebContent process: ${pageProcess}`);
    await session.request("diagnostics.page.collect", {});
    const footprintBefore = footprint(pageProcess);
    const before = inventory(await session.get("host.window"));
    // 검사가 연결한 호스트의 process. 같은 이름의 다른 앱이나 번들 안의 사이드카는 재지 않는다.
    const host = session.client.endpoint.pid;
    const hostBefore = resident(host);
    for (let i = 0; i < RELOADS; i++) await session.run("host.window.reload");
    const expected = JSON.stringify(before);
    const settled = await session.until("host.window", (window) => JSON.stringify(inventory(window)) === expected,
      `the window documents differ from ${expected} after ${RELOADS} reloads`);
    const hostAfter = resident(host);
    assert.equal(settled.pageProcess, pageProcess, "a reload changed the page process");
    await session.request("diagnostics.page.collect", {});
    t.diagnostic(`documents ${expected}; page footprint ${footprintBefore} -> ${footprint(pageProcess)} B without memory ` +
      `pressure; host RSS ${hostBefore} -> ${hostAfter} KB`);
    assert.ok(hostAfter - hostBefore < 64 * 1024, `host RSS grew ${hostAfter - hostBefore} KB over ${RELOADS} reloads`);
  });
}
