// A still capture reads a covered window without a permission prompt, the activation of the application or the real cursor:
// while the window draws covered (`diagnostics.window.draw-covered`), the document of a browser tab stays shown, the still of
// the covered window holds it as the still before the cover does, and a change made while covered is in the next still
// (docs/spec/hosts.md#still-capture, docs/spec/native-surfaces.md#document-regions).
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, realpathSync, rmSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { readPng, distance } from "@soksak/window-check/png.mjs";
import { fresh } from "./fixture.mjs";

const RED = [0xc8, 0x32, 0x32];
const BLUE = [0x32, 0x78, 0xc8];
/** The largest channel difference of two pixels of the same colour, as in e2e/capture-still.test.mjs. */
const TOLERANCE = 3;

/**
 * A loopback server whose documents fill the page with one colour and show their visibility state and the number of their
 * visibility changes as their title. `/red` is static; `/blue` paints itself in an animation frame, which a hidden document
 * does not run. It is closed when the check ends.
 */
async function serve(s) {
  const server = createServer((request, response) => {
    const blue = request.url === "/blue";
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end("<!doctype html><title>visibility</title><style>html,body{margin:0;height:100%;background:#c83232}</style><script>"
      + "let changes = 0; const show = () => { document.title = `visibility:${document.visibilityState}:${changes}`; };"
      + "document.addEventListener('visibilitychange', () => { changes++; show(); }); show();"
      + (blue ? "requestAnimationFrame(() => { document.documentElement.style.background = '#3278c8';"
        + " document.body.style.background = '#3278c8'; });" : "")
      + "</script>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  s.cleanup(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

/**
 * Takes a still of the window and returns the decoded image. The files are removed when the check ends, and each folder after
 * its files: the cleanups run in reverse order of registration.
 */
async function still(s, folders) {
  const { path } = await s.request("diagnostics.capture.still", {});
  if (!folders.has(dirname(path))) {
    folders.add(dirname(path));
    s.cleanup(() => rmdirSync(dirname(path)));
  }
  s.cleanup(() => unlinkSync(path));
  return readPng(path);
}

/** The pixels of the inner part of the rectangle (window content points), 8 points in from each edge, every 8 points. */
function samples(image, scale, rect) {
  const points = [];
  for (let y = rect.y + 8; y < rect.y + rect.height - 8; y += 8)
    for (let x = rect.x + 8; x < rect.x + rect.width - 8; x += 8) {
      const px = Math.floor(x * scale), py = Math.floor(y * scale);
      points.push({ x: px, y: py, rgb: image.pixel(px, py) });
    }
  return points;
}

/** The samples whose colour differs from the colour by more than the tolerance. */
const unlike = (points, rgb) => points.filter((point) => distance(point.rgb, rgb) > TOLERANCE);

for (const app of Object.values(APPS)) {
  test(`${app.name}: a still of a covered window holds the document of its browser tab and its changes`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    await s.request("diagnostics.window.draw-covered", { draw: true });
    s.cleanup(() => s.request("diagnostics.window.draw-covered", { draw: false }));
    const base = await serve(s);
    await s.until("core.surfaces",
      (list) => list.some((x) => x.visible && x.plugin === "browser" && x.exposes.includes("status browser.location")),
      "no visible browser surface registered browser.location");
    const active = new Set((await s.get("core.grid")).cards.map((card) => card.active).filter(Boolean));
    const browser = (await s.get("core.surfaces")).find((x) => x.visible && x.plugin === "browser" && active.has(x.surface));
    assert.ok(browser, "the grid has no active visible browser surface");
    const surface = browser.surface;
    await s.run("browser.navigate", { url: `${base}/red` }, surface);
    await s.until("browser.location", (at) => at.url === `${base}/red` && !at.loading && at.title === "visibility:visible:0",
      "the browser document did not report itself visible", { surface });
    await s.presented();
    const before = await s.get("host.window");
    assert.equal(before.active, false, "the application is active before the still");
    const region = before.documents.find((d) => d.surface === surface && d.document === "page" && d.visible);
    assert.ok(region, `the browser tab has no visible document region: ${JSON.stringify(before.documents)}`);
    const rect = region.frame, scale = before.scale;
    const folders = new Set();

    const uncovered = await still(s, folders);
    assert.equal(uncovered.width, before.content.width * scale);
    const reference = samples(uncovered, scale, rect);
    assert.ok(reference.length > 0, `the document region is too small to sample: ${JSON.stringify(rect)}`);
    assert.deepEqual(unlike(reference, RED), [], "the uncovered still does not hold the document");

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

    // Still B: the covered window holds the document as before the cover.
    await s.presented();
    const covered = await still(s, folders);
    assert.equal(covered.width, uncovered.width);
    assert.equal(covered.height, uncovered.height);
    const kept = samples(covered, scale, rect);
    const moved = kept.filter((point, i) => distance(point.rgb, reference[i].rgb) > TOLERANCE);
    assert.deepEqual(moved, [], "the covered still differs from the uncovered still in the document region");
    assert.equal((await s.get("browser.location", surface)).title, "visibility:visible:0",
      "the document of the covered window was hidden");

    // Still C: a change of the theme and of the document while covered is drawn.
    await s.run("core.settings.theme", { name: "midnight", mode: "dark" });
    await s.run("browser.navigate", { url: `${base}/blue` }, surface);
    await s.until("browser.location", (at) => at.url === `${base}/blue` && !at.loading && at.title === "visibility:visible:0",
      "the browser document of the covered window did not report itself visible", { surface });
    await s.presented();
    const changed = await still(s, folders);
    assert.deepEqual(unlike(samples(changed, scale, rect), BLUE), [],
      "the still of the covered window does not hold the document painted while covered");
    let differ = 0;
    for (let y = 0; y < changed.height; y += 16)
      for (let x = 0; x < changed.width; x += 16) {
        const inside = x >= rect.x * scale && x < (rect.x + rect.width) * scale && y >= rect.y * scale && y < (rect.y + rect.height) * scale;
        if (!inside && distance(changed.pixel(x, y), covered.pixel(x, y)) > TOLERANCE) differ++;
      }
    assert.ok(differ > 0, "the still of the covered window does not show the theme changed while covered");

    const after = await s.get("host.window");
    assert.equal(after.occluded, true, "the window is no longer covered at the end");
    assert.equal(after.active, false, "the application became active");
  });
}
