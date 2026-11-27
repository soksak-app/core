// The plugin rows of the settings tab that the host state drives: a held operation, an outdated persistent service, an incompatible
// plugin and the description line of a plugin (docs/spec/settings.md#plugins). The host calls are answered by the page-wire case
// library-plugins-list, which holds a tty update and a plain enable, lists the sidecars outdated and lists lone with no version for the core 0.0.24.
import assert from "node:assert/strict";
import test from "node:test";
import { selectPageWire } from "@soksak/runtime";

// The case is selected before the settings modules are imported, because the plugin state reads the host when it is imported.
const wire = selectPageWire("library-plugins-list");
const { startSettingsTab, openSettingsTab } = await import("./support/settings-tab-window.mjs");
const ctx = await startSettingsTab(null, { connect: false });
const { pluginOperations, appUpdate } = await import("../installed-plugins.js");
// The reply of the install is held by the case until the test releases it. The page then reads the plugin state,
// the outdated sidecars and the application update, as the case records them.
const installing = pluginOperations.run("install", "db");
wire.release();
await installing;
await pluginOperations.refreshOutdated();
await appUpdate.refresh();
await pluginOperations.refresh();

const texts = (selector) => [...document.querySelectorAll(selector)].map((el) => el.textContent);

test("a held operation shows its error and the action that ends its sessions, and no action while a session count is unknown", async () => {
  await openSettingsTab(ctx);
  await ctx.run("core.settings-tab.nav", { page: "installed" });
  const ends = [...document.querySelectorAll('[data-expose="core.settings-tab.plugins.end"]')];
  assert.deepEqual(ends.map((el) => el.textContent), ["세션 2개를 끝내고 업데이트"], "the held update of tty lists its action, and the held enable of plain with unknown sessions has none");
  assert.equal(ends[0].dataset.command, "core.plugins.update");
  assert.deepEqual(JSON.parse(ends[0].dataset.params), { plugin: "tty", end: true });
  const errors = (await ctx.status("core.settings-tab")).errors;
  assert.ok(errors.some((line) => line.key === "plugin tty held" && line.text === "plugin tty 0.2.0: sidecar @scope/sidecar-probe 0.1.3 waits for the end of its running service 0.1.2"),
    "the error of the held update is not shown through the error display");
});

test("an outdated service shows its versions and its action, and a service of an undeclared sidecar is ended", async () => {
  await openSettingsTab(ctx);
  await ctx.run("core.settings-tab.nav", { page: "installed" });
  assert.deepEqual(texts('[data-expose="core.settings-tab.plugins.outdated"] p'), [
    "@fixture/sidecar-removed: 0.0.5 → 선언 없음",
    "@fixture/sidecar-service: 0.0.3 → 0.0.7",
  ]);
  const replace = [...document.querySelectorAll('[data-expose="core.settings-tab.plugins.replace"]')];
  assert.deepEqual(replace.map((el) => el.textContent), ["세션 1개를 끝내고 종료", "세션 2개를 끝내고 적용"]);
  assert.equal(replace[0].dataset.command, "core.plugins.replace");
  assert.deepEqual(JSON.parse(replace[0].dataset.params), { sidecar: "@fixture/sidecar-removed" });
});

test("an incompatible plugin shows that no version fits the running core, and a catalog description line is a named element", async () => {
  await openSettingsTab(ctx);
  await ctx.run("core.settings-tab.nav", { page: "browse" });
  assert.equal(document.querySelector('[data-plugin="lone"] .set-caption')?.textContent, "lone · core 0.0.24에 맞는 버전 없음");
  assert.equal(document.querySelector('[data-plugin="db"] [data-expose="core.settings-tab.plugins.about"]')?.textContent, "데이터베이스 표면.");
});

test("the plugin page of a plugin that is not loaded draws its info card without the sidebar groups, which need a declaration", async () => {
  await openSettingsTab(ctx);
  await ctx.run("core.settings-tab.plugin", { plugin: "db" });
  assert.equal(document.querySelector('[data-expose="core.settings-tab.plugins.about"]')?.textContent, "데이터베이스 표면.");
  const titles = [...document.querySelectorAll(".set-group__title, .set-group h2, .set-group h3")].map((el) => el.textContent);
  assert.ok(!titles.includes("창 사이드바"), "the window sidebar group is drawn for a plugin that declares no window selectors");
});
