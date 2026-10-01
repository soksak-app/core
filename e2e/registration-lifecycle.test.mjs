// 문서 재읽기 중 등록 손실을 성능 기록과 함께 보고한다.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { APPS, fresh, open } from "./app.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: fixture reload retains core registrations and records their lifecycle`, { timeout: 90000 }, async (t) => {
    const s = await open(t, app);
    assert.ok(s, `${app.binary} is not built`);
    const file = join(app.configDir, "logs", "performance.ndjson");
    const read = () => existsSync(file) ? readFileSync(file, "utf8") : "";
    for (let run = 1; run <= 3; run++) {
      const before = read().length;
      const started = performance.now();
      t.diagnostic(`registration lifecycle run ${run} started`);
      try {
        const shell = await fresh(s, { performanceTrace: true });
        const document = await s.get("core.surface.document", shell.surface);
        assert.equal(document.readyState, "complete");
        const rows = read().slice(before).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
        assert.ok(rows.some((row) => row.event === "surface.registration" && row.phase === "registered" &&
          row.name === "core.surface.document"), "the trace omitted core document registration");
        t.diagnostic(`registration lifecycle run ${run} passed in ${Math.round(performance.now() - started)} ms`);
      } catch (error) {
        const rows = read().slice(before).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
          .filter((row) => row.event === "surface.registration");
        t.diagnostic(`registration lifecycle run ${run} failed in ${Math.round(performance.now() - started)} ms`);
        throw new Error(`${error.message}; registration timeline: ${JSON.stringify(rows)}`, { cause: error });
      }
    }
  });
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: a late main-page navigation callback keeps the replacement page's registrations and documents`, { timeout: 90000 }, async (t) => {
    const s = await open(t, app);
    assert.ok(s, `${app.binary} is not built`);
    await fresh(s);
    const log = await s.transcript();
    s.cleanup(() => log.stop());
    // 호스트가 다시 읽힌 메인 페이지의 navigation callback 을 새 페이지가 시작한 뒤에 처리하게 한다.
    await s.request("diagnostics.navigation.delay", { ms: 1500 });
    s.cleanup(() => s.request("diagnostics.navigation.delay", { ms: 0 }));
    const shell = await fresh(s);
    await log.until((lines) => lines.some((line) => line.startsWith("navigation callback handled")),
      "the delayed navigation callback did not finish");
    const window = (await s.get("host.windows")).find((entry) => entry.window === s.window);
    assert.equal(window.ready, true, "the late navigation callback marked the replacement page not ready");
    for (const surface of (await s.get("core.surfaces")).filter((entry) => entry.visible)) {
      assert.ok(surface.exposes.includes("status core.surface.document"),
        `the late navigation callback removed the core registration of ${surface.surface}: ${JSON.stringify(surface)}`);
      assert.equal(surface.status.error, null, `the late navigation callback broke ${surface.surface}: ${JSON.stringify(surface)}`);
    }
    await s.get("core.surface.document", shell.surface);
  });
}
