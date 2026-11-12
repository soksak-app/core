// A still capture of a covered window is written without a permission prompt, the activation of the application or the real
// cursor: while the window draws covered (`diagnostics.window.draw-covered`), the region document of a tab stays shown and a
// change made while covered reaches it (docs/spec/hosts.md#platform-interface, docs/spec/native-surfaces.md#document-regions).
// The stills are evidence: the check judges that each is written, not what it shows. The document is the region document of
// the layout probe start tab, which paints its content in a color on command and reports its visibility state and the number
// of its visibility changes (layoutprobe.document).
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, realpathSync, rmSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { APPS, holdCovered, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";

const RED = [0xc8, 0x32, 0x32];
const BLUE = [0x32, 0x78, 0xc8];
/** The CSS color that the document reports for a color. */
const css = ([r, g, b]) => `rgb(${r}, ${g}, ${b})`;
const hex = (rgb) => `#${rgb.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
/**
 * Takes a still of the window, requires that its file is written and returns its path. The files are removed when the check
 * ends, and each folder after its files: the cleanups run in reverse order of registration.
 */
async function still(s, t, folders) {
  const { path } = await s.request("diagnostics.capture.still", {});
  if (!folders.has(dirname(path))) {
    folders.add(dirname(path));
    s.cleanup(() => rmdirSync(dirname(path)));
  }
  s.cleanup(() => unlinkSync(path));
  assert.ok(existsSync(path), `the still ${path} was not written`);
  t.diagnostic(`still capture: ${path}`);
  return path;
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: a covered window keeps the document of its tab shown and its changes, and its stills are written`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    const { surface } = await fresh(s);
    s.cleanup(await holdCovered(s));
    await s.registered(surface, ["command layoutprobe.document.color", "status layoutprobe.document"]);
    await s.until("layoutprobe.document", (at) => at.reported, "the region document did not report", { surface });
    await s.run("layoutprobe.document.color", { color: hex(RED) }, surface);
    await s.until("layoutprobe.document", (at) => at.color === css(RED) && at.document === "visible" && at.changes === 0,
      "the region document did not report itself visible and red", { surface });
    await s.presented();
    const before = await s.get("host.window");
    assert.equal(before.active, false, "the application is active before the still");
    const region = before.documents.find((d) => d.surface === surface && d.document === "page" && d.visible);
    assert.ok(region, `the probe tab has no visible document region: ${JSON.stringify(before.documents)}`);
    const folders = new Set();

    // Still A: the window before the cover.
    await still(s, t, folders);

    // A project window of the same application covers the check window, as in e2e/window-occlusion.test.mjs.
    const root = realpathSync(mkdtempSync(join(tmpdir(), "soksak-capture-covered-")));
    s.cleanup(() => rmSync(root, { recursive: true, force: true }));
    s.cleanup(async () => {
      for (const window of await s.get("host.windows")) {
        if (window.window !== s.window) await s.on(window.window).close();
      }
      await s.windows(1, "the check left an extra window");
      for (const project of await s.get("core.projects")) {
        if (project.root === root) await s.run("core.project.close", { id: project.id });
      }
      await s.run("core.projects.flush");
    });
    await s.run("core.settings.set", { patch: { projectOpening: "windows" }, scope: "common" });
    await s.run("core.project.open", { root, color: "#7db4ff" });
    const windows = await s.windows(2, "the project window did not open");
    const cover = s.on(windows.find((w) => w.window !== s.window).window);
    const frame = (await s.get("host.window")).frame;
    await cover.run("host.window.resize", { width: frame.width + 200, height: frame.height + 100 });
    await cover.run("host.window.move", { x: frame.x - 100, y: frame.y - 50 });
    await s.until("host.window", (w) => w.occluded === true, "the covered window was not reported occluded");

    // Still B: the covered window keeps the document shown.
    await s.presented();
    await still(s, t, folders);
    const shown = await s.get("layoutprobe.document", surface);
    assert.deepEqual([shown.document, shown.changes], ["visible", 0], "the document of the covered window was hidden");

    // Still C: a change of the theme and of the document while covered reaches the document. The fixture starts from the default theme
    // (diagnostics.fixture, docs/spec/endpoint.md), so the change is to the other mode of the active theme, whose colors differ.
    const { theme, mode } = (await s.get("core.settings")).values;
    const other = mode === "dark" ? "light" : "dark";
    const palettes = (await s.get("core.themes")).find((item) => item.name === theme);
    assert.notDeepEqual(palettes?.[other], palettes?.[mode], `the theme ${theme} has the same colors in ${mode} and ${other}`);
    await s.run("core.settings.theme", { name: theme, mode: other });
    await s.run("layoutprobe.document.color", { color: hex(BLUE) }, surface);
    await s.until("layoutprobe.document", (at) => at.color === css(BLUE) && at.document === "visible" && at.changes === 0,
      "the region document of the covered window did not report itself visible and blue", { surface });
    await s.presented();
    await still(s, t, folders);

    const after = await s.get("host.window");
    assert.equal(after.occluded, true, "the window is no longer covered at the end");
    assert.equal(after.active, false, "the application became active");
  });
}
