// 표면이 닫힌 뒤 도착한 표면의 답을 호스트가 오류 없이 버리고 관측으로 남기는지 검사한다(docs/spec/exposure.md#relay).
//
// 진단 메서드 diagnostics.surface.hold 가 표면의 답을 호스트가 그 표면을 제거할 때까지 붙잡으므로, 답은 시간에 기대지
// 않고 요청이 끝난 뒤에 도착한다(docs/spec/endpoint.md).
import assert from "node:assert/strict";
import { statSync } from "node:fs";
import test from "node:test";

import { APPS, failure, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";
import { applicationLog, readLines, withoutTime } from "@soksak/window-check/application-log.mjs";
import { heldRepliesSent, lateReplyFindings } from "./late-reply.mjs";

/** 탭 id 가 있는 카드. */
const holder = (grid, tab) => grid?.cards.find((card) => card.tabs.some((entry) => entry.id === tab));

for (const app of Object.values(APPS)) {
  test(`${app.name}: a surface reply that arrives after its surface closed is discarded as an observation`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const { tab } = await s.run("core.card.add-tab", { card: "browser", plugin: "browser" });
    // 검사가 탭을 닫기 전에 실패하면 남은 탭을 닫는다. 닫힌 표면의 붙잡기도 그때 끝난다.
    s.cleanup(async () => {
      if (holder(await s.get("core.grid"), tab)) await s.run("core.tab.close", { tab });
    });
    await s.until("core.surfaces", (surfaces) => surfaces.some((item) =>
      item.surface === tab && item.visible && item.status.phase === "ready"),
    "the new browser tab did not become ready");
    const transcript = await s.transcript();
    s.cleanup(() => transcript.stop());
    const offset = statSync(applicationLog(s.app.configDir)).size;

    await s.request("diagnostics.surface.hold", { surface: tab });
    const pending = failure(s.run("core.surface.hit", { x: 0, y: 0 }, tab));
    await s.request("diagnostics.surface.held", { surface: tab });
    t.diagnostic(`the reply of ${tab} is held; closing the tab`);
    await s.run("core.tab.close", { tab });
    assert.equal(await pending, 1003, "the request to the closed surface did not end with 1003");
    // 페이지는 호스트가 붙잡은 답에 응답한 뒤 이 줄을 보낸다. 호스트의 관측 줄은 그 응답 전에 로그에 쓰였다.
    const sent = heldRepliesSent(tab, 1);
    await transcript.until((lines) => lines.includes(sent), `the page did not report "${sent}"`);

    const lines = readLines(s.app.configDir, offset).lines.map(withoutTime);
    const { observations, errors } = lateReplyFindings(lines, tab);
    assert.deepEqual(errors, [], `the late reply of ${tab} wrote error lines`);
    assert.equal(observations.length, 1,
      `the application log does not hold one late reply observation of ${tab}: ${JSON.stringify(lines)}`);
  });
}
