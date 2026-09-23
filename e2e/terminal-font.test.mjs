// 터미널 글꼴: font.family 우선순위 목록에서 설치된 첫 family 를 쓰고, 없는 family 는 오류가 아님을 검사한다.
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, fresh, open } from "./app.mjs";
import { ensureTerminals } from "./terminal-screen.mjs";

const SETTING = "terminal.font.family";
const DEFAULT = "D2Coding;Menlo";

for (const app of Object.values(APPS)) {
  test(`${app.name}: the terminal applies the first installed family of font.family`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    s.cleanup(() => s.run("core.settings.change", { key: SETTING, value: DEFAULT, scope: "common" }));
    const [terminal] = await ensureTerminals(s, 1);
    const surface = terminal.surface;
    const initial = await s.until("terminal.session", (session) => typeof session.font === "string" && session.font.length > 0,
      "the terminal did not report an applied font", { surface });
    t.diagnostic(`${app.name}: default list ${DEFAULT} applied ${initial.font}`);

    await s.run("core.settings.change", { key: SETTING, value: "No Such Terminal Font Family;Courier", scope: "common" });
    const courier = await s.until("terminal.session", (session) => session.font === "Courier",
      "the terminal did not skip the missing family and apply Courier", { surface });
    assert.equal(courier.error, undefined, "a missing family in the list is not an error");

    await s.run("core.settings.change", { key: SETTING, value: "No Such Terminal Font Family;Menlo", scope: "common" });
    const menlo = await s.until("terminal.session", (session) => session.font === "Menlo",
      "the terminal did not apply Menlo", { surface });
    t.diagnostic(`${app.name}: cell size Courier ${courier.cellWidth}x${courier.cellHeight}, Menlo ${menlo.cellWidth}x${menlo.cellHeight}`);
    assert.notDeepEqual([menlo.cellWidth, menlo.cellHeight], [courier.cellWidth, courier.cellHeight],
      "a different family changes the cell size");

    await s.run("core.settings.change", { key: SETTING, value: "No Such Terminal Font Family", scope: "common" });
    const system = await s.until("terminal.session", (session) => session.fontSystem === true,
      "the terminal did not use the system fixed-pitch font for a list without installed families", { surface });
    t.diagnostic(`${app.name}: no installed family applied ${system.font}`);
    assert.equal(system.error, undefined, "a list without installed families uses the system fixed-pitch font without an error");
  });
}
