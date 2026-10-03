// 호스트가 애플리케이션 로그를 설정 디렉터리의 파일에 남기는지 검사한다(docs/spec/hosts.md#application-log).
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { APPS, fresh, open } from "./app.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: the application log file holds the lines the page reports`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    s.cleanup(() => s.run("core.projects.browse"));
    // 초점이 옮겨지면 페이지가 그 전이를 report 로 호스트 로그에 적는다.
    await s.run("core.projects.browse");
    await s.until("core.library", (library) => library.shown.length > 0, "the library did not open");
    const transcript = await s.transcript();
    s.cleanup(() => transcript.stop());
    const line = "focus in core.library.search";
    await s.run("core.focus.set", { name: "core.library.search" });
    // 호스트는 줄을 표준 오류에 쓴 뒤 그 줄을 기록 연결에 보낸다. 그래서 알림이 오면 줄은 이미 파일에 있다.
    await transcript.until((lines) => lines.includes(line), `the page did not report "${line}"`);
    const file = join(s.app.configDir, "logs", "application.log");
    assert.ok(existsSync(file), `${file} does not exist`);
    const log = readFileSync(file, "utf8").split("\n");
    assert.ok(log.some((entry) => /^\S+ application log: \S+ pid \d+$/.test(entry)),
      `${file} has no run start line: ${JSON.stringify(log.slice(0, 5))}`);
    assert.ok(log.includes(line), `${file} does not hold "${line}": ${JSON.stringify(log.slice(-5))}`);
  });
}
