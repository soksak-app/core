// 실행 중인 앱의 카드 지정과 네이티브 폭을 읽기 전용으로 검사한다.
import assert from "node:assert/strict";
import { connect } from "@soksak/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const [option, configDir, ...extra] = process.argv.slice(2);
if (option !== "--config-dir" || !configDir || extra.length) {
  throw new Error("usage: observe-card-panels.mjs --config-dir <running application config directory>");
}
const endpoint = JSON.parse(readFileSync(join(configDir, "endpoint.json"), "utf8"));
console.log(`OBSERVE pid=${endpoint.pid} started=${endpoint.started} executable=${endpoint.executable}`);
const client = await connect({ configDir });
try {
  const grid = await client.request("status.get", { window: "main", name: "core.grid" });
  const surfaces = await client.request("status.get", { window: "main", name: "core.surfaces" });
  const sidebars = await client.request("status.get", { window: "main", name: "core.sidebars" });
  const assigned = grid.cards.filter((card) => card.active && ["left", "right"].some((side) => card.sidebars?.[side]));
  assert.ok(assigned.length, "no active card has assigned side panels; nothing was measured");
  for (const card of assigned) {
    const surface = surfaces.find((item) => item.surface === card.active && item.visible);
    assert.ok(surface?.applied, `card ${card.id} has no applied visible surface`);
    let reserved = 0;
    for (const side of ["left", "right"]) {
      const state = card.sidebars[side];
      if (!state) continue;
      assert.ok(sidebars.some((item) => item.sidebar === `${card.id}:${side}` && item.set === state.set),
        `assigned ${card.id}:${side} is absent from drawn sidebars: ${JSON.stringify({ card, surface, sidebars })}`);
      assert.equal(state.collapsed, false, `card ${card.id}:${side} is folded; this observer requires unfolded sides`);
      reserved += state.size;
    }
    assert.ok(Math.abs(surface.applied.w - (card.w - reserved - 2)) <= 1,
      `card ${card.id}: native width ${surface.applied.w} differs from ${card.w - reserved - 2} after ${reserved} reserved points`);
    console.log(`PASS card=${card.id} cardWidth=${card.w} nativeWidth=${surface.applied.w} reserved=${reserved}`);
  }
} finally {
  client.close();
}
