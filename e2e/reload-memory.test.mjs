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

// main page 를 다시 읽으면 host 는 새 문서를 새 WebContent process 에서 열고 이전 process 는 이전 문서와 함께 끝난다
// (docs/operations/private-native-apis.md). 같은 process 에서 다시 읽으면 WebKit 의 querySelectorAll 결과 캐시가 이전
// 문서를 메모리 압박 전까지 남긴다. 검사는 다시 읽을 때마다 page process 가 바뀌고 이전 process 가 끝나는지, 다시 읽은
// 뒤의 page footprint 와 host 메모리, 창의 문서를 판정한다.
const PAGE_GROWTH = 64 * 1024 * 1024;

for (const app of Object.values(APPS)) {
  test(`${app.name}: repeated reload keeps the host memory, the page memory and the window documents bounded`, { timeout: 300000 }, async (t) => {
    const session = await open(t, app);
    if (!session) return;
    await fresh(session);
    const { pageProcess: first } = await session.get("host.window");
    assert.ok(Number.isInteger(first) && first > 0, `the app page has no WebContent process: ${first}`);
    await session.request("diagnostics.page.collect", {});
    const footprintBefore = footprint(first);
    const before = inventory(await session.get("host.window"));
    // 검사가 연결한 호스트의 process. 같은 이름의 다른 앱이나 번들 안의 사이드카는 재지 않는다.
    const host = session.client.endpoint.pid;
    const hostBefore = resident(host);
    const processes = [first];
    for (let i = 0; i < RELOADS; i++) {
      const previous = processes.at(-1);
      await session.run("host.window.reload");
      const { pageProcess } = await session.until("host.window", (window) => window.pageProcess !== previous,
        `reload ${i + 1} kept the page process ${previous}`);
      processes.push(pageProcess);
      await session.request("diagnostics.process.exit", { pid: previous }).catch((error) => {
        throw new Error(`reload ${i + 1} left the previous page process ${previous} running: ${error.message}`);
      });
    }
    const expected = JSON.stringify(before);
    await session.until("host.window", (window) => JSON.stringify(inventory(window)) === expected,
      `the window documents differ from ${expected} after ${RELOADS} reloads`);
    const hostAfter = resident(host);
    await session.request("diagnostics.page.collect", {});
    const footprintAfter = footprint(processes.at(-1));
    t.diagnostic(`documents ${expected}; page processes ${processes.join(" ")}; page footprint ${footprintBefore} -> ` +
      `${footprintAfter} B; host RSS ${hostBefore} -> ${hostAfter} KB`);
    assert.ok(footprintAfter - footprintBefore < PAGE_GROWTH,
      `the page footprint grew ${footprintAfter - footprintBefore} B over ${RELOADS} reloads`);
    assert.ok(hostAfter - hostBefore < 64 * 1024, `host RSS grew ${hostAfter - hostBefore} KB over ${RELOADS} reloads`);
  });
}
