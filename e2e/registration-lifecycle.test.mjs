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
