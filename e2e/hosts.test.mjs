// Compares the final requests and the display coordinates of the hosts of the session: each host with the first one.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

import { APPS, MAIN_PAGE_APPS, drag, open, requiresAll } from "@soksak/window-check/app.mjs";
import { fresh, recordCatalog, settingsShown } from "./fixture.mjs";
import { publicHostState, comparePublicHostStates } from "./host-public-parity.mjs";
import { atRest, byPosition, settled, settledFrames, settledX, transcript } from "./host-transcript.mjs";
import { orderNames } from "@soksak/window-check/order-names.mjs";
import { textDifference } from "@soksak/window-check/text-difference.mjs";

const PLAN = { axis: "x", line: 2, dx: -120, dy: 0, ms: 48, times: 2 };

const SIZE = { width: 1000, height: 620 };

/** Records the content size and the layout input when the host results are compared. */
async function layoutState(s) {
  const [window, document, settings] = await Promise.all([
    s.get("host.window"), s.get("core.window.workbench"), s.get("core.settings"),
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

/**
 * Connects to every application of the session. The tests below are registered only when requiresAll holds, so APPS holds
 * every application here and each open returns a session.
 */
async function all(t, apps = Object.values(APPS)) {
  const sessions = {};
  for (const app of apps) sessions[app.name] = await open(t, app);
  return sessions;
}

/** The first application of the session, whose results the results of every other application are compared with. */
const comparison = (sessions) => {
  const [baseline, ...others] = Object.keys(sessions);
  return { baseline, others };
};

if (requiresAll(process.env)) test("every host answers the same page the same way", async (t) => {
  const sessions = await all(t, MAIN_PAGE_APPS);
  const dragged = {};
  const results = {};
  const logs = {};
  const states = {};
  for (const [name, s] of Object.entries(sessions)) {
    // The call records show which phase of presentSurfaces held a commit that does not settle. The settled-commit wait reads
    // the transcript lines, which the page sends as the record workbench.record.info of the class lifecycle.
    await fresh(s, { log: { call: "debug", lifecycle: "info" }, reads: ["workbench.call", "workbench.record.info"] });
    states[name] = { fresh: await layoutState(s) };
    // The settled layout of the drag is taken by stopping the recording before the settings modal opens. The modal is an overlay of the whole window and changes the next layout,
    // and the moment at which that layout enters the recording differs per host.
    const start = (await s.get("host.window")).surfaces.find((item) => item.frame.width > 0)?.frame.x;
    const expectedFrames = states[name].fresh.window.surfaces.filter((item) => item.visible).map((item) => item.frame).sort(byPosition);
    const dragLog = await s.transcript(recordCatalog(s.app));
    results[name] = await drag(s, PLAN);
    // A settled layout also occurs at a moment where the drag is stopped. The drag returns to its place, so the check waits until the last settled layout equals the layout
    // before the drag.
    try {
      await dragLog.until((lines) => {
        const actualFrames = settledFrames(lines);
        // A preparation after the last settled presentation moves the layout on, settled or not.
        const lastSync = lines.findLastIndex((line) => /^info workbench workbench: host syncSurfaces /.test(line));
        const lastPresent = lines.findLastIndex((line) => /^info workbench workbench: host presentSurfaces .*"settled":true.* ->/.test(line));
        return actualFrames?.length === expectedFrames.length && actualFrames.every((frame, index) =>
          ["x", "y", "width", "height"].every((key) => Math.abs(frame[key] - expectedFrames[index][key]) < 0.5)) &&
          lastPresent > lastSync;
      }, "the drag did not end with a settled commit at its starting surface frames");
    } catch (error) {
      const now = await s.get("host.window");
      const grid = await s.get("core.grid");
      error.message += `\nstart x ${start}; drag result boundary ${JSON.stringify(results[name].boundary)}, steps ` +
        `${results[name].steps}, took ${results[name].took}; surfaces now ` +
        `${JSON.stringify(now.surfaces.map((item) => [item.frame.x, item.frame.width]))}; grid ${JSON.stringify(grid).slice(0, 600)}` +
        `; expected frames ${JSON.stringify(expectedFrames)}; last settled frames ${JSON.stringify(settledFrames(dragLog.lines) ?? null)}`;
      throw error;
    }
    dragged[name] = await dragLog.stop();
    states[name].afterDrag = await layoutState(s);
    const log = await s.transcript(recordCatalog(s.app));
    await s.run("core.settings.open");
    const { controls } = await s.until("core.settings-modal", (modal) => modal.open, "settings did not open");
    assert.ok(controls.some((c) => c.key === "nav:sidebars"), "settings must have a sidebars section");
    await s.run("core.settings-modal.nav", { section: "sidebars" });
    await log.until((lines) => lines.some((line) => line.startsWith("info workbench workbench: host overlayPlace")), "settings were not placed");
    logs[name] = await log.stop();
    await s.run("core.settings.close");
  }

  const { baseline, others } = comparison(sessions);
  const rested = Object.fromEntries(Object.keys(sessions).map((name) => [name, atRest(dragged[name])]));
  for (const [name, found] of Object.entries(rested)) {
    assert.ok(found, `${name} recorded no settled commit:\n${dragged[name].join("\n")}`);
  }
  // On failure, it writes the order of the x of the first surface of the settled layouts of each host and the boundary of the drag result.
  const boundary = (result) => result.boundary && [result.boundary[0], result.boundary.at(-1)];
  const dragState = Object.fromEntries(Object.entries(results).map(([name, result]) => [name, {
    from: result.from, steps: result.steps, took: result.took, asked: result.asked, pressWaits: result.pressWaits,
    late: result.late, deepest: result.deepest, boundary: boundary(result),
  }]));
  const stateReport = `window, document, and layout settings by host: ${JSON.stringify(states)}`;
  const mine = transcript([...dragged[baseline], ...logs[baseline]]);
  for (const other of others) {
    assert.equal(rested[other].request, rested[baseline].request, `${other} and ${baseline} give the page a different plane to lay out ` +
      `after the drag:\n${baseline} ${rested[baseline].request}\n${other} ${rested[other].request}\n` +
      `settled first-surface x: ${baseline} ${JSON.stringify(settledX(dragged[baseline]))}, ${other} ${JSON.stringify(settledX(dragged[other]))}; ` +
      `drag measurements: ${JSON.stringify(dragState)}; ` +
      stateReport);
    assert.equal(rested[other].answer, rested[baseline].answer,
      `${other} and ${baseline} place the same surfaces differently; ${stateReport}`);
    const theirs = transcript([...dragged[other], ...logs[other]]);
    const only = {
      [baseline]: [...mine.keys()].filter((name) => !theirs.has(name)),
      [other]: [...theirs.keys()].filter((name) => !mine.has(name)),
    };
    assert.deepEqual(only, { [baseline]: [], [other]: [] }, `${other} and ${baseline} were asked for different things`);
    for (const name of mine.keys()) {
      if (name === "syncSurfaces" || name === "presentSurfaces") continue;
      const own = mine.get(name).at(-1);
      const their = theirs.get(name).at(-1);
      // To classify an intermittent difference, the failure message holds all requests and replies of the two compared hosts.
      const answers = `\n${baseline} ${own.request} -> ${own.answer}\n${other} ${their.request} -> ${their.answer}`;
      // A long request is cut in the message, so the message first names the place where the requests first differ (F40).
      assert.equal(their.request, own.request,
        `${name} was asked differently, ${other} ${textDifference(their.request, own.request)} of ${baseline}; ${stateReport}:${answers}`);
      assert.equal(their.answer, own.answer,
        `${name} was answered differently, ${other} ${textDifference(their.answer, own.answer)} of ${baseline}:${answers}`);
    }
  }
});

if (requiresAll(process.env)) test("every host lays out the same page the same way after a resize", async (t) => {
  const sessions = await all(t, MAIN_PAGE_APPS);
  const rested = {};
  for (const [name, s] of Object.entries(sessions)) {
    // The call records show which phase of presentSurfaces held a commit that does not settle. The settled-commit wait reads
    // the transcript lines, which the page sends as the record workbench.record.info of the class lifecycle.
    await fresh(s, { log: { call: "debug", lifecycle: "info" }, reads: ["workbench.call", "workbench.record.info"] });
    const log = await s.transcript(recordCatalog(s.app));
    await s.run("host.window.resize", SIZE);
    await s.until("host.window", (w) => w.content.width === SIZE.width && w.content.height === SIZE.height,
      "the window did not resize");
    await s.until("core.window.workbench", (workbench) => workbench.width === SIZE.width && workbench.height === SIZE.height,
      "the workbench did not take the new size");
    const lines = await log.until(settled, "the resize did not end with a settled commit").then(() => log.stop());
    const found = atRest(lines);
    assert.ok(found, `${name} recorded no settled commit after the resize:\n${lines.join("\n")}`);
    rested[name] = found;
  }
  const { baseline, others } = comparison(sessions);
  for (const other of others) {
    assert.equal(rested[other].request, rested[baseline].request,
      `${other} and ${baseline} give the page a different plane at ${SIZE.width}x${SIZE.height}`);
    assert.equal(rested[other].answer, rested[baseline].answer,
      `${other} and ${baseline} place the same surfaces differently at ${SIZE.width}x${SIZE.height}`);
  }
});

/** A stable public state owns its own native frames and hits, without page transcripts. */
async function readPublicState(s, normalize) {
  // host.window.presented waits until the open surface layout transactions committed, so the declarations read after it are those
  // of the native frames; read before it, the declarations of the previous layout can still equal what was applied to them.
  await s.presented();
  const surfaces=await s.until("core.surfaces",rows=>rows.some(row=>row.visible) && rows.filter(row=>row.visible).every(row=>
    row.declared && row.applied && ["x","y","w","h"].every(key=>row.declared[key]===row.applied[key])),
  "the public surface declarations were not applied exactly");
  const [layout,grid,modal]=await Promise.all([layoutState(s),s.get("core.grid"),s.get("core.settings-modal")]);
  const hits={};
  for(const row of surfaces.filter(row=>row.visible)) {
    const native=layout.window.surfaces.filter(value=>value.id===row.surface);
    assert.equal(native.length,1,`surface ${row.surface} has no unique native frame for its hit query`);
    const frame=native[0].frame;
    // The first backing-pixel row lies in the view root rather than its content
    // region. Modal routing is checked at this same independently owned point.
    hits[row.surface]=await s.run("host.hit",{x:frame.x+frame.width/2,y:frame.y+0.5/layout.window.scale});
  }
  return publicHostState({layout,grid,surfaces,modal,hits,normalize});
}

if (requiresAll(process.env)) test("every host preserves public surface, hit and layout parity through drag, resize and settings", {timeout:180000}, async(t)=>{
  const sessions=await all(t);
  const states={};
  for(const [name,s] of Object.entries(sessions)) {
    await fresh(s);
    const names=orderNames();
    const normalize=text=>names(Object.values(APPS).reduce((value,app)=>value.replaceAll(app.configDir,"<config-dir>"),text));
    states[name]={fresh:await readPublicState(s,normalize)};
    await drag(s,PLAN);
    states[name].afterDrag=await readPublicState(s,normalize);
    assert.deepEqual(states[name].afterDrag.geometry,states[name].fresh.geometry,`${name} drag return changed its stable public state`);
    await s.run("host.window.resize",SIZE);
    await s.until("host.window",value=>value.content.width===SIZE.width && value.content.height===SIZE.height,"the native window did not take the public resize");
    await s.until("core.window.workbench",value=>value.width===SIZE.width && value.height===SIZE.height,"the workbench did not take the public resize");
    states[name].resized=await readPublicState(s,normalize);
    await s.run("core.settings.open");
    await s.until("core.settings-modal",value=>value.open,"the public settings modal did not open");
    // host.window.presented waits only for a modal web view that is already shown, so the hits wait until the dialog is shown.
    await settingsShown(s,"the public settings modal was not shown");
    states[name].settingsOpen=await readPublicState(s,normalize);
    await s.run("core.settings.close");
    await s.until("core.settings-modal",value=>!value.open,"the public settings modal did not close");
    states[name].settingsClosed=await readPublicState(s,normalize);
    assert.deepEqual(states[name].settingsClosed.geometry,states[name].resized.geometry,`${name} settings close changed its stable public state`);
  }
  comparePublicHostStates(states);
});

/** The menu table of the host contract specification. The declaration is the reference, so the check reads it from the specification file. */
async function menuContract() {
  const { specMenuTables } = await import("../scripts/check-hosts-same.mjs");
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

if (requiresAll(process.env)) test("every host serves the declared application menu", async (t) => {
  const sessions = await all(t);
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
      return view !== undefined && view.items.length >= declaredCounts[contract.menus.findIndex(([id]) => id === "view")]
        && view.items[view.items.length - 1].title.length > 0;
    }, "the declared View menu items did not all arrive", { timeout: 5000 });
    const report = settled;
    assert.ok(typeof report?.language === "string" && columns.includes(report.language),
      `host.menu must report a declared language: ${JSON.stringify(report).slice(0, 200)}`);
    // The application name appears with different lengths in a menu title and an item title (for example soksak and
    // sok-tauriv2). Both are application names, so both are removed.
    const names = [...new Set([report.menus[0].title, `sok-${name}`])];
    const titles = (await s.get("host.windows")).map((entry) => entry.title);
    observed[name] = { language: report.language, menus: normalizeMenus(report.menus, names, titles, declaredCounts) };
  }
  const languages = Object.values(observed).map((value) => value.language);
  assert.equal(new Set(languages).size, 1, `every host must serve the same menu language: ${JSON.stringify(languages)}`);
  const column = columns.indexOf(languages[0]) + 1;

  // The observed menus follow the order and the titles of the declared top-level menus. The title of the app menu is the normalized application name.
  const served = Object.values(observed).map((value) => value.menus);
  for (const menus of served) {
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
  for (const menus of served) {
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
  const { baseline, others } = comparison(observed);
  for (const other of others) {
    assert.deepEqual(markSystemItems(observed[other].menus), markSystemItems(observed[baseline].menus),
      `${other} and ${baseline} must serve the same application menu`);
  }

  // The layout and the native surfaces do not follow the web view zoom, and a reload changes the state of the main page.
  const forbidden = Object.values(observed).flatMap(({ menus }) => menus.flatMap((menu) => menu.items))
    .filter((item) => /zoom in|zoom out|actual size|reload/i.test(item.title));
  assert.deepEqual(forbidden, [], "no menu item zooms or reloads the whole webview");
});
