// A view that a main page reloaded by a plugin change creates applies the theme of the window, and draws its text and buttons in
// colors that stand out from the background (docs/spec/native-surfaces.md#view-surfaces). The check sets the dark mode, opens a fixture
// view tab of the layout probe, and reads the theme that the view draws with before the reload: its scheme, the background of its body,
// the text color, the colors of a button and the theme tokens that it reads. It then applies a plugin change with core.plugins.apply,
// which reloads the page, and waits on the statuses of the views that the reloaded page shows. A view after the reload fails when its
// scheme is not dark, when its tokens or its colors differ from the view before the reload, or when its text or button label has a
// contrast below 4.5:1 with its background (WCAG 2.2, success criterion 1.4.3). The fixture view stands for the agents sidebar views and
// the clubhouse buttons of the original report, which need the agents and clubhouse plugins that the check does not install.
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, keepCommonSettings, open } from "@soksak/window-check/app.mjs";
import { EVERY_LEVEL } from "@soksak/window-check/log-policy.mjs";
import { allRows, tailOf } from "@soksak/window-check/chains.mjs";
import { fresh, START_PLUGIN } from "./fixture.mjs";

/** The page.theme.applied records of the view `surface` that the log holds after `since`, in the order of the log. */
async function themeRecords(s, since, surface) {
  for (;;) {
    const previous = await s.get("host.log");
    await s.flushLog();
    const records = (await allRows(s, { channel: "all", since })).map(({ event }) => event)
      .filter((event) => event.event === "page.theme.applied" && event.fields?.surface === surface);
    if (records.length > 0) return records;
    await s.until("host.log", (value) => value.notices > previous.notices,
      `view ${surface} wrote no page.theme.applied record after the reload`);
  }
}

/** The RGB channels and the alpha of a computed color, which the view reports as rgb() or rgba(). */
function parseColor(text) {
  const match = /^rgba?\((\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?)(?:,\s*(\d+(?:\.\d+)?))?\)$/.exec(text);
  if (!match) throw new Error(`computed color ${JSON.stringify(text)} is not rgb() or rgba()`);
  const alpha = match[4] === undefined ? 1 : Number(match[4]);
  if (alpha !== 1) throw new Error(`computed color ${JSON.stringify(text)} is not opaque, so its contrast is not judged`);
  return match.slice(1, 4).map(Number);
}

/** The relative luminance of an sRGB color (WCAG 2.2, definition of relative luminance). */
function luminance(channels) {
  const [r, g, b] = channels.map((value) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The contrast ratio of two opaque computed colors (WCAG 2.2, definition of contrast ratio). */
function contrastOf(foreground, background) {
  const [high, low] = [luminance(parseColor(foreground)), luminance(parseColor(background))].sort((a, b) => b - a);
  return (high + 0.05) / (low + 0.05);
}

/** The lowest contrast ratio that WCAG 2.2 success criterion 1.4.3 allows for text of normal size. */
const MINIMUM_CONTRAST = 4.5;

/** The colors and tokens of a view as the probe reports them, with the contrast of its text and of its button label. */
function judged(theme) {
  // default: a probe that predates the text and button fields reports neither, so the fixture registry must be rebuilt.
  assert.ok(typeof theme?.text === "string" && theme.button && typeof theme.button.color === "string",
    `the layout probe reports no text or button colors; rebuild the fixture registry (make build-fixture-registry): ${JSON.stringify(theme)}`);
  return {
    scheme: theme.scheme,
    background: theme.background,
    text: theme.text,
    button: theme.button,
    tokens: theme.tokens,
    textContrast: contrastOf(theme.text, theme.background),
    buttonContrast: contrastOf(theme.button.color, theme.button.background),
  };
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: a view that a reloaded main page creates applies the dark theme of the window`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    const { surface } = await fresh(s, { log: EVERY_LEVEL, reads: ["page.theme.applied"] });
    await keepCommonSettings(s);
    await s.run("core.settings.set", { patch: { mode: "dark" }, scope: "common" });
    await s.until("core.settings", (settings) => settings.values.mode === "dark" && !settings.saving,
      "the host did not settle the dark theme");
    await s.until("layoutprobe.surface", (value) => value.theme?.scheme === "dark", "the view did not apply the dark theme before the reload",
      { surface });
    const before = judged((await s.get("layoutprobe.surface", surface)).theme);
    assert.ok(before.textContrast >= MINIMUM_CONTRAST && before.buttonContrast >= MINIMUM_CONTRAST,
      `the view draws its text and button too close to the background before the reload: ${JSON.stringify(before)}`);

    const since = await tailOf(s);
    const oldStart = (await s.get("core.window.workbench")).start;
    // The reload that the original report names: a plugin change applied by core.plugins.apply reloads the page with that cause
    // (packages/workbench/plugin-apply.js), and the reply comes before the reload ends the page.
    assert.deepEqual(await s.run("core.plugins.apply", {}), { reloaded: true }, "core.plugins.apply did not reload the page");
    // The page answers its status requests with 1003 until host.windows reports the window ready (docs/spec/endpoint.md). The first
    // value of host.windows can still show the window ready before the reload ends its page, because the reply of core.plugins.apply
    // comes before the end (mygo). So the wait takes the transition: the window reports not ready, and then ready again.
    let loading = false;
    await s.until("host.windows", (list) => {
      const ready = list.some((window) => window.window === s.window && window.ready);
      if (!ready) loading = true;
      return ready && loading;
    }, "the reloaded main page did not report ready");
    await s.until("core.window.workbench", (workbench) => workbench.start !== oldStart && workbench.readyState === "complete",
      "the workbench did not start again");
    const shown = (item) => item.kind === "tab" && item.plugin === START_PLUGIN && item.visible && item.status?.phase === "ready";
    const views = (await s.until("core.surfaces", (list) => list.some(shown), "no view of the reloaded page became ready"))
      .filter(shown).map((item) => item.surface);

    for (const view of views) {
      await s.registered(view, ["status layoutprobe.surface"]);
      await s.until("layoutprobe.surface", (value) => value?.theme !== undefined && value.theme !== null,
        `view ${view} reports no theme after the reload`, { surface: view });
      const records = await themeRecords(s, since, view);
      const applied = records.at(-1);
      const after = judged((await s.get("layoutprobe.surface", view)).theme);
      t.diagnostic(`${app.name}: view ${view} after the reload ${JSON.stringify(after)}; before ${JSON.stringify(before)}`);
      assert.equal(applied.fields.scheme, "dark",
        `view ${view} applied the ${applied.fields.scheme} theme after the reload, not dark (record ${JSON.stringify(applied.fields)})`);
      assert.equal(after.scheme, "dark", `view ${view} reports the ${after.scheme} theme after the reload, not dark: ${JSON.stringify(after)}`);
      if (view === surface) {
        assert.deepEqual(after.tokens, before.tokens, `view ${view} reads other theme tokens after the reload: ${JSON.stringify(after.tokens)}`);
        assert.deepEqual(
          { text: after.text, background: after.background, button: after.button },
          { text: before.text, background: before.background, button: before.button },
          `view ${view} draws its colors after the reload differently than before it`,
        );
      }
      assert.ok(after.textContrast >= MINIMUM_CONTRAST,
        `view ${view} draws its text with a contrast of ${after.textContrast.toFixed(2)} after the reload, below ${MINIMUM_CONTRAST}: ${JSON.stringify(after)}`);
      assert.ok(after.buttonContrast >= MINIMUM_CONTRAST,
        `view ${view} draws its button label with a contrast of ${after.buttonContrast.toFixed(2)} after the reload, below ${MINIMUM_CONTRAST}: ${JSON.stringify(after)}`);
    }
  });
}
