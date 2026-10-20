// Window check of F192: a terminal tab hidden behind a second tab of its card keeps its surface mounted, and when it is shown
// again it draws the output of its shell. Before the correction the workbench sent the background `open` without `image` for
// the mounted terminal, the sidecar made the surface headless, and the output after Enter was drawn only when another cause
// drew a frame: a key, a focus change, a cursor blink or a read of the screen. The check therefore reads no screen after Enter
// and turns the cursor blink off, so a frame that holds the output after Enter comes only from the drawing of that output.
// Enter does not pass through the input method, so it reaches the sidecar in an application that is not active. The records
// name each decision: no background `open` for the mounted terminal and no headless mode of its surface.
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, open, within } from "@soksak/window-check/app.mjs";
import { EVERY_LEVEL } from "@soksak/window-check/log-policy.mjs";
import { allRows, tailOf } from "./chains.mjs";
import { fresh } from "./fixture.mjs";
import { ensureTerminals, readScreenUntil } from "./terminal-screen.mjs";

const promptCount = (lines) => lines.filter((line) => line.startsWith("sh-")).length;
/** The upper bound of the wait for the frame of the output; the wait ends at the notice of the log that shows the frame. */
const FRAME_LIMIT = 10_000;
/** The records that the check reads, all below `error`, which the default policy does not store. */
const READS = ["sidecar.vt.pty_read", "sidecar.vt.frame", "sidecar.vt.surface_mode", "page.background.session"];

for (const app of Object.values(APPS)) {
  test(`${app.name}: a terminal shown again after another tab of its card draws the output after Enter`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s, { settings: { "terminal.cursor.blink": "Never" }, log: EVERY_LEVEL, reads: READS });
    const [terminal] = await ensureTerminals(s, 1);
    await s.until("terminal.session", (state) => Boolean(state.sessionId),
      `${terminal.surface} did not open a sidecar session`, { surface: terminal.surface });
    const { sessionId: session } = await s.get("terminal.session", terminal.surface);
    await readScreenUntil(s, terminal.surface, (rows) => promptCount(rows) >= 1, "the shell printed no prompt");

    // A second tab in the card of the terminal hides the terminal; its surface stays mounted in the holding place.
    const sinceHide = await tailOf(s);
    const card = (await s.get("core.grid")).cards.find((item) => item.tabs.some((tab) => tab.id === terminal.surface));
    assert.ok(card, `no card holds the terminal ${terminal.surface}`);
    await s.run("core.card.add-tab", { card: card.id, plugin: "browser" });
    await s.until("core.surfaces", (surfaces) => surfaces.some((item) => item.visible && item.plugin === "browser"),
      "the browser tab did not become visible in the card of the terminal");
    await s.run("core.tab.select", { tab: terminal.surface });
    await s.until("core.surfaces", (surfaces) => surfaces.some((item) => item.visible && item.surface === terminal.surface),
      `the terminal ${terminal.surface} did not become visible again`);
    await s.presented();

    // The press gives the keyboard to the native region of the terminal.
    const host = await s.get("host.window");
    const region = host.regions.find((item) => item.surface === terminal.surface && item.name === "view");
    assert.ok(region?.frame, `native terminal region ${terminal.surface} has no frame`);
    await s.click(region.frame.x + region.frame.width / 2, region.frame.y + region.frame.height / 2);
    await s.until("host.window", (state) => state.regions.some((item) =>
      item.surface === terminal.surface && item.name === "view" && item.focused),
    `the terminal region ${terminal.surface} did not take the keyboard after the press`);

    // Enter asks the shell for the next prompt. The frame that holds the last output read after Enter is the drawing of it.
    const sinceEnter = await tailOf(s);
    await s.key("Enter", "down");
    await s.key("Enter", "up");
    let last = "the sidecar read no output of the shell after Enter";
    const drawn = async () => {
      const reads = await allRows(s, { channel: "all", event: "sidecar.vt.pty_read", session, since: sinceEnter });
      if (reads.length === 0) return null;
      const output = Math.max(...reads.map((row) => row.event.fields.sequence));
      const frames = await allRows(s, { channel: "all", event: "sidecar.vt.frame", surface: terminal.surface, since: sinceEnter });
      last = `the output after Enter reached sequence ${output}; the frames after Enter were (reason, sequence) `
        + JSON.stringify(frames.map((row) => [row.event.fields.reason, row.event.fields.sequence]));
      return frames.find((row) => row.event.fields.sequence >= output) ?? null;
    };
    const wait = async () => {
      for (; ;) {
        const before = await s.get("host.log");
        const frame = await drawn();
        if (frame !== null) return frame;
        await s.until("host.log", (value) => value.notices > before.notices, `the log announced no further change; ${last}`);
      }
    };
    try {
      const frame = await within(wait(), FRAME_LIMIT, `the frame of the output after Enter in ${terminal.surface}`);
      t.diagnostic(`${app.name}: the output after Enter was drawn by the frame ${frame.event.fields.reason} of sequence ${frame.event.fields.sequence}`);
    } catch (error) {
      error.message += `; ${last}`;
      throw error;
    }

    const rows = async (event) => (await allRows(s, { channel: "all", event, since: sinceHide })).map((row) => row.event);
    const decisions = (await rows("page.background.session")).filter((event) => event.fields?.tab === terminal.surface)
      .map((event) => `${event.fields.action}:${event.fields.surface}`);
    t.diagnostic(`${app.name}: background decisions of ${terminal.surface}: ${JSON.stringify(decisions)}`);
    assert.ok(!decisions.some((decision) => decision.startsWith("open:")),
      `a background open was sent for the mounted terminal ${terminal.surface}: ${JSON.stringify(decisions)}`);
    assert.deepEqual(decisions, ["skip:mounted"]);
    const headless = (await rows("sidecar.vt.surface_mode"))
      .filter((event) => event.surface === terminal.surface && event.fields?.mode === "headless");
    assert.deepEqual(headless, [], `the surface of the terminal ${terminal.surface} became headless`);
  });
}
