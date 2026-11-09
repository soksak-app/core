// Leaves stills of the section surfaces of card sidebars and of a document region in light and dark modes for inspection at
// original resolution (docs/operations/examples.md#window-checks). The sections and the document are those of the layout probe
// fixture (e2e/fixtures/layout-probe): the list set (alpha, fill, follow) on the left of its card and the tabs set (alpha, beta)
// on the right, beside the document region of its tab. An image is an observation and no result of a check; the check fails when
// a section does not mount or reports an error, or the document does not report the color scheme of the mode.
import { copyFileSync, mkdirSync, rmSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { cardSidebar, fresh } from "../fixture.mjs";

const OUTPUT = new URL("../../target/section-design/", import.meta.url).pathname;

/** Waits until the sidebar shows the set with every section mounted and free of errors. */
async function shown(s, sidebar, sections) {
  await s.until("core.sidebars", (bars) => {
    const bar = bars.find((item) => item.sidebar === sidebar);
    return bar !== undefined && sections.every((id) => bar.sections.find((item) => item.id === id)?.mounted === true)
      && bar.sections.every((item) => item.error === null);
  }, `${sidebar} did not mount ${sections.join(", ")}`);
}

for (const app of Object.values(APPS))
  test(`${app.name}: stills of the probe sections and document in each mode`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    const { surface, plugin } = await fresh(s);
    const [left] = await cardSidebar(s);
    await shown(s, left, ["layoutprobe.alpha", "layoutprobe.fill", "layoutprobe.follow"]);
    const card = left.slice(0, -":left".length);
    await s.run("core.card.sidebar.set", { card, side: "right", set: `${plugin}.tabs` });
    s.cleanup(() => s.run("core.card.sidebar.set", { card, side: "right", set: "inherit" }));
    await shown(s, `${card}:right`, ["layoutprobe.alpha"]);
    mkdirSync(OUTPUT, { recursive: true });
    for (const mode of ["light", "dark"]) {
      await s.run("core.settings.set", { patch: { mode } });
      await s.until("core.settings", (value) => value.values.mode === mode, `the mode did not become ${mode}`);
      await s.until("layoutprobe.document", (value) => value.reported && value.scheme === mode,
        `the document region did not report the ${mode} color scheme`, { surface });
      await s.presented();
      const { path } = await s.request("diagnostics.capture.still", {});
      s.cleanup(() => rmSync(dirname(path), { recursive: true, force: true }));
      copyFileSync(path, join(OUTPUT, `${app.name}-${mode}.png`));
      unlinkSync(path);
      t.diagnostic(`still ${join(OUTPUT, `${app.name}-${mode}.png`)}`);
    }
  });
