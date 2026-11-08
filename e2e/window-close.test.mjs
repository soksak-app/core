// A window close request asks about each modified tab before the window closes (docs/spec/plugins.md#tab-reports). The modified tab
// is a tab of the save close probe `probeclose`, which reports itself modified through the tab report and counts the saves that the
// workbench asks of it.
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";

const QUESTION = ["저장하고 닫기", "저장하지 않고 닫기", "닫지 않기"];

/**
 * Adds a save close probe tab to the focused card of the window of session `w`, reports it modified, and returns its tab id. Its
 * next save would keep it modified, so only a choice that discards the change ends it.
 */
async function modifiedTab(w) {
  const card = (await w.get("core.grid")).cards.find((item) => item.focused);
  assert.ok(card, "the window has no focused card for the modified tab");
  const { tab } = await w.run("core.card.add-tab", { card: card.id, plugin: "probeclose" });
  await w.until("core.surfaces", (all) => all.some((x) => x.surface === tab && x.status.phase === "ready"),
    "the save close probe tab did not open");
  await w.registered(tab, ["command probeclose.prepare", "status probeclose.state"]);
  await w.run("probeclose.prepare", { keepModified: true }, tab);
  await w.until("probeclose.state", (value) => value.modified && value.saves === 0, "probeclose.prepare did not modify the tab", { surface: tab });
  return tab;
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: closing a window asks about a modified tab and 닫지 않기 keeps the window`, { timeout: 90000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    const root = realpathSync(mkdtempSync(join(tmpdir(), "soksak-window-close-")));
    s.cleanup(() => rmSync(root, { recursive: true, force: true }));
    s.cleanup(async () => {
      for (const window of await s.get("host.windows")) {
        if (window.window !== s.window) await s.on(window.window).close();
      }
      await s.windows(1, "the check left an extra window");
      for (const project of await s.get("core.projects")) {
        if (project.root.startsWith(root)) await s.run("core.project.close", { id: project.id });
      }
      await s.run("core.projects.flush");
    });
    await s.run("core.settings.set", { patch: { projectOpening: "windows" }, scope: "common" });
    const opened = await s.run("core.project.open", { root, color: "#7fe3b0" });
    const windows = await s.windows(2, "the project window did not open");
    const child = s.on(windows.find((item) => item.window !== s.window).window);
    await child.until("core.project", (project) => project?.id === opened.id, "the project did not become active");
    const tab = await modifiedTab(child);

    const ask = async () => (await child.until("core.picker", (picker) => picker.open && picker.title.includes("저장하지 않은 변경이 있습니다"),
      "closing the window did not ask about the modified tab")).items.map((item) => item.name);
    await child.run("host.window.close");
    assert.deepEqual(await ask(), QUESTION);
    // The choice not to close keeps the window and the modified tab.
    await child.run("core.picker.pick", { index: 2 });
    await child.until("core.picker", (picker) => !picker.open, "닫지 않기 did not close the question");
    assert.equal((await s.get("host.windows")).length, 2, "닫지 않기 closed the window");
    assert.equal((await child.get("probeclose.state", tab)).modified, true);

    // The choice to close without saving closes the window without asking the tab to save: the tab keeps itself modified after a
    // save, so a save would leave the tab modified and refuse the close (e2e/save-close.test.mjs), and the window closes only when
    // the change is discarded.
    await child.run("host.window.close");
    assert.deepEqual(await ask(), QUESTION);
    assert.equal((await child.get("probeclose.state", tab)).saves, 0, "the question asked the tab to save");
    await child.run("core.picker.pick", { index: 1 });
    await s.windows(1, "저장하지 않고 닫기 did not close the window");
  });

  test(`${app.name}: a quit that a kept modified tab cancels ends the quit state`, { timeout: 90000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    const tab = await modifiedTab(s);
    s.cleanup(async () => {
      const grid = await s.get("core.grid");
      if (!grid.cards.some((card) => (card.tabs ?? []).some((entry) => entry.id === tab))) return;
      const { closed } = await s.run("core.tab.close", { tab });
      if (closed) return;
      const picker = await s.until("core.picker", (value) => value.open, "the close question did not open");
      await s.run("core.picker.pick", { index: picker.items.findIndex((item) => item.name === "저장하지 않고 닫기") });
    });

    assert.equal((await s.get("host.window")).quitting, false);
    const quitting = s.run("host.quit");
    await s.until("core.picker", (picker) => picker.open && picker.title.includes("저장하지 않은 변경이 있습니다"),
      "the quit did not ask about the modified tab");
    assert.equal((await s.get("host.window")).quitting, true, "the quit did not set the quit state");
    await s.run("core.picker.pick", { index: 2 });
    await s.until("host.window", (value) => value.quitting === false, "닫지 않기 did not end the quit state");
    await quitting;
  });

  test(`${app.name}: removing the active space asks about a modified tab`, { timeout: 90000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    const spaces = async () => (await s.get("core.project")).spaces.map((space) => space.id);
    const first = (await spaces())[0];
    const space = await s.run("core.space.add");
    s.cleanup(async () => {
      if ((await spaces()).includes(space.id)) await s.run("core.space.activate", { id: space.id });
      const grid = await s.get("core.grid");
      for (const card of grid.cards) {
        for (const tab of card.tabs ?? []) {
          if (tab.modified) {
            const { closed } = await s.run("core.tab.close", { tab: tab.id });
            if (!closed) {
              const picker = await s.until("core.picker", (value) => value.open, "the close question did not open");
              await s.run("core.picker.pick", { index: picker.items.findIndex((item) => item.name === "저장하지 않고 닫기") });
            }
          }
        }
      }
      if ((await spaces()).includes(space.id)) await s.run("core.space.close", { id: space.id });
    });
    const tab = await modifiedTab(s);

    const ask = async () => (await s.until("core.picker", (picker) => picker.open && picker.title.includes("저장하지 않은 변경이 있습니다"),
      "removing the space did not ask about the modified tab")).items.map((item) => item.name);
    const removing = s.run("core.space.close", { id: space.id });
    assert.deepEqual(await ask(), QUESTION);
    await s.run("core.picker.pick", { index: 2 });
    assert.deepEqual(await removing, { closed: false });
    assert.deepEqual(await spaces(), [first, space.id], "닫지 않기 removed the space");

    const discarding = s.run("core.space.close", { id: space.id });
    assert.deepEqual(await ask(), QUESTION);
    await s.run("core.picker.pick", { index: 1 });
    assert.deepEqual(await discarding, { closed: true });
    assert.deepEqual(await spaces(), [first]);
  });

  test(`${app.name}: removing the project shown in a window asks about a modified tab`, { timeout: 90000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    const root = realpathSync(mkdtempSync(join(tmpdir(), "soksak-project-remove-")));
    s.cleanup(() => rmSync(root, { recursive: true, force: true }));
    s.cleanup(async () => {
      for (const window of await s.get("host.windows")) {
        if (window.window !== s.window) await s.on(window.window).close();
      }
      await s.windows(1, "the check left an extra window");
      for (const project of await s.get("core.projects")) {
        if (project.root.startsWith(root)) await s.run("core.project.close", { id: project.id });
      }
      await s.run("core.projects.flush");
    });
    await s.run("core.settings.set", { patch: { projectOpening: "windows" }, scope: "common" });
    const opened = await s.run("core.project.open", { root, color: "#7db4ff" });
    const windows = await s.windows(2, "the project window did not open");
    const child = s.on(windows.find((item) => item.window !== s.window).window);
    await child.until("core.project", (project) => project?.id === opened.id, "the project did not become active");
    const tab = await modifiedTab(child);

    const ask = async () => (await child.until("core.picker", (picker) => picker.open && picker.title.includes("저장하지 않은 변경이 있습니다"),
      "removing the project did not ask about the modified tab")).items.map((item) => item.name);
    const listed = async () => (await s.get("core.projects")).some((project) => project.id === opened.id);
    const keeping = child.run("core.project.close", { id: opened.id });
    assert.deepEqual(await ask(), QUESTION);
    await child.run("core.picker.pick", { index: 2 });
    assert.deepEqual(await keeping, { closed: false });
    assert.equal(await listed(), true, "닫지 않기 removed the project");

    const discarding = child.run("core.project.close", { id: opened.id });
    assert.deepEqual(await ask(), QUESTION);
    await child.run("core.picker.pick", { index: 1 });
    assert.deepEqual(await discarding, { closed: true });
    await s.until("core.projects", (projects) => !projects.some((project) => project.id === opened.id),
      "저장하지 않고 닫기 did not remove the project");
  });

  test(`${app.name}: removing a project that another window shows asks that window`, { timeout: 90000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    const root = realpathSync(mkdtempSync(join(tmpdir(), "soksak-project-remote-remove-")));
    s.cleanup(() => rmSync(root, { recursive: true, force: true }));
    s.cleanup(async () => {
      for (const window of await s.get("host.windows")) {
        if (window.window !== s.window) await s.on(window.window).close();
      }
      await s.windows(1, "the check left an extra window");
      for (const project of await s.get("core.projects")) {
        if (project.root.startsWith(root)) await s.run("core.project.close", { id: project.id });
      }
      await s.run("core.projects.flush");
    });
    await s.run("core.settings.set", { patch: { projectOpening: "windows" }, scope: "common" });
    const opened = await s.run("core.project.open", { root, color: "#7db4ff" });
    const windows = await s.windows(2, "the project window did not open");
    const child = s.on(windows.find((item) => item.window !== s.window).window);
    await child.until("core.project", (project) => project?.id === opened.id, "the project did not become active");
    const tab = await modifiedTab(child);

    const ask = async () => (await child.until("core.picker", (picker) => picker.open && picker.title.includes("저장하지 않은 변경이 있습니다"),
      "removing the project did not ask about the modified tab")).items.map((item) => item.name);
    const listed = async () => (await s.get("core.projects")).some((project) => project.id === opened.id);
    const keeping = s.run("core.project.close", { id: opened.id });
    assert.deepEqual(await ask(), QUESTION);
    await child.run("core.picker.pick", { index: 2 });
    assert.deepEqual(await keeping, { closed: false });
    assert.equal(await listed(), true, "닫지 않기 removed the project");

    const discarding = s.run("core.project.close", { id: opened.id });
    assert.deepEqual(await ask(), QUESTION);
    await child.run("core.picker.pick", { index: 1 });
    assert.deepEqual(await discarding, { closed: true });
    await s.until("core.projects", (projects) => !projects.some((project) => project.id === opened.id),
      "저장하지 않고 닫기 did not remove the project");
  });
}
