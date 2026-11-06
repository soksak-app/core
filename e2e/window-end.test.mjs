// The ordinary ends of a window and the Edit items of the application menu: the close button, the item Close Window and its key
// equivalent end a window and leave the application open, a window whose project core.project.close closed ends the same way, and the
// items Select All, Cut and Paste reach the focused text field (docs/spec/hosts.md#mygo-host). Every input is the input of the
// endpoint; no check activates the application.
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";

/** The submenu and the item of the application menu whose key equivalent is key, from the status host.menu. */
async function menuItem(s, key) {
  const { menus } = await s.get("host.menu");
  for (const menu of menus) {
    const item = menu.items.find((entry) => entry.key === key);
    if (item) return { menu: menu.title, title: item.title };
  }
  throw new Error(`${s.app.name}: the application menu has no item with the key equivalent ${key}`);
}

/** Opens a new window and returns its session once it is ready. */
async function newWindow(s) {
  const known = new Set((await s.get("host.windows")).map((entry) => entry.window));
  await s.run("core.window.new");
  const isNew = (entry) => entry.ready && !known.has(entry.window);
  const list = await s.until("host.windows", (windows) => windows.some(isNew), "core.window.new opened no window that became ready");
  return s.on(list.find(isNew).window);
}

/** Waits until window has ended and the window of s still answers, which shows that the application stayed open. */
async function ended(s, window, how) {
  await s.until("host.windows", (windows) => !windows.some((entry) => entry.window === window),
    `${how} did not end window ${window}`);
  const remaining = await s.get("host.windows");
  assert.ok(remaining.some((entry) => entry.window === s.window), `${how} ended the window of the check as well`);
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: the close button, Close Window and its key end a window and leave the application open`, { timeout: 90000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    s.cleanup(() => s.windows(1, "the check left an extra window"));
    const close = await menuItem(s, "cmd+w");

    const byItem = await newWindow(s);
    await byItem.run("host.menu.select", close);
    await ended(s, byItem.window, `the item ${close.title}`);

    const byKey = await newWindow(s);
    await byKey.press("w", { text: "w", modifiers: ["command"] });
    await ended(s, byKey.window, "Command+W");

    const byButton = await newWindow(s);
    const { controls } = await byButton.get("host.window");
    const button = controls[0];
    assert.equal(button?.hidden, false, `the close button of window ${byButton.window} is not shown: ${JSON.stringify(controls)}`);
    await byButton.click(button.x + button.width / 2, button.y + button.height / 2);
    await ended(s, byButton.window, "the close button");
  });

  test(`${app.name}: a window whose project core.project.close closed ends like any window`, { timeout: 90000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    const root = realpathSync(mkdtempSync(join(tmpdir(), "soksak-window-end-")));
    s.cleanup(() => rmSync(root, { recursive: true, force: true }));
    s.cleanup(() => s.windows(1, "the check left an extra window"));
    // projectOpening "windows" opens the project in a window of its own.
    await s.run("core.settings.set", { patch: { projectOpening: "windows" }, scope: "common" });
    const opened = await s.run("core.project.open", { root });
    const windows = await s.windows(2, "the project window did not open");
    const child = s.on(windows.find((item) => item.window !== s.window).window);
    await child.until("core.project", (project) => project?.id === opened.id, "the project did not become active");
    const { closed } = await child.run("core.project.close", { id: opened.id });
    assert.equal(closed, true, "core.project.close kept the project");
    await child.until("core.project", (project) => project === null, "core.project.close left the project shown");
    await child.run("host.menu.select", await menuItem(s, "cmd+w"));
    await ended(s, child.window, "Close Window after core.project.close");
  });

  test(`${app.name}: Select All, Cut and Paste of the Edit menu reach the focused text field`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    s.cleanup(() => s.run("core.library.search", { query: "" }));
    const [selectAll, cut, paste] = [await menuItem(s, "cmd+a"), await menuItem(s, "cmd+x"), await menuItem(s, "cmd+v")];
    await s.run("core.library.search", { query: "window-end" });
    await s.run("core.library.search.focus");
    await s.until("core.library", (library) => library?.search === "window-end", "the search field did not take its text");
    await s.run("host.menu.select", selectAll);
    await s.run("host.menu.select", cut);
    await s.until("core.library", (library) => library?.search === "", `${cut.title} did not remove the selected text of the field`);
    await s.run("host.menu.select", paste);
    await s.until("core.library", (library) => library?.search === "window-end", `${paste.title} did not put the text back`);
  });
}
