// Real-input-tier window check: checks that the input tool sends events by the same path as the user.
//
// This tier sends HID events with CGEventPost, so it uses the pointer and the keyboard of the user and activates the application. It is not part of the default window checks,
// and runs only in a run that the user approved, with pnpm -F @soksak/e2e verify:real.
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "../fixture.mjs";
import { ensureTerminals } from "../terminal-screen.mjs";
import { readPasteboard, writePasteboard } from "@soksak/window-check/pasteboard.mjs";
import { bringFront, click, post, requireTrusted } from "./hid.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: a posted HID click reaches the terminal region through the window server`, { timeout: 60000 }, async (t) => {
    requireTrusted();
    const s = await open(t, app);
    await fresh(s);
    const [terminal] = await ensureTerminals(s, 1);
    const surface = terminal.surface;
    await s.presented();
    const view = await s.rect("terminal.view", undefined, surface);
    const point = await bringFront(s, app, view);

    post([{ type: "move", x: point.x, y: point.y }]);
    await s.until("host.window", (window) => Math.abs(window.pointer.x - point.x) < 1 && Math.abs(window.pointer.y - point.y) < 1,
      `the system pointer did not move to the posted point ${point.x},${point.y}`);
    click(point.x, point.y);
    await s.until("host.window", (window) => window.regions.some((region) => region.surface === surface && region.focused),
      "a posted click did not give the terminal region native focus");
  });

  test(`${app.name}: an injected wheel keeps its own modifier flags while HID system reports Shift`, { timeout: 60000 }, async (t) => {
    requireTrusted();
    const s = await open(t, app);
    await fresh(s);
    const [terminal] = await ensureTerminals(s, 1);
    const surface = terminal.surface;
    await s.run("terminal.input", { bytes: "i=0; while [ $i -lt 200 ]; do echo row$i; i=$((i+1)); done\r" }, surface);
    await s.until("terminal.session", (session) => session.scrollback?.history > 20, "the rows did not exceed the screen", { surface });
    const view = await s.rect("terminal.view", undefined, surface);
    await bringFront(s, app, view);
    // Posts the Shift key state to the HID system. An event without an origin inherits this flag.
    post([{ type: "key", code: 56, down: true, modifiers: ["shift"] }]);
    s.cleanup(() => post([{ type: "key", code: 56, down: false }]));
    const seen = (await s.get("core.surface.input", surface)).at(-1)?.sequence ?? 0;
    await s.pointer(view.document.x + view.x + view.width / 2, view.document.y + view.y + view.height / 2, "scroll", { deltaY: -120 });
    const events = await s.until("core.surface.input", (list) => list.some((event) => event.sequence > seen && event.type === "wheel"),
      "the injected wheel did not reach the terminal page", { surface });
    const wheel = events.find((event) => event.sequence > seen && event.type === "wheel");
    assert.deepEqual(wheel.modifiers, [], "the injected wheel carried inherited HID-system modifier flags");
    await s.until("terminal.session", (value) => value.scrollback.offset > 0,
      "the injected vertical wheel did not scroll the history while Shift was held", { surface });
  });

  test(`${app.name}: a posted click on the inset sidebar divider folds the sidebar and keeps its width`, { timeout: 60000 }, async (t) => {
    requireTrusted();
    const s = await open(t, app);
    await fresh(s);
    const first = (await s.get("core.grid")).cards.find((item) => item.tabs?.length);
    const set = (await s.get("core.settings")).values.sets[0];
    assert.ok(first && set, "no card and set for the sidebar fixture");
    await s.run("core.card.sidebar.set", { card: first.id, side: "left", set: set.id });
    const grid = await s.until("core.grid", (value) => value.cards.some((card) => card.sidebars?.left), "no card holds an inset sidebar");
    const card = grid.cards.find((item) => item.sidebars?.left);
    await s.run("core.card.sidebar.size", { card: card.id, side: "left", size: 300 });
    await s.until("core.grid", (value) => value.cards.find((item) => item.id === card.id)?.sidebars?.left?.size === 300,
      "the sidebar did not take 300");
    const grip = await s.rect("core.card.sidebar.grip", 0);
    const point = await bringFront(s, app, grip);
    post([{ type: "move", ...point }, { type: "down", ...point, clicks: 1 }, { type: "up", ...point, clicks: 1 }]);
    // A press collapses immediately and does not change the stored width.
    const done = await s.until("core.grid", (value) => value.cards.find((item) => item.id === card.id)?.sidebars?.left?.collapsed === true,
      "a posted click on the divider did not fold the sidebar");
    assert.equal(done.cards.find((item) => item.id === card.id).sidebars.left.size, 300, "the click changed the stored width");
  });

  test(`${app.name}: the real-input pasteboard helpers restore every item type`, { timeout: 30000 }, async (t) => {
    const s = await open(t, app);
    const items = [{
      "public.utf8-plain-text": Buffer.from("real input").toString("base64"),
      "public.png": Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"),
    }];
    writePasteboard(items);
    assert.deepEqual(readPasteboard().items, items);
  });
}
