// 다시 읽기 전에 바꾼 배치가 다시 읽은 페이지에 남는지 검사한다(docs/spec/projects.md#persistence).
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, fresh, open } from "./app.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: a reload keeps a tab that was closed just before it closed`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    assert.ok(s, `${app.binary} is not built`);
    await fresh(s);
    const tabs = (await s.get("core.grid")).cards.flatMap((card) => card.tabs ?? []);
    assert.ok(tabs.length > 1, `the fixture space has fewer than two tabs: ${JSON.stringify(tabs)}`);
    const closed = tabs.at(-1);
    await s.run("core.tab.close", { tab: closed.id });
    const before = (await s.get("core.window.document")).timeOrigin;
    await s.run("host.window.reload");
    await s.until("core.window.document", (doc) => doc.timeOrigin !== before && doc.readyState === "complete",
      "the main document did not reload");
    const after = (await s.get("core.grid")).cards.flatMap((card) => card.tabs ?? []).map((tab) => tab.id);
    assert.ok(!after.includes(closed.id), `the closed tab ${closed.id} returned after the reload: ${JSON.stringify(after)}`);
  });
}
