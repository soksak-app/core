// Compares the final requests and the display coordinates of the two hosts.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

import { APPS, drag, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";
import { textDifference } from "@soksak/window-check/text-difference.mjs";

const PLAN = { axis: "x", line: 2, dx: -120, dy: 0, ms: 48, times: 2 };

const LINE = /^host (\w+) (\{.*\}|\[.*\]|null) -> (.*)$/;

/** Arranges the transcript lines into a list of requests and replies per call name. The id that differs per window is replaced by the order name. */
function transcript(lines) {
  const names = new Map();
  const same = (text) =>
    text.replace(/"ticket":\d+,/g, "").replace(/(prj|spc|tab)-[a-z0-9]+/g, (id, kind) => {
      if (!names.has(id)) names.set(id, `${kind}-${names.size}`);
      return names.get(id);
    });
  const calls = new Map();
  for (const line of lines) {
    const found = LINE.exec(line);
    if (!found) continue;
    const [, name, request, answer] = found;
    if (!calls.has(name)) calls.set(name, []);
    calls.get(name).push({ request: same(request), answer: same(answer) });
  }
  return calls;
}

const atRest = (calls) => {
  const prepared = [...(calls.get("syncSurfaces") ?? [])].reverse().find((c) => /"settled":true/.test(c.request));
  const presented = [...(calls.get("presentSurfaces") ?? [])].reverse().find((c) => /"settled":true/.test(c.request));
  return prepared && presented && { request: prepared.request, answer: presented.answer };
};

const SIZE = { width: 1000, height: 620 };

/** The x of the first surface for each layout request that the transcript settled. */
const settledX = (lines) => (transcript(lines).get("syncSurfaces") ?? [])
  .filter((call) => /"settled":true/.test(call.request)).map((call) => JSON.parse(call.request).surfaces[0]?.x);

/** Every surface frame that is visible and settled in the last layout request. */
const settledFrames = (lines) => {
  const call = [...(transcript(lines).get("syncSurfaces") ?? [])].reverse()
    .find((entry) => /"settled":true/.test(entry.request));
  return call && JSON.parse(call.request).surfaces.filter((surface) => surface.visible)
    .map(({ x, y, w, h }) => ({ x, y, width: w, height: h }));
};

/** The line that says the page displayed the settled layout. */
const settled = (lines) => lines.some((line) => /^host presentSurfaces .*"settled":true.* ->/.test(line));

/** Records the content size and the layout input when the host results are compared. */
async function layoutState(s) {
  const [window, document, settings] = await Promise.all([
    s.get("host.window"), s.get("core.window.document"), s.get("core.settings"),
  ]);
  const values = settings.values;
  return {
    window: {
      frame: window.frame, content: window.content, scale: window.scale,
      maximized: window.maximized, active: window.active, occluded: window.occluded,
      surfaces: window.surfaces.map(({ id, frame, visible, order }) => ({ id, frame, visible, order })),
    },
    document,
    settings: Object.fromEntries([
      "left", "right", "sidebarMinWidth", "sidebarMaxWidth", "sidebarWidth", "sets", "links",
    ].map((key) => [key, values[key]])),
    project: settings.project,
    overridden: settings.overridden,
  };
}

/** Connects to both applications. It is null when one of them is not built. */
async function both(t) {
  const sessions = {};
  for (const app of Object.values(APPS)) {
    const s = await open(t, app);
    if (!s) return null;
    sessions[app.name] = s;
  }
  return sessions;
}

test("both hosts answer the same page the same way", async (t) => {
  const sessions = await both(t);
  if (!sessions) return t.skip("both hosts must be built");
  const dragged = {};
  const results = {};
  const logs = {};
  const states = {};
  for (const [name, s] of Object.entries(sessions)) {
    await fresh(s);
    states[name] = { fresh: await layoutState(s) };
    // The settled layout of the drag is taken by stopping the recording before the settings modal opens. The modal is an overlay of the whole window and changes the next layout,
    // and the moment at which that layout enters the recording differs per host.
    const start = (await s.get("host.window")).surfaces.find((item) => item.frame.width > 0)?.frame.x;
    const expectedFrames = states[name].fresh.window.surfaces.filter((item) => item.visible).map((item) => item.frame);
    const dragLog = await s.transcript();
    results[name] = await drag(t, s, PLAN);
    // A settled layout also occurs at a moment where the drag is stopped. The drag returns to its place, so the check waits until the last settled layout equals the layout
    // before the drag.
    try {
      await dragLog.until((lines) => {
        const actualFrames = settledFrames(lines);
        const lastSync = lines.findLastIndex((line) => /^host syncSurfaces .*"settled":true/.test(line));
        const lastPresent = lines.findLastIndex((line) => /^host presentSurfaces .*"settled":true.* ->/.test(line));
        return actualFrames?.length === expectedFrames.length && actualFrames.every((frame, index) =>
          ["x", "y", "width", "height"].every((key) => Math.abs(frame[key] - expectedFrames[index][key]) < 0.5)) &&
          lastPresent > lastSync;
      }, "the drag did not end with a settled commit at its starting surface frames");
    } catch (error) {
      const now = await s.get("host.window");
      const grid = await s.get("core.grid");
      error.message += `\nstart x ${start}; drag result boundary ${JSON.stringify(results[name].boundary)}, steps ` +
        `${results[name].steps}, took ${results[name].took}; surfaces now ` +
        `${JSON.stringify(now.surfaces.map((item) => [item.frame.x, item.frame.width]))}; grid ${JSON.stringify(grid).slice(0, 600)}`;
      throw error;
    }
    dragged[name] = await dragLog.stop();
    states[name].afterDrag = await layoutState(s);
    const log = await s.transcript();
    await s.run("core.settings.open");
    const { controls } = await s.until("core.settings-modal", (modal) => modal.open, "settings did not open");
    assert.ok(controls.some((c) => c.key === "nav:sidebars"), "settings must have a sidebars section");
    await s.run("core.settings-modal.nav", { section: "sidebars" });
    await log.until((lines) => lines.some((line) => line.startsWith("host overlayPlace")), "settings were not placed");
    logs[name] = await log.stop();
    await s.run("core.settings.close");
  }

  const restedWails = atRest(transcript(dragged.wailsv3));
  const restedTauri = atRest(transcript(dragged.tauriv2));
  assert.ok(restedWails, `the Wails host recorded no settled commit:\n${dragged.wailsv3.join("\n")}`);
  assert.ok(restedTauri, `the Tauri host recorded no settled commit:\n${dragged.tauriv2.join("\n")}`);
  // On failure, it writes the order of the x of the first surface of the settled layouts of each host and the boundary of the drag result.
  const boundary = (result) => result.boundary && [result.boundary[0], result.boundary.at(-1)];
  const dragState = Object.fromEntries(Object.entries(results).map(([name, result]) => [name, {
    from: result.from, steps: result.steps, took: result.took, asked: result.asked,
    late: result.late, deepest: result.deepest, boundary: boundary(result),
  }]));
  const stateReport = `window, document, and layout settings by host: ${JSON.stringify(states)}`;
  assert.equal(restedTauri.request, restedWails.request, "the two hosts give the page a different plane to lay out " +
    `after the drag:\nWails ${restedWails.request}\nTauri ${restedTauri.request}\n` +
    `settled first-surface x: Wails ${JSON.stringify(settledX(dragged.wailsv3))}, Tauri ${JSON.stringify(settledX(dragged.tauriv2))}; ` +
    `drag measurements: ${JSON.stringify(dragState)}; ` +
    stateReport);
  assert.equal(restedTauri.answer, restedWails.answer,
    `the two hosts place the same surfaces differently; ${stateReport}`);
  const wails = transcript([...dragged.wailsv3, ...logs.wailsv3]);
  const tauri = transcript([...dragged.tauriv2, ...logs.tauriv2]);
  const onlyWails = [...wails.keys()].filter((name) => !tauri.has(name));
  const onlyTauri = [...tauri.keys()].filter((name) => !wails.has(name));
  assert.deepEqual({ onlyWails, onlyTauri }, { onlyWails: [], onlyTauri: [] },
    "the two hosts were asked for different things");
  for (const name of wails.keys()) {
    if (name === "syncSurfaces" || name === "presentSurfaces") continue;
    const mine = wails.get(name).at(-1);
    const theirs = tauri.get(name).at(-1);
    // To classify an intermittent difference, the failure message holds all requests and replies of both hosts.
    const answers = `\nWails ${mine.request} -> ${mine.answer}\nTauri ${theirs.request} -> ${theirs.answer}`;
    // A long request is cut in the message, so the message first names the place where the requests first differ (F40).
    assert.equal(theirs.request, mine.request,
      `${name} was asked differently, Tauri ${textDifference(theirs.request, mine.request)} of Wails; ${stateReport}:${answers}`);
    assert.equal(theirs.answer, mine.answer,
      `${name} was answered differently, Tauri ${textDifference(theirs.answer, mine.answer)} of Wails:${answers}`);
  }
});

test("both hosts lay out the same page the same way after a resize", async (t) => {
  const sessions = await both(t);
  if (!sessions) return t.skip("both hosts must be built");
  const rested = {};
  for (const [name, s] of Object.entries(sessions)) {
    await fresh(s);
    const log = await s.transcript();
    await s.run("host.window.resize", SIZE);
    await s.until("host.window", (w) => w.content.width === SIZE.width && w.content.height === SIZE.height,
      "the window did not resize");
    await s.until("core.window.document", (doc) => doc.width === SIZE.width && doc.height === SIZE.height,
      "the main document did not take the new size");
    const lines = await log.until(settled, "the resize did not end with a settled commit").then(() => log.stop());
    const found = atRest(transcript(lines));
    assert.ok(found, `${name} recorded no settled commit after the resize:\n${lines.join("\n")}`);
    rested[name] = found;
  }
  assert.equal(rested.tauriv2.request, rested.wailsv3.request,
    `the two hosts give the page a different plane at ${SIZE.width}x${SIZE.height}`);
  assert.equal(rested.tauriv2.answer, rested.wailsv3.answer,
    `the two hosts place the same surfaces differently at ${SIZE.width}x${SIZE.height}`);
});

/** The menu table of the host contract specification. The declaration is the reference, so the check reads it from the specification file. */
async function menuContract() {
  const { specMenuTables } = await import("../scripts/check-host-parity.mjs");
  return specMenuTables(readFileSync(new URL("../docs/spec/host-contract.md", import.meta.url), "utf8"));
}

/** The number of item titles that the builder creates (title) in the View menu of the contract table. The system row waits for more items than this. */
function declaredViewTitles(contract) {
  return contract.items.filter(([menu, , source]) => menu === "view" && source === "title");
}

/** Normalizes the values of the observed menu that differ per host (the application name, the window list, the tail that the system adds).
    It compares only as many rows as the contract table has. The items after them (automatic completion, dictation, emoji substitution key and others) are added by macOS
    in different ways per framework configuration, so no host owns them. */
function normalizeMenus(menus, names, windowTitles, declaredCounts) {
  // Names are replaced from the longest, because a shorter name is the beginning of a longer one.
  const neutralize = (text) => [...names].sort((a, b) => b.length - a.length)
    .reduce((value, name) => value.replaceAll(name, "APP"), text);
  return menus.map((menu, index) => ({
    title: neutralize(menu.title),
    items: menu.items
      .filter((item) => !windowTitles.includes(item.title))
      .slice(0, declaredCounts?.[index] ?? menu.items.length)
      .map((item) => ({ title: neutralize(item.title), key: item.key })),
  }));
}

test("both hosts serve the declared application menu", async (t) => {
  const sessions = await both(t);
  if (!sessions) return t.skip("both hosts must be built");
  const contract = await menuContract();
  // The active language that the host reports is the reference. The check does not guess it from the title (docs/spec/host-contract.md).
  // The reported language must be a language column of the table, and a new language is declared by adding a column.
  const columns = contract.languages;
  // The number of items to compare in each top-level menu is the number of rows of the contract table (the system tail is excluded).
  const declaredCounts = contract.menus.map(([id]) => contract.items.filter(([menu]) => menu === id).length);
  const observed = {};
  for (const [name, s] of Object.entries(sessions)) {
    // The host now creates the full screen item (V5-112), so the menu bar automation that waited for the delayed insertion by the system is dropped,
    // and the check waits structurally until the declared number of items is filled.
    const settled = await s.until("host.menu", (value) => {
      const view = value?.menus?.find((menu) => menu.title === "보기" || menu.title === "View");
      return view && view.items.length >= declaredCounts[contract.menus.findIndex(([id]) => id === "view")]
        && view.items[view.items.length - 1].title.length > 0;
    }, "the declared View menu items did not all arrive", { timeout: 5000 });
    const report = settled;
    assert.ok(typeof report?.language === "string" && columns.includes(report.language),
      `host.menu must report a declared language: ${JSON.stringify(report).slice(0, 200)}`);
    // The application name appears with different lengths in a menu title and an item title (for example soksak and
    // soksak-tauriv2). Both are application names, so both are removed.
    const names = [...new Set([report.menus[0].title, `soksak-${name}`])];
    const titles = (await s.get("host.windows")).map((entry) => entry.title);
    observed[name] = { language: report.language, menus: normalizeMenus(report.menus, names, titles, declaredCounts) };
  }
  const languages = Object.values(observed).map((value) => value.language);
  assert.equal(new Set(languages).size, 1, `both hosts must serve the same menu language: ${JSON.stringify(languages)}`);
  const column = columns.indexOf(languages[0]) + 1;

  // The observed menus follow the order and the titles of the declared top-level menus. The title of the app menu is the normalized application name.
  const [first, ...rest] = Object.values(observed).map((value) => value.menus);
  for (const menus of [first, ...rest]) {
    assert.equal(menus.length, contract.menus.length, `menu count differs: ${JSON.stringify(menus.map((m) => m.title))}`);
    contract.menus.forEach((row, index) => {
      const expected = row[column];
      assert.equal(menus[index].title, row[0] === "app" ? "APP" : expected,
        `menu ${row[0]} title differs: ${JSON.stringify(menus[index])}`);
    });
  }

  // The first items of each menu equal the declared table. A title item must equal the title and the key, and a system item
  // needs to equal only the position and the existence (the framework sets the title by language). The items after the table are
  // added by the system, so the check confirms only equality between the hosts.
  const declared = Object.fromEntries(contract.menus.map(([id]) => [id, []]));
  // The about, hide and quit titles of the app menu start with the application name (the observation normalization replaces the application name with APP,
  // so the expectation takes the same form).
  const appPrefixed = new Set(["about", "hide", "quit"]);
  for (const row of contract.items) {
    declared[row[0]].push({
      id: row[1], source: row[2], key: row.at(-1),
      title: row[0] === "app" && appPrefixed.has(row[1]) ? `APP ${row[column + 2]}` : row[column + 2],
    });
  }
  for (const menus of [first, ...rest]) {
    contract.menus.forEach(([id], index) => {
      declared[id].forEach((item, offset) => {
        const actual = menus[index].items[offset];
        assert.ok(actual, `menu ${id} item ${item.id} is missing: ${JSON.stringify(menus[index])}`);
        if (item.source === "title") {
          assert.deepEqual(actual, { title: item.title, key: item.key },
            `menu ${id} item ${item.id} differs from the table: ${JSON.stringify(actual)}`);
        } else {
          assert.ok(actual.title.length > 0, `menu ${id} system item ${item.id} is empty`);
        }
      });
    });
  }
  // The title and the shortcut of a system item are set by the framework, so the comparison between hosts
  // replaces them with a placeholder (the table comparison above already checks position and existence).
  const markSystemItems = (menus) => menus.map((menu, index) => {
    const rows = contract.items.filter(([rowMenu]) => rowMenu === contract.menus[index][0]);
    return {
      title: menu.title,
      items: menu.items.map((item, offset) => rows[offset]?.[2] === "system" ? { title: "system", key: "" } : item),
    };
  });
  assert.deepEqual(markSystemItems(first), markSystemItems(rest[0]),
    "the two hosts must serve the same application menu");

  // The layout and the native surfaces do not follow the web view zoom, and a reload changes the state of the main page.
  const forbidden = Object.values(observed).flatMap(({ menus }) => menus.flatMap((menu) => menu.items))
    .filter((item) => /zoom in|zoom out|actual size|reload/i.test(item.title));
  assert.deepEqual(forbidden, [], "no menu item zooms or reloads the whole webview");
});
