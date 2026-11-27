// Checks, in the running documents, that the interactive elements of every screen and state have a declared command and an element name.
//
// For the workbench it uses core.workbench.audit, and for plugin surface documents the unbound of core.surface.document, which
// report interactive elements that are not bound to a command or have no name (docs/spec/exposure.md).
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";
import { unauditedViews } from "./audit-surfaces.mjs";

/** Confirms that the audit of the workbench and of every visible plugin surface document is empty. */
async function clean(s, where) {
  const { unbound } = await s.get("core.workbench.audit");
  assert.deepEqual(unbound, [], `${where}: workbench controls without a command or element name`);
  // A view that a focus change draws registers its entries after it is placed, so the wait ends when every visible view exposes its document.
  await s.until("core.surfaces", (all) => unauditedViews(all.filter((surface) => surface.visible)).length === 0,
    `${where}: visible views whose page does not expose core.surface.document`);
  const surfaces = await s.surfaces();
  for (const surface of surfaces) {
    if (!surface.exposes.includes("status core.surface.document")) continue;
    const doc = await s.get("core.surface.document", surface.surface);
    assert.deepEqual(doc.unbound, [], `${where}: ${surface.plugin} surface ${surface.surface} controls without a command or element name`);
  }
}

/** Opens the menu, checks the audit, and closes it. */
async function menu(s, name, params, where) {
  await s.run(name, params);
  await s.until("core.picker", (picker) => picker.open && picker.items.length > 0, `${where} did not open`);
  await clean(s, where);
  await s.run("core.picker.close");
  await s.until("core.picker", (picker) => !picker.open, `${where} did not close`);
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: every control on every screen runs a declared command and has an element name`, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    const surfaces = await s.surfaces();
    assert.ok(surfaces.length > 0, "the workspace must show plugin surfaces");
    await clean(s, "workspace");

    // Selection layer: add, split, and tab list per card.
    const grid = await s.get("core.grid");
    for (const card of grid.cards.filter((c) => c.pane !== null)) {
      for (const kind of ["add", "split-x", "split-y"]) {
        if (card.acts[kind].enabled && !card.acts[kind].hidden) {
          await menu(s, "core.card.menu", { card: card.id, menu: kind }, `${card.id} ${kind} menu`);
        }
      }
      await menu(s, "core.card.tab-list", { card: card.id }, `${card.id} tab list`);
    }

    // The space and the project that are being renamed.
    const project = await s.get("core.project");
    for (const [kind, id] of [["space", project.activeSpaceId], ["project", project.id]]) {
      await s.run("core.rename.begin", { kind, id });
      await s.until("core.rename", (rename) => rename?.id === id, `${kind} rename did not start`);
      await clean(s, `${kind} rename`);
      await s.run("core.rename.cancel");
      await s.until("core.rename", (rename) => rename === null, `${kind} rename did not stop`);
    }

    // Settings tab: every page of both scopes.
    await s.run("core.settings.open");
    await s.until("core.settings-tab", (tab) => tab !== null, "settings did not open");
    for (const scope of ["common", "project"]) {
      await s.run("core.settings-tab.scope", { scope });
      for (const page of ["look", "workspace", "sets", "behavior", "agents", "diag", "installed", "browse"]) {
        await s.run("core.settings-tab.nav", { page });
        await s.until("core.settings-tab", (tab) => tab?.page === page && tab.scope === scope,
          `settings did not show ${scope} ${page}`);
        await clean(s, `settings ${scope} ${page}`);
      }
    }
    await s.run("core.settings.close");
    await s.until("core.settings-tab", (tab) => tab === null, "settings did not close");

    // The project home, its form, and the state without search results.
    await s.run("core.projects.browse");
    await s.until("core.home", (home) => home.rows.length > 0, "the project home did not list projects");
    await clean(s, "project home");
    for (const mode of ["create", "open"]) {
      await s.run("core.home.form.open", { mode });
      await s.rect("core.home.form.name");
      await clean(s, `project home ${mode} form`);
      await s.run("core.home.form.cancel");
      await assert.rejects(s.rect("core.home.form.name"), /core\.home\.form\.name/, `the ${mode} form did not close`);
    }
    await s.run("core.home.search", { query: "no such project" });
    await s.until("core.home", (home) => home.rows.length === 0, "search did not empty the project home");
    await s.rect("core.home.no-results");
    await clean(s, "project home without results");
    await s.run("core.home.search", { query: "" });
    await s.run("core.home.open", { project: project.id });
    await s.until("core.screen", (screen) => screen.screen === "workspace", "the project home did not return to the workspace");
    await clean(s, "workspace after the project home");
  });
}
