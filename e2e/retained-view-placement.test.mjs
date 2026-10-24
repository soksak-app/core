// Checks startup placement for a stored, inactive unloadable view under both memory-saver settings.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { APPS, keepCommonSettings, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";

const added = (list, known) => list.find((window) => !known.includes(window.window)).window;
const terminalCard = (grid) => grid.cards.find((card) => card.tabs.some((tab) => tab.plugin === "terminal"));
const memoryTab = (memory, tab) => memory.tabs.find((entry) => entry.tab === tab);

for (const app of Object.values(APPS)) {
  test(`${app.name}: a cold hidden browser view follows the memory-saver setting`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s, { settings: { memorySaver: true, memorySaverDelay: 720 } });
    await keepCommonSettings(s);

    const temporary = realpathSync(mkdtempSync(join(tmpdir(), "soksak-cold-hidden-view-")));
    const root = join(temporary, "project");
    mkdirSync(root);
    s.cleanup(() => rmSync(temporary, { recursive: true, force: true }));
    s.cleanup(async () => {
      for (const window of await s.get("host.windows")) {
        if (window.window !== s.window) await s.on(window.window).close();
      }
      await s.windows(1, "project-view cleanup left an extra window");
      for (const project of await s.get("core.projects")) {
        if (project.root === root) await s.run("core.project.close", { id: project.id });
      }
      await s.run("core.projects.flush");
      assert.equal(await s.get("core.page.error"), null, "project-view cleanup reported an application error");
    });

    await s.run("core.settings.set", {
      patch: { memorySaver: true, memorySaverDelay: 720, projectOpening: "windows" }, scope: "common",
    });
    await s.until("core.settings", (settings) => settings.values.memorySaver === true
      && settings.values.projectOpening === "windows" && !settings.saving,
    "the saved-project opening settings did not settle");
    const project = await s.run("core.project.open", { root, color: "#7fe3b0" });
    let child = s.on(added(await s.windows(2, "the stored project window did not open"), [s.window]));
    const initialGrid = await child.until("core.grid", (grid) => grid.cards.some((card) =>
      card.tabs.some((tab) => tab.plugin === "terminal")), "the project did not create its terminal card");
    const initialCard = terminalCard(initialGrid);
    const activeTab = initialCard.active;
    const { tab: hiddenTab } = await child.run("core.card.add-tab", { card: initialCard.id, plugin: "browser" });
    await child.until("core.grid", (grid) => terminalCard(grid)?.active === hiddenTab,
      "the browser tab did not become active");
    await child.run("core.tab.select", { tab: activeTab });
    const storedGrid = await child.until("core.grid", (grid) => {
      const card = terminalCard(grid);
      return card?.active === activeTab && card.tabs.some((tab) => tab.id === hiddenTab && tab.plugin === "browser");
    }, "the browser tab was not saved as inactive");
    assert.equal(terminalCard(storedGrid).tabs.length, 2, "the stored terminal card must contain exactly two tabs");
    await child.run("core.projects.flush");
    await child.close();
    await s.windows(1, "the project window did not close before its cold reopen");

    const openSaved = async (label) => {
      const known = [s.window];
      await s.run("core.project.activate", { id: project.id });
      return s.on(added(await s.windows(2, `${label}: the saved project window did not open`), known));
    };
    const activePlacement = async (window, label) => {
      const grid = await window.until("core.grid", (value) => terminalCard(value)?.active,
        `${label}: the terminal card did not become available`);
      const active = terminalCard(grid)?.active;
      assert.ok(active, `${label}: the terminal card has no active tab`);
      const surfaces = await window.until("core.surfaces", (items) => items.some((item) =>
        item.surface === active && item.plugin === "terminal" && item.visible && item.composition === "view"
        && item.status.phase === "ready" && item.applied), `${label}: active terminal view did not mount and apply`);
      const surface = surfaces.find((item) => item.surface === active && item.plugin === "terminal" && item.visible
        && item.composition === "view" && item.status.phase === "ready" && item.applied);
      assert.ok(surface, `${label}: active terminal surface was absent from the satisfied status`);
      await window.until("host.window", (state) => state.surfaces.some((item) => item.id === active
        && item.visible && item.frame.width > 0 && item.frame.height > 0), `${label}: active native view was not placed`);
      await window.until("core.surface.document", (document) => document?.readyState === "complete" && document.themed,
        `${label}: active terminal document did not become ready`, { surface: surface.surface });
      return active;
    };

    child = await openSaved("memory saver enabled");
    assert.equal(await activePlacement(child, "memory saver enabled"), activeTab,
      "the saved active tab changed when memory saver was enabled");
    const unloaded = await child.until("core.tab.memory", (memory) => memory.enabled
      && memoryTab(memory, hiddenTab)?.state === "unloaded", "the cold hidden browser did not start unloaded");
    assert.ok(unloaded.tabs.some((entry) => entry.tab === hiddenTab && entry.state === "unloaded"),
      "core.tab.memory did not retain the cold hidden tab as unloaded");
    assert.equal(memoryTab(unloaded, hiddenTab).plugin, "browser");
    const coldGrid = await child.until("core.grid", (grid) => {
      const card = terminalCard(grid);
      return card?.active === activeTab && card.tabs.some((tab) => tab.id === hiddenTab && tab.plugin === "browser");
    }, "the unloaded browser was not retained as an inactive saved tab");
    assert.equal(terminalCard(coldGrid).tabs.length, 2, "the cold terminal card must retain both saved tabs");
    assert.equal((await child.get("host.window")).surfaces.some((item) => item.id === hiddenTab), false,
      "an unloaded tab retained a native surface");
    assert.equal(await child.get("core.page.error"), null, "enabled memory saver reported an application error");
    await child.run("core.projects.flush");
    await child.close();
    await s.windows(1, "the enabled-memory-saver project window did not close");

    await s.run("core.settings.set", { patch: { memorySaver: false }, scope: "common" });
    await s.until("core.settings", (settings) => settings.values.memorySaver === false && !settings.saving,
      "memory saver did not turn off");
    child = await openSaved("memory saver disabled");
    assert.equal(await activePlacement(child, "memory saver disabled"), activeTab,
      "the saved active tab changed when memory saver was disabled");
    const loaded = await child.until("core.tab.memory", (memory) => !memory.enabled
      && memoryTab(memory, hiddenTab)?.state === "loaded", "the cold hidden browser did not start loaded");
    assert.ok(memoryTab(loaded, hiddenTab).reasons.includes("off"),
      "the loaded hidden tab did not report the off protection");
    const loadedGrid = await child.until("core.grid", (grid) => {
      const card = terminalCard(grid);
      return card?.active === activeTab && card.tabs.some((tab) => tab.id === hiddenTab && tab.plugin === "browser");
    }, "the loaded browser was not retained as an inactive saved tab");
    assert.equal(terminalCard(loadedGrid).tabs.length, 2, "the loaded terminal card must retain both saved tabs");
    await child.until("core.surface.document", (document) => document?.readyState === "complete" && document.themed,
      "the hidden browser document did not become ready", { surface: hiddenTab });
    await child.until("host.window", (state) => state.surfaces.some((item) => item.id === hiddenTab && !item.visible),
      "the loaded hidden browser was not submitted as an invisible native surface");
    assert.equal(await child.get("core.page.error"), null, "disabled memory saver reported an application error");
  });
}
