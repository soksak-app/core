import assert from "node:assert/strict";
import test from "node:test";
import { APPS, judgeShownChanges, open, owe } from "@soksak/window-check/app.mjs";
import { frames, readFrame, pixel } from "@soksak/window-check/frame.mjs";
import { readStills, requireNoLostStills } from "@soksak/window-check/stills.mjs";
import { fresh, paintProbeDocument } from "./fixture.mjs";

/** The CSS color rgb(r, g, b) of a #rrggbb token, as a view reports its computed background. */
const cssColor = (token) => `rgb(${[1, 3, 5].map((at) => parseInt(token.slice(at, at + 2), 16)).join(", ")})`;

for (const app of Object.values(APPS)) {
  test(`${app.name}: a newly created view paints the card theme throughout its first presentation`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    const start = await fresh(s);
    const theme = (await s.get("core.themes")).find(item => item.name === "midnight");
    assert.ok(theme, "the midnight theme is not declared");
    const initial = await s.get("core.grid");
    const card = initial.cards.find(item => item.tabs.some(tab => tab.id === start.surface));
    assert.ok(card, "the card of the start tab is absent");
    for (const mode of ["dark", "light"]) {
      console.info(`running ${app.name}: first view theme ${mode}`);
      await s.run("core.settings.theme", { name: theme.name, mode });
      const token = theme[mode].card;
      const expected = [1, 3, 5].map(at => parseInt(token.slice(at, at + 2), 16));
      await s.until("layoutprobe.surface", state => state?.theme?.background === cssColor(token),
        "the start tab did not apply the card theme", { surface: start.surface });
      // The frames before the new view presents show the start tab at the sample points: its page shows the card token, and its
      // document region (rgb(0,128,96) by default) is painted in the card token so that only the new view can depart from it.
      await paintProbeDocument(s, start.surface, cssColor(token));
      await s.presented();
      const recording = await s.record();
      // Session.record stops an unfinished recording during cleanup and preserves its failure.
      // The new view is a tab of the second layout probe, whose empty area shows only the background of its page.
      // The new tab changes the screen: the recording owes frames from the request to the display of its first theme
      // (judgeShownChanges).
      const from = await owe(s);
      const { tab } = await s.run("core.card.add-tab", { card: card.id, plugin: "layoutprobe2" });
      await s.until("core.surfaces", surfaces => surfaces.some(surface => surface.surface === tab && surface.visible &&
        surface.exposes.includes("element layoutprobe2.empty")), "the new view did not expose its empty area");
      await s.until("core.surface.document", doc => doc?.readyState === "complete" && doc.themed,
        "the new view did not apply its first theme", { surface: tab });
      const empty = await s.rect("layoutprobe2.empty", undefined, tab);
      const { displayed } = await s.presented();
      const owed = [{ from, to: displayed }];
      const stopped = await recording.stop({ after: displayed + 100 });
      const captured = frames(recording.frames).map(readFrame);
      assert.equal(captured.length, stopped.count, "first-theme recording has missing frame files");
      assert.ok(captured.length > 1, "first-theme recording is incomplete");
      // Every still of the view creation is judged, so a still that the recording lost could have shown another colour.
      requireNoLostStills(readStills(stopped.stills), "the first theme");
      judgeShownChanges(stopped, owed, { what: "new tab" });
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
