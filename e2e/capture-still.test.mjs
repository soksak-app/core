// 정지 PNG의 실제 불투명 픽셀과 네이티브 경계를 검사한다. 미리보기의 표시 상태를 판정에 쓰지 않는다.
import assert from "node:assert/strict";
import test from "node:test";
import { unlinkSync, rmdirSync } from "node:fs";
import { dirname } from "node:path";
import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";
import { readPng, distance } from "@soksak/window-check/png.mjs";
for (const app of Object.values(APPS))
  test(`${app.name}: inactive still PNG contains opaque native boundaries`, { timeout: 120000 }, async (t) => {
    console.info(`START ${app.name}: still PNG observation`);
    const started = performance.now();
    const s = await open(t, app);
    assert.ok(s, "required host is not built");
    t.diagnostic(`tested endpoint: ${JSON.stringify(s.client.endpoint)}`);
    await fresh(s);
    await s.run("core.settings.theme", { name: "midnight", mode: "dark" });
    const card = (await s.get("core.grid")).cards.find((item) => item.tabs.some((tab) => tab.plugin === "terminal"));
    assert.ok(card, "terminal card absent");
    const tab = card.tabs.find((tab) => tab.plugin === "terminal");
    await s.run("core.tab.select", { tab: tab.id });
    const set = (await s.get("core.settings")).values.sets.find((item) => item.sections.length);
    assert.ok(set, "section set absent");
    for (const side of ["left", "right"]) {
      await s.run("core.card.sidebar.set", { card: card.id, side, set: set.id });
      await s.run("core.card.sidebar.size", { card: card.id, side, size: 120 });
    }
    await s.presented();
    const before = await s.get("host.window");
    assert.equal(before.active, false);
    assert.equal(before.occluded, false);
    const surface = (await s.surfaces()).find((item) => item.surface === tab.id);
    assert.ok(surface?.applied, "native surface absent");
    const { path } = await s.request("diagnostics.capture.still", {});
    s.cleanup(() => rmdirSync(dirname(path)));
    s.cleanup(() => unlinkSync(path));
    {
      const image = readPng(path),
        scale = before.scale,
        rect = surface.applied;
      assert.equal(image.width, before.content.width * scale);
      assert.equal(image.height, before.content.height * scale);
      const points = [];
      for (const edge of ["left", "right", "top"])
        for (const delta of [-24, -12, 12, 24]) {
          const vertical = edge !== "top",
            coordinate = edge === "left" ? rect.x - 1 : edge === "right" ? rect.x + rect.w : rect.y - 1;
          const cross = vertical ? rect.y + rect.h / 2 : rect.x + rect.w / 2;
          const matches = [-1, -0.5, 0, 0.5, 1].map((offset) => {
            const x = Math.floor((vertical ? coordinate + offset : cross + delta) * scale),
              y = Math.floor((vertical ? cross + delta : coordinate + offset) * scale);
            return { x, y, rgb: image.pixel(x, y), alpha: image.alpha(x, y) };
          });
          const match = matches.find((point) => point.alpha === 255 && distance(point.rgb, [43, 46, 61]) <= 3);
          assert.ok(match, `${edge}: native boundary absent or transparent ${JSON.stringify({ rect, matches })}`);
          points.push(match);
        }
      t.diagnostic(`PNG ${image.width}x${image.height}: ${JSON.stringify(points)}`);
      const after = await s.get("host.window");
      assert.equal(after.active, false);
      assert.equal(after.occluded, false);
      console.info(`PASS ${app.name}: still PNG observation (${Math.round(performance.now() - started)}ms)`);
    }
  });
