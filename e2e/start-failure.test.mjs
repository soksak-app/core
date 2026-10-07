// page 시작을 멈추는 오류는 빈 창이 아니라 오류 표시와 애플리케이션 로그로 보인다(docs/features.md F86).
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { readErrors } from "@soksak/window-check/application-log.mjs";
import { fresh } from "./fixture.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: a rejected installed plugin manifest stops the page start with a shown and logged error`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    assert.ok(s, `${app.binary} is not built`);
    await fresh(s);
    // 설치된 terminal plugin 의 manifest 를 sidecar 를 dependencies 대신 sidecars 로 적는 이전 형식으로 바꾼다.
    const installed = JSON.parse(readFileSync(join(s.app.configDir, "plugins", "installed.json"), "utf8"));
    const record = installed.plugins.terminal;
    const file = join(s.app.configDir, record.path, "plugin.json");
    const original = readFileSync(file, "utf8");
    const manifest = JSON.parse(original);
    const { dependencies, ...rest } = manifest;
    // 이전 manifest 를 되돌리고 page 를 다시 읽어 다음 검사가 시작한 page 에서 시작하게 한다.
    s.cleanup(async () => {
      writeFileSync(file, original);
      await s.run("host.window.reload");
    });
    writeFileSync(file, JSON.stringify({ ...rest, sidecars: Object.keys(dependencies) }, null, 2));

    const pattern = /^error: page: installed plugin terminal \S+ \(@soksak\/plugin-terminal\): plugin\.json: unknown field sidecars/;
    s.expectError(pattern);
    // 시작이 멈춘 page 는 준비를 알리지 않으므로 다시 읽기 명령은 기한을 넘긴다. page 는 시작 중에 오류를 기록하므로
    // 그 기한이 지난 뒤에는 기록이 로그에 있다.
    await assert.rejects(s.run("host.window.reload"), /did not|not ready|within/);
    const { errors } = readErrors(s.app.configDir, s.logStart);
    const line = errors.find((item) => pattern.test(item));
    assert.ok(line, `the start failure wrote no error line: ${JSON.stringify(errors)}`);
    t.diagnostic(`logged: ${line}`);

  });
}
