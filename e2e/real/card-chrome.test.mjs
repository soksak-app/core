// Real-input-tier check of the card chrome of core: the cursors of the dividers and the card icons. The system cursor follows the
// pointer of the window server, which the input that the host emulates inside the application does not move, so this check keeps
// real input (docs/operations/examples.md#end-to-end-run). The views are those of the raster probe, whose image region the sidecar
// redraws on command.
// Run it only with `make test-app-real` in a run that the user approved.
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "../fixture.mjs";
import { imageRect, rasterProbeTab } from "../input-probe.mjs";
import { bringFront, post, requireTrusted, screenCenter, systemCursor } from "./hid.mjs";

/** The colours that the raster probe repaints its image region in while a check reads the cursor over a divider. */
const REDRAW_COLOURS = Object.freeze(["#204060", "#602040", "#406020"]);

/** Opens raster probe tabs in `count` cards split from the focused card, and returns them as `{surface, card}`. */
async function rasterCards(s, count) {
  const first = await rasterProbeTab(s);
  const cards = [first];
  while (cards.length < count) {
    // Splits the largest probe card along its longer side, so the cards keep the minimum size of the layout.
    const grid = await s.get("core.grid");
    const [card] = grid.cards.filter((item) => cards.some((entry) => entry.card === item.id)).sort((a, b) => b.w * b.h - a.w * a.h);
    cards.push(await rasterProbeTab(s, { card: card.id, split: card.w >= card.h ? "right" : "bottom" }));
  }
  return cards;
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: dividers and card icons show their cursors after moves, focus changes, and view redraws`, { timeout: 180000 }, async (t) => {
    requireTrusted();
    const s = await open(t, app);
    await fresh(s);
    const [view] = await rasterCards(s, 2);
    const surface = view.surface;
    const content = await imageRect(s, surface);
    await bringFront(s, app, content);
    const grid = await s.get("core.grid");
    const dividers = [];
    for (let index = 0; ; index++) {
      const rect = await s.rect("core.divider", index).catch(() => null);
      if (!rect) break;
      dividers.push(rect);
    }
    const vertical = dividers.find((rect) => rect.height > rect.width * 4);
    assert.ok(vertical, `no vertical divider in ${JSON.stringify(dividers)}`);
    const divider = await screenCenter(s, vertical);
    const close = await screenCenter(s, await s.rect("core.card.close", 0));
    const inside = await screenCenter(s, content);
    const read = async (point) => {
      post([{ type: "move", x: inside.x, y: inside.y }, { type: "move", x: point.x, y: point.y }]);
      await s.presented();
      return systemCursor();
    };
    const seen = {};
    seen.dividerAfterView = await read(divider);
    seen.closeAfterView = await read(close);
    // While the sidecar repaints the image region (while the native surface is updated), reads the cursor over the divider several times.
    post([{ type: "move", x: divider.x, y: divider.y }]);
    seen.dividerDuringRedraw = [];
    for (const color of [...REDRAW_COLOURS, ...REDRAW_COLOURS.slice(0, 2)]) {
      await s.run("rasterprobe.color", { color }, surface);
      await s.presented();
      seen.dividerDuringRedraw.push(systemCursor());
    }
    // Gives focus to another card while the pointer stays on the divider. Each card records its kind and responder together.
    seen.focus = [];
    for (const card of grid.cards.filter((item) => item.tabs.length)) {
      await s.run("core.card.focus", { card: card.id });
      await s.presented();
      const plugin = card.tabs.find((tab) => tab.id === card.active)?.plugin;
      seen.focus.push({ card: card.id, plugin, cursor: systemCursor(), responder: (await s.get("host.window")).responder });
    }
    seen.dividerAfterFocus = seen.focus.find((item) => item.cursor !== "resizeLeftRight")?.cursor ?? "resizeLeftRight";
    // Gives focus to each card while the pointer stays on the icon.
    post([{ type: "move", x: close.x - 3, y: close.y }, { type: "move", x: close.x, y: close.y }]);
    await s.presented();
    // When focus changes the card width, the icon can leave from under the pointer. The cursor must be a hand if the icon stays under the pointer
    // and must not be a hand if it left.
    seen.closeAfterFocus = [];
    for (const card of grid.cards.filter((item) => item.tabs.length)) {
      await s.run("core.card.focus", { card: card.id });
      await s.presented();
      const now = await s.rect("core.card.close", 0);
      const at = await screenCenter(s, now);
      const under = Math.abs(at.x - close.x) <= now.width / 2 && Math.abs(at.y - close.y) <= now.height / 2;
      seen.closeAfterFocus.push({ card: card.id, under, cursor: systemCursor() });
    }
    // When the divider leaves while the pointer stays on the divider, the resize cursor must leave too.
    post([{ type: "move", x: divider.x, y: divider.y - 3 }, { type: "move", x: divider.x, y: divider.y }]);
    await s.presented();
    const line = (await s.get("core.grid")).cards.find((card) => card.active === surface)?.c1;
    // The divider rectangle is in document coordinates and the grid lines are in board coordinates.
    const current = await s.get("core.grid");
    const moveFrom = current.lines.x;
    const center = vertical.x + vertical.width / 2 - current.plane.x;
    const index = moveFrom.findIndex((position) => Math.abs(position - center) <= 4);
    assert.ok(index > 0, `the hovered divider is not a grid line: ${JSON.stringify({ lines: moveFrom, vertical, line })}`);
    await s.run("core.boundary.move", { axis: "x", line: index, position: moveFrom[index] + 80 });
    await s.presented();
    await s.presented();
    seen.afterDividerLeft = systemCursor();
    await s.run("core.boundary.move", { axis: "x", line: index, position: moveFrom[index] });
    t.diagnostic(`${app.name}: ${JSON.stringify(seen)}`);
    assert.ok(seen.closeAfterFocus.every((item) => (item.cursor === "pointingHand") === item.under),
      `close icon after focus changes: ${JSON.stringify(seen)}`);
    assert.ok(seen.closeAfterFocus.some((item) => item.under), `the icon never stayed under the pointer: ${JSON.stringify(seen)}`);
    assert.ok(!["resizeLeftRight", "columnResize"].includes(seen.afterDividerLeft), `the resize cursor stayed after the divider left: ${JSON.stringify(seen)}`);
    const resize = ["resizeLeftRight", "columnResize"];
    assert.ok(resize.includes(seen.dividerAfterView), `divider after the view: ${JSON.stringify(seen)}`);
    assert.equal(seen.closeAfterView, "pointingHand", `close icon after the view: ${JSON.stringify(seen)}`);
    assert.ok(seen.dividerDuringRedraw.every((name) => resize.includes(name)), `divider during redraws: ${JSON.stringify(seen)}`);
    assert.ok(resize.includes(seen.dividerAfterFocus), `divider after a focus change: ${JSON.stringify(seen)}`);
  });
}
