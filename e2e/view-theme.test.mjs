import assert from "node:assert/strict";
import test from "node:test";
import { APPS, open } from "@soksak/window-check/app.mjs";
import { frames, readFrame, pixel } from "@soksak/window-check/frame.mjs";
import { fresh } from "./fixture.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: a newly created view paints the card theme throughout its first presentation`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    const terminal = await fresh(s);
    const theme = (await s.get("core.themes")).find(item => item.name === "midnight");
    assert.ok(theme, "the midnight theme is not declared");
    const initial = await s.get("core.grid");
    const card = initial.cards.find(item => item.tabs.some(tab => tab.id === terminal.surface));
    assert.ok(card, "the initial terminal card is absent");
    for (const mode of ["dark", "light"]) {
      console.info(`running ${app.name}: first view theme ${mode}`);
      await s.run("core.settings.theme", { name: theme.name, mode });
      const token = theme[mode].card;
      const expected = [1, 3, 5].map(at => parseInt(token.slice(at, at + 2), 16));
      await s.until("terminal.session", state => state?.background === token,
        "the initial terminal did not apply the card theme", { surface: terminal.surface });
      await s.presented();
      const recording = await s.record();
      // Session.record stops an unfinished recording during cleanup and preserves its failure.
      const { tab } = await s.run("core.card.add-tab", { card: card.id, plugin: "browser" });
      await s.until("core.surfaces", surfaces => surfaces.some(surface => surface.surface === tab && surface.visible &&
        surface.exposes.includes("dom browser.empty")), "the new view did not expose its empty document");
      await s.until("core.surface.document", doc => doc?.readyState === "complete" && doc.themed,
        "the new view did not apply its first theme", { surface: tab });
      const empty = await s.rect("browser.empty", undefined, tab);
      const { displayed } = await s.presented();
      const stopped = await recording.stop({ after: displayed + 100 });
      const captured = frames(recording.frames).map(readFrame);
      assert.equal(captured.length, stopped.count, "first-theme recording has missing frame files");
      assert.ok(captured.length > 1, "first-theme recording is incomplete");
      assert.equal(stopped.limited, false, "first-theme recording exhausted its buffer");
      assert.ok(stopped.longestGap <= 100, `first-theme recording gap ${stopped.longestGap}ms`);
      assert.ok(empty.width > 24 && empty.height > 24, "the empty view has no sample area");
      for (const [index, frame] of captured.entries()) {
        const scale = frame.scale * frame.contentScale;
        for (const dx of [12, empty.width / 2, empty.width - 12]) {
          const x = Math.floor(frame.content.x * frame.scale + ((empty.document?.x ?? 0) + empty.x + dx) * scale);
          const y = Math.floor(frame.content.y * frame.scale +
            ((empty.document?.y ?? 0) + empty.y + empty.height - 12) * scale);
          assert.ok(x >= 0 && y >= 0 && x < frame.width && y < frame.height, "first-theme sample is outside the recording");
          const actual = pixel(frame, x, y);
          assert.ok(actual.every((value, channel) => Math.abs(value - expected[channel]) <= 3),
            `${mode} frame ${index} at ${x},${y}: ${JSON.stringify(actual)}, expected ${token}`);
        }
      }
      t.diagnostic(`${mode}: ${captured.length} decoded frames retain card token ${token} across view creation`);
      await s.run("core.tab.close", { tab });
      await s.presented();
      console.info(`passed ${app.name}: first view theme ${mode}`);
    }
  });
}
