// Sidebar check: checks the place, folding and width change of an inset sidebar, and that the sections of a set are mounted in the list and tabs layouts.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { readEventLines, currentEventOffsets } from "@soksak/window-check/event-log.mjs";
import { fresh, terminalCardSidebar } from "./fixture.mjs";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { frames, pixel, readFrame } from "@soksak/window-check/frame.mjs";

/** The handle overlaps the sidebar border, so the surface starts right after the sidebar. */
const GRIP = 0;
/** Width (pt) of the boundary line that remains on a folded sidebar. */
const DIVIDER = 6;

for (const app of Object.values(APPS)) {
  test(`${app.name}: an inset sidebar stands inside its card and folds or resizes without changing the card`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    await terminalCardSidebar(s);
    const railed = (grid) => grid.cards.filter((card) => card.id.startsWith("rail-"));
    const grid = await s.until("core.grid", (value) => railed(value).length === 0 && value.cards.some((card) => card.sidebars?.left),
      "no card holds an inset sidebar");
    const card = grid.cards.find((item) => item.sidebars?.left);
    assert.equal(card.sidebars.left.size, 190);
    assert.equal(card.sidebars.left.collapsed, false);
    const sidebarOf = (value) => value.cards.find((item) => item.id === card.id)?.sidebars?.left;
    const surfaceOf = async () => (await s.get("core.surfaces")).find((item) => item.surface === card.active);
    // The surface position is the document coordinate of the board origin plus the card border (1pt).
    const origin = grid.plane.x + card.x + 1;
    const surfaceAt = async (inside) => s.until("core.surfaces", (surfaces) => {
      const surface = surfaces.find((item) => item.surface === card.active);
      return surface && Math.abs(surface.applied.x - (origin + inside)) <= 1;
    }, `the surface did not start ${inside} pt into the card`);
    await surfaceAt(190 + GRIP);
    const before = await surfaceOf();

    await s.run("core.card.sidebar.toggle", { card: card.id, side: "left" });
    const folded = await s.until("core.grid", (value) => sidebarOf(value)?.collapsed === true, "the sidebar did not fold");
    const same = folded.cards.find((item) => item.id === card.id);
    assert.deepEqual([same.x, same.w, same.h], [card.x, card.w, card.h], "folding changed the card");
    await surfaceAt(DIVIDER);

    await s.run("core.card.sidebar.toggle", { card: card.id, side: "left" });
    await s.run("core.card.sidebar.size", { card: card.id, side: "left", size: 260 });
    const resized = await s.until("core.grid", (value) => sidebarOf(value)?.size === 260, "the sidebar did not take the new width");
    const kept = resized.cards.find((item) => item.id === card.id);
    assert.deepEqual([kept.x, kept.w, kept.h], [card.x, card.w, card.h], "resizing the sidebar changed the card");
    await surfaceAt(260 + GRIP);
    await assert.rejects(s.run("core.card.sidebar.size", { card: card.id, side: "left", size: 60 }), /120 to 480/);
    assert.ok(before, "the surface was measured");
    await s.run("core.card.sidebar.size", { card: card.id, side: "left", size: 190 });

    // Dragging the sidebar-side half of the boundary line natively changes the width. A drag is not a press, so it does not fold.
    let divider = await s.rect("core.card.sidebar.grip", 0);
    const y = divider.y + divider.height / 2;
    const x = divider.x + divider.width / 4;
    await s.pointer(x, y, "down");
    await s.pointer(x + 30, y, "drag");
    await s.pointer(x + 60, y, "drag");
    await s.pointer(x + 60, y, "up");
    const dragged = await s.until("core.grid", (value) => Math.abs(sidebarOf(value)?.size - 250) <= 2, "a drag on the divider did not resize");
    assert.equal(sidebarOf(dragged).collapsed, false, "a drag on the divider folded the sidebar");

    // A native press folds immediately. The next display must already show it folded. After folding, only the boundary line remains, and pressing it again unfolds it.
    // core.grid changes before the document draws the new width. The place of the boundary line is read after the layout of the drag is displayed.
    await s.presented();
    divider = await s.rect("core.card.sidebar.grip", 0);
    await s.click(divider.x + divider.width / 4, y);
    await s.presented();
    assert.equal(sidebarOf(await s.get("core.grid")).collapsed, true, "a click on the divider did not fold the sidebar by the next presentation");
    await surfaceAt(DIVIDER);
    divider = await s.rect("core.card.sidebar.grip", 0);
    assert.ok(Math.abs(divider.width - DIVIDER) <= 0.5, `the folded divider is ${divider.width} pt wide`);
    await s.click(divider.x + divider.width / 2, y);
    await s.presented();
    assert.equal(sidebarOf(await s.get("core.grid")).collapsed, false, "a click on the folded divider did not unfold the sidebar by the next presentation");
    await surfaceAt(sidebarOf(dragged).size + GRIP);
  });
}

/** Number of elements of the same kind placed before the sections of the sidebar that uses layout in the sidebar list in document order. */
const indexOf = (sidebars, layout, sidebar, section) => {
  let index = 0;
  for (const item of sidebars.filter((value) => value.layout === layout)) {
    if (item.sidebar === sidebar) return index + item.sections.findIndex((value) => value.id === section);
    index += item.sections.length;
  }
  throw new Error(`no ${layout} sidebar ${sidebar}`);
};

/** Presses the center of the element with native input. */
const press = async (s, name, index) => {
  const rect = await s.rect(name, index);
  assert.ok(rect.width > 0 && rect.height > 0, `${name} ${index} has no area`);
  await s.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
};

for (const app of Object.values(APPS)) {
  test(`${app.name}: a combined set mounts every section in list layout and switches sections in tabs layout`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    await terminalCardSidebar(s);
    const cardSidebar = "terminal:left";
    const of = (sidebars, id) => sidebars.find((item) => item.sidebar === id);
    const mounted = (item, ids) => item && ids.every((id) => item.sections.find((value) => value.id === id)?.mounted);

    // list: the set of the terminal card sidebar mounts both sections.
    let sidebars = await s.until("core.sidebars", (value) => mounted(of(value, cardSidebar), ["files.tree", "files.bookmarks"]),
      "the terminal card sidebar did not mount both sections");
    const listed = of(sidebars, cardSidebar);
    assert.equal(listed.layout, "list");
    assert.deepEqual(listed.sections.map((item) => [item.id, item.folded, item.error]),
      [["files.tree", false, null], ["files.bookmarks", false, null]]);
    const terminalCard = (await s.get("core.grid")).cards.find((card) => card.id === "terminal");
    assert.deepEqual([listed.card, listed.surface], ["terminal", terminalCard.active], "the sections received the focused card and tab");
    // Pressing the header with a native click folds that section.
    await press(s, "core.sidebar.section.header", indexOf(sidebars, "list", cardSidebar, "files.bookmarks"));
    sidebars = await s.until("core.sidebars", (value) => of(value, cardSidebar)?.sections[1].folded === true,
      "a click on the header did not fold the section");
    assert.equal(of(sidebars, cardSidebar).sections[0].folded, false);

    // tabs: changing the same set to tabs mounts only the chosen section.
    const sets = (await s.get("core.settings")).values.sets;
    await s.run("core.settings.set", { patch: { sets: sets.map((set) => set.id === "set-files" ? { ...set, layout: "tabs" } : set) },
      scope: "common" });
    sidebars = await s.until("core.sidebars", (value) => of(value, cardSidebar)?.layout === "tabs" && mounted(of(value, cardSidebar), ["files.tree"]),
      "the tabs layout did not mount the first section");
    assert.equal(of(sidebars, cardSidebar).tab, "files.tree");
    assert.equal(of(sidebars, cardSidebar).sections[1].mounted, false, "a section of an unselected tab is mounted");
    await press(s, "core.sidebar.section.tab", indexOf(sidebars, "tabs", cardSidebar, "files.bookmarks"));
    sidebars = await s.until("core.sidebars", (value) => of(value, cardSidebar)?.tab === "files.bookmarks" && mounted(of(value, cardSidebar), ["files.bookmarks"]),
      "a click on the tab did not show its section");
    assert.equal(of(sidebars, cardSidebar).sections[0].mounted, false, "the previous tab's section stayed mounted");

    await assert.rejects(s.run("core.sidebar.section.fold", { sidebar: cardSidebar, section: "files.bookmarks" }), /does not use the list layout/);
  });
}

/** Index of the at-th operation element that the section of the sidebar draws, among the core.sidebar.section.control in document order. */
const controlIndex = (sidebars, sidebar, section, at) => {
  let index = 0;
  for (const item of sidebars) {
    for (const value of item.sections) {
      if (item.sidebar === sidebar && value.id === section) {
        assert.ok(at < value.controls, `${sidebar} ${section} has ${value.controls} controls`);
        return index + at;
      }
      index += value.controls;
    }
  }
  throw new Error(`no section ${section} in ${sidebar}`);
};

/** Loopback server that serves a document whose title is the path name. It is closed when the check ends. */
async function serveTitles(s) {
  const server = createServer((request, response) => {
    const name = new URL(request.url, "http://127.0.0.1").pathname.slice(1);
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    // inspect has one element and one image request.
    if (name === "untitled") { response.end("<!doctype html><body>untitled"); return; }
    response.end(name === "inspect"
      ? `<!doctype html><title>inspect</title><body><div id="box" class="a b"><img src="/pixel"></div>`
      : `<!doctype html><title>${name}</title><body>${name}`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  s.cleanup(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: the browser sections list the session history and the card's browser tabs`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    s.cleanup(() => s.run("core.settings.reset", { key: "sets" }));
    const base = await serveTitles(s);
    const sidebar = "right";
    const sections = ["browser.tabs", "browser.history"];
    const sets = (await s.get("core.settings")).values.sets;
    await s.run("core.settings.set", { patch: { sets: sets.map((set) => set.id === "set-browser" ? { ...set, sections, layout: "list" } : set) },
      scope: "common" });
    await s.run("core.card.focus", { card: "browser" });
    const of = (sidebars) => sidebars.find((item) => item.sidebar === sidebar);
    const text = (sidebars, id) => of(sidebars)?.sections.find((item) => item.id === id)?.text;
    let sidebars = await s.until("core.sidebars", (value) => of(value)?.set === "set-browser"
      && sections.every((id) => of(value).sections.find((item) => item.id === id)?.mounted),
    "the right sidebar did not mount the browser sections");
    const surface = of(sidebars).surface;
    assert.ok(surface, "the browser sections received the browser tab");

    // History: the two opened documents become entries, and pressing the first entry with a native click opens that document.
    for (const name of ["one", "two"]) {
      await s.run("browser.navigate", { url: `${base}/${name}` }, surface);
      await s.until("browser.location", (at) => at.url === `${base}/${name}` && !at.loading && at.title === name,
        `the browser did not load ${name}`, { surface });
    }
    sidebars = await s.until("core.sidebars", (value) => text(value, "browser.history") === "onetwo",
      "the history section did not list the two documents");
    await press(s, "core.sidebar.section.control", controlIndex(sidebars, sidebar, "browser.history", 0));
    await s.until("browser.location", (at) => at.url === `${base}/one` && !at.loading,
      "a click on the first history entry did not load it", { surface });

    // Tabs: the browser tabs of the card are visible with their titles, and pressing the first tab makes it the active tab.
    const { tab } = await s.run("core.card.add-tab", { card: "browser", plugin: "browser" });
    await s.until("core.grid", (grid) => grid.cards.find((card) => card.id === "browser")?.active === tab,
      "the added browser tab did not become active");
    const tabs = (await s.get("core.grid")).cards.find((card) => card.id === "browser").tabs;
    assert.deepEqual(tabs.map((item) => item.id), [surface, tab]);
    const shown = tabs.map((item) => item.label ?? item.title).join("");
    sidebars = await s.until("core.sidebars", (value) => text(value, "browser.tabs") === shown,
      `the tabs section did not list the card's browser tabs with their titles: ${shown}`);
    await press(s, "core.sidebar.section.control", controlIndex(sidebars, sidebar, "browser.tabs", 0));
    await s.until("core.grid", (grid) => grid.cards.find((card) => card.id === "browser")?.active === surface,
      "a click on the first tab did not select it");
  });
}

/** Relative luminance of an sRGB color. */
const luminance = ([r, g, b]) => {
  const c = (v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b);
};
/** Contrast of two colors. The brighter one is placed on top. */
const contrast = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
/** Contrast between the header line (#2a2d3a) and the header background (#20232d) of the design. */
const DESIGN_RULE_CONTRAST = contrast([0x2a, 0x2d, 0x3a], [0x20, 0x23, 0x2d]);

/** Records the window and measures the contrast between the bottom line pixel of the section header and the background pixel at the header center. */
async function headerRuleContrast(s, rect) {
  const { displayed } = await s.presented();
  await s.request("diagnostics.capture.start", {});
  const result = await s.request("diagnostics.capture.stop", { after: displayed });
  try {
    const files = frames(result.frames);
    assert.ok(files.length > 0, "the header capture produced no frames");
    const frame = readFrame(files.at(-1));
    // Measures near the right end of the header, avoiding the name glyphs.
    const x = Math.round((rect.x + rect.width - 6) * frame.scale);
    const rule = pixel(frame, x, Math.ceil((rect.y + rect.height) * frame.scale) - 1);
    const back = pixel(frame, x, Math.round((rect.y + rect.height / 2) * frame.scale));
    return contrast(rule, back);
  } finally {
    rmSync(result.frames, { recursive: true, force: true });
  }
}

/** Whether two lengths are equal within half a point. */
const near = (a, b) => Math.abs(a - b) <= 0.5;

/** Rectangles of all elements of the name. Stops at an index that does not exist. */
const rects = async (s, name) => {
  const out = [];
  for (;;) {
    try {
      out.push(await s.rect(name, out.length));
    } catch (error) {
      // Stops at the index after the last element. Another error is reported.
      if (!/has no element at index/.test(error.message)) throw error;
      return out;
    }
  }
};

for (const app of Object.values(APPS)) {
  test(`${app.name}: a sidebar starts with its sections and lines up its header and status rules with the neighbouring cards`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    // The right sidebar is shown as the right override of the terminal, which is the focused card.
    await terminalCardSidebar(s);
    await s.run("core.settings.link", { place: "window-right", plugin: "terminal", set: "set-install", scope: "common" });
    const locate = async (sidebar) => {
      const sidebars = await s.until("core.sidebars", (value) => value.find((item) => item.sidebar === sidebar)?.sections.every((item) => item.mounted),
        `sidebar ${sidebar} did not mount its sections`);
      const at = sidebars.findIndex((item) => item.sidebar === sidebar);
      const box = await s.rect("core.sidebar", at);
      const first = await s.rect("core.sidebar.section", sidebars.slice(0, at).reduce((sum, item) => sum + item.sections.length, 0));
      assert.ok(near(first.y, box.y), `${sidebar}: the first section starts ${first.y - box.y} pt below the sidebar top`);
      const header = await s.rect("core.sidebar.section.header", sidebars.slice(0, at).filter((item) => item.layout === "list")
        .reduce((sum, item) => sum + item.sections.length, 0));
      const inside = (rect) => rect.x + rect.width / 2 > box.x && rect.x + rect.width / 2 < box.x + box.width;
      const line = (await rects(s, "core.sidebar.status")).find(inside);
      assert.ok(line, `${sidebar}: no status line`);
      assert.ok(line.y >= box.y + box.height - 0.5, `${sidebar}: the status line is not below the sections`);
      assert.ok(box.height > 100, `${sidebar}: the sections have only ${box.height} pt`);
      return { box, header, line };
    };
    // Neighbor cards: the header of the top card of the board and the footer of the bottom card of the board.
    const cardHeaders = await rects(s, "core.card.header");
    const top = cardHeaders.reduce((a, b) => (b.y < a.y ? b : a));
    const cardFooters = await rects(s, "core.card.status");
    const bottom = cardFooters.reduce((a, b) => (b.y + b.height > a.y + a.height ? b : a));
    // The window sidebar aligns with the header and footer lines of the neighbor cards. The sidebar inside the card is measured below from the card header.
    for (const sidebar of ["left", "right"]) {
      const { header, line } = await locate(sidebar);
      assert.ok(near(header.y + header.height, top.y + top.height),
        `${sidebar}: the first header rule is at ${header.y + header.height}, the card header rule at ${top.y + top.height}`);
      assert.ok(near(line.y, bottom.y), `${sidebar}: the status line rule is at ${line.y}, the card footer rule at ${bottom.y}`);
    }
    // The bottom line of the header differs from the header background by the amount of the design (design: line #2a2d3a above header #20232d).
    const ratio = await headerRuleContrast(s, (await locate("left")).header);
    assert.ok(ratio >= DESIGN_RULE_CONTRAST, `the header rule contrast ${ratio.toFixed(3)} is below the design's ${DESIGN_RULE_CONTRAST.toFixed(3)}`);
    // The sidebar inside the card shares the card header line, so the first section starts right below that header.
    await s.until("core.sidebars", (value) => value.some((item) => item.sidebar === "terminal:left"), "the inset sidebar was not drawn");
    const cardHeader = (await rects(s, "core.card.header")).reduce((a, b) => (b.y < a.y ? b : a));
    const sidebars = await s.until("core.sidebars", (value) => value.find((item) => item.sidebar === "terminal:left")?.sections.every((item) => item.mounted),
      "the inset sidebar did not mount its sections");
    const box = await s.rect("core.sidebar", sidebars.findIndex((item) => item.sidebar === "terminal:left"));
    assert.ok(near(box.y, cardHeader.y + cardHeader.height), `terminal: the inset sections start at ${box.y}, the card header ends at ${cardHeader.y + cardHeader.height}`);
    // The sidebar inside the card ends with its own status line, not the status line of the window sidebar, and that line is placed on the same line as the footer of the card content
    // (docs/spec/example-model.md).
    const inside = (rect) => rect.x + rect.width / 2 > box.x && rect.x + rect.width / 2 < box.x + box.width;
    assert.deepEqual((await rects(s, "core.sidebar.status")).filter(inside), [], "the inset sidebar has a window sidebar status line");
    const own = (await rects(s, "core.card.sidebar.status")).find(inside);
    assert.ok(own && near(box.y + box.height, own.y), `terminal: the inset sections end at ${box.y + box.height}, its status line starts at ${own?.y}`);
    const footer = (await rects(s, "core.card.status")).find((rect) => rect.x >= box.x + box.width - 0.5 && rect.y >= box.y && near(rect.y, own.y));
    assert.ok(footer, `terminal: the inset status line at ${own.y} is not in one row with the content footer`);
  });
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: the browser DOM and network sections list the document's elements and requests`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    s.cleanup(() => s.run("core.settings.reset", { key: "sets" }));
    const base = await serveTitles(s);
    const sidebar = "right";
    const sections = ["browser.dom", "browser.network"];
    const sets = (await s.get("core.settings")).values.sets;
    await s.run("core.settings.set", { patch: { sets: sets.map((set) => set.id === "set-browser" ? { ...set, sections, layout: "list" } : set) },
      scope: "common" });
    await s.run("core.card.focus", { card: "browser" });
    const of = (sidebars) => sidebars.find((item) => item.sidebar === sidebar);
    const text = (sidebars, id) => of(sidebars)?.sections.find((item) => item.id === id)?.text ?? "";
    const sidebars = await s.until("core.sidebars", (value) => of(value)?.set === "set-browser"
      && sections.every((id) => of(value).sections.find((item) => item.id === id)?.mounted),
    "the right sidebar did not mount the DOM and network sections");
    const surface = of(sidebars).surface;
    await s.run("browser.navigate", { url: `${base}/inspect` }, surface);
    const elements = await s.until("browser.elements", (value) => value.nodes.some((node) => node.id === "box"),
      "browser.elements did not report the document's elements", { surface });
    assert.deepEqual(elements.nodes.map((node) => `${node.depth}:${node.tag}`), ["0:html", "1:head", "2:title", "1:body", "2:div", "3:img"]);
    const requests = await s.until("browser.requests", (value) => value.entries.some((entry) => entry.url === `${base}/pixel`),
      "browser.requests did not report the image request", { surface });
    assert.deepEqual(requests.entries.map((entry) => [entry.type, entry.url]), [["navigation", `${base}/inspect`], ["img", `${base}/pixel`]]);
    await s.until("core.sidebars", (value) => text(value, "browser.dom") === "htmlheadtitlebodydiv#box.a.bimg"
      && text(value, "browser.network").startsWith(`navigation ${base}/inspect `) && text(value, "browser.network").includes(`img ${base}/pixel `),
    "the DOM and network sections did not show the elements and requests");
  });
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: a browser tab and the tabs section show the document title or the address`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    s.cleanup(() => s.run("core.settings.reset", { key: "sets" }));
    const base = await serveTitles(s);
    const sets = (await s.get("core.settings")).values.sets;
    await s.run("core.settings.set", { patch: { sets: sets.map((set) => set.id === "set-browser"
      ? { ...set, sections: ["browser.tabs"], layout: "list" } : set) }, scope: "common" });
    await s.run("core.card.focus", { card: "browser" });
    const of = (sidebars) => sidebars.find((item) => item.sidebar === "right");
    const sidebars = await s.until("core.sidebars", (value) => of(value)?.sections.find((item) => item.id === "browser.tabs")?.mounted,
      "the right sidebar did not mount the tabs section");
    const surface = of(sidebars).surface;
    const label = (grid) => grid.cards.flatMap((card) => card.tabs).find((tab) => tab.id === surface)?.label;
    const section = (value) => of(value)?.sections.find((item) => item.id === "browser.tabs")?.text;

    await s.run("browser.navigate", { url: `${base}/titled` }, surface);
    await s.until("core.grid", (grid) => label(grid) === "titled", "the tab did not show the document title");
    await s.until("core.sidebars", (value) => section(value) === "titled", "the tabs section did not show the document title");
    await s.run("browser.navigate", { url: `${base}/untitled` }, surface);
    await s.until("core.grid", (grid) => label(grid) === `${base}/untitled`, "the tab did not show the address of an untitled document");
    await s.until("core.sidebars", (value) => section(value) === `${base}/untitled`, "the tabs section did not show the address");
  });
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: tabs-layout tabs keep their full names on one line at the strip height`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    await terminalCardSidebar(s);
    const sets = (await s.get("core.settings")).values.sets;
    await s.run("core.settings.set", { patch: { sets: sets.map((set) => set.id === "set-files" ? { ...set, layout: "tabs" } : set) },
      scope: "common" });
    const check = async (sidebar) => {
      const sidebars = await s.until("core.sidebars", (value) => value.find((item) => item.sidebar === sidebar)?.layout === "tabs",
        `sidebar ${sidebar} did not draw tabs`);
      const tabbed = sidebars.filter((item) => item.layout === "tabs");
      const at = tabbed.findIndex((item) => item.sidebar === sidebar);
      const item = tabbed[at];
      assert.deepEqual(item.sections.filter((section) => section.clipped).map((section) => section.id), [],
        `${sidebar}: tabs clip their names`);
      const strip = await s.rect("core.sidebar.tabs", at);
      const first = tabbed.slice(0, at).reduce((sum, value) => sum + value.sections.length, 0);
      for (let index = 0; index < item.sections.length; index += 1) {
        const tab = await s.rect("core.sidebar.section.tab", first + index);
        assert.ok(near(tab.height, strip.height), `${sidebar}: tab ${item.sections[index].id} is ${tab.height} pt high in a ${strip.height} pt strip`);
      }
    };
    await check("terminal:left");
    // When the browser card is focused, the right sidebar shows the browser set of the tabs layout.
    await s.run("core.card.focus", { card: "browser" });
    await check("right");
  });
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: a section header's name stays in place when sections fold and sits alike in every header`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    // The left set (file tree, bookmarks) is the first list sidebar in the document.
    const sidebars = await s.until("core.sidebars", (value) => value[0]?.sidebar === "left" && value[0].layout === "list"
      && value[0].sections.length >= 2, "the left sidebar did not draw two list sections");
    const [one, two] = sidebars[0].sections;
    const place = async (index) => {
      const header = await s.rect("core.sidebar.section.header", index);
      const name = await s.rect("core.sidebar.section.name", index);
      return { header, name, offset: [name.x - header.x, name.y - header.y, name.height] };
    };
    const first = await place(0);
    const second = await place(1);
    assert.deepEqual(second.offset, first.offset, "the second header places its name differently from the first");
    for (const [index, section] of [[0, one], [1, two]]) {
      const open = await place(index);
      await s.run("core.sidebar.section.fold", { sidebar: "left", section: section.id });
      await s.until("core.sidebars", (value) => value[0].sections[index].folded === true, `${section.id} did not fold`);
      const folded = await place(index);
      // When a fill section receives the space, the header can move, so the name positions inside the headers are compared.
      assert.deepEqual(folded.offset, open.offset, `${section.id}: the name moved inside its header when the section folded`);
      await s.run("core.sidebar.section.fold", { sidebar: "left", section: section.id });
      await s.until("core.sidebars", (value) => value[0].sections[index].folded === false, `${section.id} did not unfold`);
      assert.deepEqual((await place(index)).offset, open.offset, `${section.id}: the name moved inside its header when the section unfolded`);
    }
  });
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: a fill section takes the sidebar height the other sections leave and gives it up when folded`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    // The left set is the file tree (fill) and the bookmarks (content height). The left sidebar is the first sidebar in the document.
    const ready = (value) => value[0]?.sidebar === "left" && value[0].sections.every((item) => item.mounted);
    await s.until("core.sidebars", ready, "the left sidebar did not mount its sections");
    const measure = async () => {
      const box = await s.rect("core.sidebar", 0);
      const [tree, marks] = [await s.rect("core.sidebar.section", 0), await s.rect("core.sidebar.section", 1)];
      const [treeHead, marksHead] = [await s.rect("core.sidebar.section.header", 0), await s.rect("core.sidebar.section.header", 1)];
      return { box, tree, marks, treeHead, marksHead };
    };
    const open1 = await measure();
    // The height of the tree body is the height that the sidebar leaves after the bookmarks and the tree header.
    const room = open1.box.height - open1.marks.height - open1.treeHead.height;
    const body = open1.tree.height - open1.treeHead.height;
    assert.ok(Math.abs(body - room) <= 1, `the tree body is ${body} pt, the room is ${room} pt`);
    assert.ok(open1.marks.height < open1.box.height / 3, `the bookmarks section stretched to ${open1.marks.height} pt`);

    // Folding the bookmarks gives their space to the tree.
    await s.run("core.sidebar.section.fold", { sidebar: "left", section: "files.bookmarks" });
    await s.until("core.sidebars", (value) => value[0].sections[1].folded === true, "the bookmarks did not fold");
    const marksFolded = await measure();
    assert.ok(Math.abs(marksFolded.tree.height - (marksFolded.box.height - marksFolded.marksHead.height)) <= 1,
      `the tree is ${marksFolded.tree.height} pt after the bookmarks folded in a ${marksFolded.box.height} pt sidebar`);
    await s.run("core.sidebar.section.fold", { sidebar: "left", section: "files.bookmarks" });
    await s.until("core.sidebars", (value) => value[0].sections[1].folded === false, "the bookmarks did not unfold");

    // Folding the tree leaves only the header, and the bookmarks of content height do not grow.
    await s.run("core.sidebar.section.fold", { sidebar: "left", section: "files.tree" });
    await s.until("core.sidebars", (value) => value[0].sections[0].folded === true, "the tree did not fold");
    const treeFolded = await measure();
    assert.ok(Math.abs(treeFolded.tree.height - treeFolded.treeHead.height) <= 0.5, "a folded tree kept more than its header");
    assert.ok(Math.abs(treeFolded.marks.height - open1.marks.height) <= 0.5,
      `the bookmarks changed from ${open1.marks.height} to ${treeFolded.marks.height} pt when the tree folded`);
    await s.run("core.sidebar.section.fold", { sidebar: "left", section: "files.tree" });
  });
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: sections that follow a core status mount without an error after a reload`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    s.cleanup(() => s.run("core.settings.reset", { key: "sets" }));
    const sidebar = "right";
    const sets = (await s.get("core.settings")).values.sets;
    await s.run("core.settings.set", { patch: { sets: sets.map((set) => set.id === "set-browser" ? { ...set, sections: ["browser.tabs"], layout: "list" } : set) },
      scope: "common" });
    await s.run("core.card.focus", { card: "browser" });
    const mounted = (value) => value.find((item) => item.sidebar === sidebar)?.sections.find((item) => item.id === "browser.tabs")?.mounted;
    await s.until("core.sidebars", mounted, "the right sidebar did not mount browser.tabs");
    const offsets = currentEventOffsets(s.app.configDir);
    // Sections are mounted asynchronously after the first screen. The core state that they follow must already be registered at that time (docs/spec/plugins.md#sections).
    await s.run("host.window.reload");
    await s.until("core.sidebars", mounted, "the right sidebar did not mount browser.tabs after the reload");
    await s.presented();
    await s.flushLog();
    const errors = readEventLines(s.app.configDir, offsets).lines.filter((line) => line.includes("is not registered"));
    assert.deepEqual(errors, [], "the event log recorded errors while the reloaded page mounted its sections");
  });
}

for (const app of Object.values(APPS)) {
  // The window sidebar is turned off by the fold control at the end of the bottom line and turned on again by the button of the window header (docs/spec/plugins.md#sections).
  test(`${app.name}: the fold control at the bottom of a window sidebar turns it off and the header turns it on`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const { left } = (await s.get("core.settings")).values;
    s.cleanup(() => s.run("core.settings.set", { patch: { left }, scope: "common" }));
    await s.run("core.settings.set", { patch: { left: true }, scope: "common" });
    await s.until("core.sidebars", (value) => value.some((item) => item.sidebar === "left"), "the left window sidebar is not shown");
    const listed = (await s.request("exposure.list")).dom.find((entry) => entry.name === "core.sidebar.fold");
    assert.ok(listed?.registered, `the window sidebar fold control is not declared and registered: ${JSON.stringify(listed)}`);
    await s.presented();
    const fold = await s.rect("core.sidebar.fold", 0);
    const status = await s.rect("core.sidebar.status", 0);
    assert.ok(fold.y >= status.y - 0.5 && fold.y + fold.height <= status.y + status.height + 0.5 && fold.x + fold.width <= status.x + status.width + 0.5,
      `the fold control is not in the status line: ${JSON.stringify({ fold, status })}`);
    await s.click(fold.x + fold.width / 2, fold.y + fold.height / 2);
    await s.until("core.settings", (value) => value.values.left === false && !value.saving, "the fold control did not turn the left sidebar off");
    await s.until("core.sidebars", (value) => !value.some((item) => item.sidebar === "left"), "the left window sidebar stayed");
    const header = await s.rect("core.chrome.left", 0);
    await s.click(header.x + header.width / 2, header.y + header.height / 2);
    await s.until("core.sidebars", (value) => value.some((item) => item.sidebar === "left"), "the header control did not turn the left sidebar on");
  });
}
