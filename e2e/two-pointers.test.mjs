// Two named pointers press and drag at once, on two pages of one window and in two windows, and each page sees the buttons of
// its own gesture. A move of one pointer in a window in which the other pointer holds a press is refused with the holder and
// the reason named, because a window has one hover position (docs/spec/exposure.md#named-pointers).
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";

// The document counts its presses, the moves made with the primary button held, its releases, and the events whose buttons
// are not those of its own gesture, and shows them as its title `pointer:<downs>:<drags>:<ups>:<foreign>`.
const PAGE = "<!doctype html><title>pointer:0:0:0:0</title><style>html,body{margin:0;height:100%}</style><script>"
  + "let downs = 0, drags = 0, ups = 0, foreign = 0, pressed = false;"
  + "const show = () => { document.title = `pointer:${downs}:${drags}:${ups}:${foreign}`; };"
  + "addEventListener('pointerdown', (e) => { downs++; pressed = true; if (e.buttons !== 1) foreign++; show(); });"
  + "addEventListener('pointermove', (e) => { if (pressed && e.buttons === 1) drags++;"
  + " else if (e.buttons !== (pressed ? 1 : 0)) foreign++; show(); });"
  + "addEventListener('pointerup', (e) => { ups++; pressed = false; if (e.buttons !== 0) foreign++; show(); });"
  + "</script>";

/** A loopback server that answers every path with the page. It is closed when the check ends. */
async function serve(s) {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(PAGE);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  s.cleanup(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

/** Opens the page in the browser surface and returns the centre of its document region in window coordinates. */
async function page(s, surface, url) {
  await s.until("core.surfaces", (list) => list.some((item) => item.surface === surface && item.visible
    && item.exposes.includes("status browser.location") && item.exposes.includes("element browser.document")),
  `the browser surface ${surface} did not register its location and document`);
  await s.run("browser.navigate", { url }, surface);
  await s.until("browser.location", (at) => at.url === url && !at.loading && at.error === null && at.title === "pointer:0:0:0:0",
    `the browser surface ${surface} did not load ${url}`, { surface });
  await s.presented();
  const rect = await s.rect("browser.document", undefined, surface);
  const center = { x: rect.document.x + rect.x + rect.width / 2, y: rect.document.y + rect.y + rect.height / 2 };
  await s.until("host.window", (w) => w.documents.some((d) => d.surface === surface && d.document === "page" && d.visible),
    `the document region of ${surface} is not visible`);
  return center;
}

/** Waits until the page of the surface shows the counts of its gesture. */
function counted(s, surface, [downs, drags, ups], what) {
  const title = `pointer:${downs}:${drags}:${ups}:0`;
  return s.until("browser.location", (at) => at.title === title, `${what}: the page did not show ${title}`, { surface });
}

/** Presses with each pointer, drags each twice in turn and releases each, waiting for each page to count each step. */
async function gesture(first, second) {
  await first.s.pointer(first.at.x, first.at.y, "down", { pointer: first.name });
  await counted(first.s, first.surface, [1, 0, 0], `the press of pointer ${first.name}`);
  await second.s.pointer(second.at.x, second.at.y, "down", { pointer: second.name });
  await counted(second.s, second.surface, [1, 0, 0], `the press of pointer ${second.name}`);
  for (const step of [1, 2]) {
    for (const { s, surface, at, name, sign } of [first, second]) {
      await s.pointer(at.x + sign * 12 * step, at.y + 6 * step, "drag", { pointer: name });
      await counted(s, surface, [1, step, 0], `drag ${step} of pointer ${name}`);
    }
  }
  for (const { s, surface, at, name, sign } of [first, second]) {
    await s.pointer(at.x + sign * 24, at.y + 12, "up", { pointer: name });
    await counted(s, surface, [1, 2, 1], `the release of pointer ${name}`);
  }
}

/** The surface of the active visible browser tab of the window. */
async function activeBrowser(s) {
  await s.until("core.surfaces",
    (list) => list.some((x) => x.visible && x.plugin === "browser" && x.exposes.includes("status browser.location")),
    "no visible browser surface registered browser.location");
  const active = new Set((await s.get("core.grid")).cards.map((card) => card.active).filter(Boolean));
  const browser = (await s.get("core.surfaces")).find((x) => x.visible && x.plugin === "browser" && active.has(x.surface));
  assert.ok(browser, "the grid has no active visible browser surface");
  return browser.surface;
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: two pointers press and drag at once on two pages of one window`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    const base = await serve(s);
    const left = await activeBrowser(s);
    const card = (await s.get("core.grid")).cards.find((item) => item.tabs.some((tab) => tab.id === left));
    const { tab: right } = await s.run("core.card.split", { card: card.id, side: "right", plugin: "browser" });
    const leftAt = await page(s, left, `${base}/left`);
    const rightAt = await page(s, right, `${base}/right`);
    await s.pointer(leftAt.x, leftAt.y, "move", { pointer: "first" });
    await s.until("host.window", (w) => w.virtualKey, "the window did not become the virtual key window");
    const first = { s, surface: left, at: leftAt, name: "first", sign: 1 };
    const second = { s, surface: right, at: rightAt, name: "second", sign: -1 };
    await first.s.pointer(leftAt.x, leftAt.y, "down", { pointer: "first" });
    await counted(s, left, [1, 0, 0], "the press of pointer first");
    await assert.rejects(s.pointer(rightAt.x, rightAt.y, "move", { pointer: "second" }), (error) => {
      assert.equal(error.code, 1011, error.message);
      assert.match(error.message, /pointer first holds a press that this input would share: the window has one hover position/);
      return true;
    });
    await s.pointer(leftAt.x, leftAt.y, "up", { pointer: "first" });
    await counted(s, left, [1, 0, 1], "the release of pointer first");
    await s.run("browser.navigate", { url: `${base}/left-again` }, left);
    await s.until("browser.location", (at) => at.url === `${base}/left-again` && !at.loading && at.title === "pointer:0:0:0:0",
      "the left page did not load again", { surface: left });
    await gesture(first, second);
    const window = await s.get("host.window");
    assert.equal(window.active, false, "the application became active");
  });

  test(`${app.name}: two pointers press and drag at once in two windows`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    const base = await serve(s);
    const here = await activeBrowser(s);
    const hereAt = await page(s, here, `${base}/here`);

    const root = realpathSync(mkdtempSync(join(tmpdir(), "soksak-two-pointers-")));
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
    const other = s.on(windows.find((w) => w.window !== s.window).window);
    const grid = await other.until("core.grid", (value) => value?.cards?.some((card) =>
      card.tabs.some((tab) => tab.plugin === "terminal")), "the project window did not create its terminal tab card");
    const card = grid.cards.find((item) => item.tabs.some((tab) => tab.plugin === "terminal"));
    const { tab: there } = await other.run("core.card.add-tab", { card: card.id, plugin: "browser" });
    const thereAt = await page(other, there, `${base}/there`);

    await s.pointer(hereAt.x, hereAt.y, "move", { pointer: "first" });
    await s.until("host.window", (w) => w.virtualKey, "the first window did not become the virtual key window");
    await gesture({ s, surface: here, at: hereAt, name: "first", sign: 1 },
      { s: other, surface: there, at: thereAt, name: "second", sign: -1 });
    for (const session of [s, other]) {
      assert.equal((await session.get("host.window")).active, false, "the application became active");
    }
  });
}
