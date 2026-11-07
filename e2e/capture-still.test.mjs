// Checks the real opaque pixels of a still PNG and the native bounds. The display state of the preview is not used for the verdict.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";
import { distance } from "@soksak/window-check/png.mjs";
import { readStillCapture } from "./still-capture.mjs";
for (const app of Object.values(APPS))
  test(`${app.name}: inactive still PNG contains opaque native boundaries`, { timeout: 120000 }, async (t) => {
    console.info(`START ${app.name}: still PNG observation`);
    const started = performance.now();
    const s = await open(t, app);
    t.diagnostic(`tested endpoint: ${JSON.stringify(s.client.endpoint)}`);
    await fresh(s);
    // An inactive application shows its window behind the frontmost window, where its image regions do not draw. The still
    // reads the pixels of the window wherever it is in the window order (docs/spec/native-surfaces.md#image-regions).
    await s.request("diagnostics.window.draw-covered", { draw: true });
    s.cleanup(() => s.request("diagnostics.window.draw-covered", { draw: false }));
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
    const surface = (await s.surfaces()).find((item) => item.surface === tab.id);
    assert.ok(surface?.applied, "native surface absent");
    const { path, image } = await readStillCapture(s, t);
    // Every diagnostic file of an application is in <config-dir>/logs, captures in its captures folder (F124.2).
    const captures = join(realpathSync(app.configDir), "logs", "captures");
    assert.ok(realpathSync(path).startsWith(`${captures}/`), `the still capture ${path} is not in ${captures}`);
    {
      const scale = before.scale,
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
      console.info(`PASS ${app.name}: still PNG observation (${Math.round(performance.now() - started)}ms)`);
    }
  });

// A still is the window as it is shown: with the settings modal open, the still holds the modal over the workbench, so most of
// its pixels differ from a still of the same window without the modal (docs/spec/native-surfaces.md#image-regions). A modal web
// view that the still leaves out leaves the plain workbench, the pixels of the still without the modal.
for (const app of Object.values(APPS))
  test(`${app.name}: a still with the settings modal open holds the modal`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    await s.request("diagnostics.window.draw-covered", { draw: true });
    s.cleanup(() => s.request("diagnostics.window.draw-covered", { draw: false }));
    const still = async () => {
      await s.presented();
      return (await readStillCapture(s, t)).image;
    };
    const without = await still();
    await s.run("core.settings.open");
    s.cleanup(() => s.run("core.settings.close"));
    await s.until("core.modal", (modal) => modal?.id === "settings", "the settings modal did not open");
    if ((await s.get("core.modal")).document !== null) {
      await s.until("core.modal", (modal) => modal.document.loaded === true, "the settings document did not load");
    }
    const withModal = await still();
    assert.equal(withModal.width, without.width);
    assert.equal(withModal.height, without.height);
    // Every fourth device pixel in each direction, which a modal over the window changes in most places.
    let read = 0, changed = 0;
    for (let y = 0; y < without.height; y += 4)
      for (let x = 0; x < without.width; x += 4) {
        read += 1;
        if (distance(withModal.pixel(x, y), without.pixel(x, y)) > 6) changed += 1;
      }
    t.diagnostic(`${changed} of ${read} sampled pixels changed with the settings modal open`);
    assert.ok(changed / read >= 0.5, `the still with the settings modal open changed ${changed} of ${read} sampled pixels of the still without it`);
  });

// The same holds for a window that another window covers: WebKit stops the rendering of a document in an occluded window, so a
// modal web view that keeps the occlusion detection does not render and stays hidden, and the still holds the plain workbench
// (docs/spec/native-surfaces.md#image-regions). A project window of the same application covers the check window, as in
// e2e/capture-covered.test.mjs, so the window is covered whatever a person has in front.
for (const app of Object.values(APPS))
  test(`${app.name}: a still of a covered window with the settings modal open holds the modal`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    await s.request("diagnostics.window.draw-covered", { draw: true });
    s.cleanup(() => s.request("diagnostics.window.draw-covered", { draw: false }));
    const root = realpathSync(mkdtempSync(join(tmpdir(), "soksak-capture-still-covered-")));
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
    const still = async () => {
      await s.presented();
      return (await readStillCapture(s, t)).image;
    };
    const without = await still();
    await s.run("core.settings.open");
    s.cleanup(() => s.run("core.settings.close"));
    await s.until("core.modal", (modal) => modal?.id === "settings", "the settings modal did not open");
    if ((await s.get("core.modal")).document !== null) {
      await s.until("core.modal", (modal) => modal.document.loaded === true, "the settings document did not load");
    }
    const withModal = await still();
    assert.equal(withModal.width, without.width);
    assert.equal(withModal.height, without.height);
    let read = 0, changed = 0;
    for (let y = 0; y < without.height; y += 4)
      for (let x = 0; x < without.width; x += 4) {
        read += 1;
        if (distance(withModal.pixel(x, y), without.pixel(x, y)) > 6) changed += 1;
      }
    t.diagnostic(`${changed} of ${read} sampled pixels changed with the settings modal open over the covered window`);
    assert.ok(changed / read >= 0.5,
      `the still of the covered window with the settings modal open changed ${changed} of ${read} sampled pixels of the still without it`);
    assert.equal((await s.get("host.window")).occluded, true, "the window is no longer covered at the end");
  });
