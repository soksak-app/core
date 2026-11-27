// The group Accounts of the plugin page of the settings tab (docs/spec/plugins.md#accounts, docs/spec/settings.md#plugin-page). The host calls
// are answered by the page-wire case settings-accounts-draw.
import assert from "node:assert/strict";
import test from "node:test";
import { selectPageWire } from "@soksak/runtime";
import { startSettingsTab, openSettingsTab } from "./support/settings-tab-window.mjs";

const PATTERNS = [{ pattern: "[a-z]+" }, { pattern: "/.+" }];
const wire = selectPageWire("settings-accounts-draw");

const shown = [];
const ctx = await startSettingsTab(null, {
  connect: false,
  setup: async () => {
    const { installEnvironment } = await import("../environment.js");
    const { configureData } = await import("../plugin-data.js");
    const entries = { agents: { accounts: { format: 1, value: [
      { id: "account-1", name: "업무", kind: "claude" }, { id: "account-2", name: "개인", kind: "codex" },
    ] } } };
    configureData({ data: { get: () => ({}), set: async () => {}, plugin: { get: (plugin) => entries[plugin] ?? {}, put: async () => true } } });
    const refused = installEnvironment({
      runtime: "runtime",
      workspace: { focus: "main", grid: { root: { card: "main", tabs: [] } } },
      sidebars: { sets: [], links: [] },
    }, { plugins: [{ id: "agents", package: "@fixture/agents", version: "1.0.0", folder: "/installed/plugin", manifest: {
      id: "agents", name: "에이전트", description: "에이전트 정의.",
      sections: [{ id: "agents.list", name: "목록", height: "fill", composition: { kind: "view", page: "ui/list.html" } }],
      programs: Object.fromEntries(["account-status", "account-login", "account-logout"].map((name) => [name, { program: "plugin:bin/account.mjs", args: PATTERNS }])),
      data: { accounts: { schema: { type: "array" }, default: [], scope: "plugin" } },
      accounts: {
        kinds: [{ value: "claude", label: "Claude Code" }, { value: "codex", label: "Codex" }],
        programs: { status: "account-status", login: "account-login", logout: "account-logout" },
      },
    } }] });
    if (refused.length > 0) throw new Error(`fixture refused: ${refused.join(", ")}`);
  },
});
// The plugin list of the window comes from the host state, which the page reads when it starts (installed-plugins.js).
await (await import("../installed-plugins.js")).pluginOperations.refresh();
const { installAccountsExposure } = await import("../accounts-exposure.js");
installAccountsExposure({ showError: (plugin, text) => shown.push([plugin, text]), changed: () => ctx.core.redrawSettings() });
const settled = () => new Promise((resolve) => setImmediate(resolve));
const params = (el) => JSON.parse(el.dataset.params);

test("the plugin page draws a row per account in the order of the names, with the buttons of its login", async () => {
  await openSettingsTab(ctx);
  await ctx.run("core.settings-tab.plugin", { plugin: "agents" });
  await settled();
  await settled();
  assert.deepEqual(shown, []);
  const rows = [...document.querySelectorAll('[data-expose="core.settings-tab.account"]')];
  assert.deepEqual(rows.map((row) => row.dataset.account), ["account-2", "account-1"], "the rows are not in the order of the names");
  assert.equal(rows[1].querySelector(".set-account__line").textContent, "account-1 · Claude Code · 로그인됨 · 2026-12-01T09:00:00+09:00까지");
  assert.equal(rows[0].querySelector(".set-account__line").textContent, "account-2 · Codex · 로그인 안 됨");
  const login = document.querySelector('[data-expose="core.settings-tab.account-login"]');
  assert.deepEqual([login.dataset.command, params(login)], ["core.accounts.login", { plugin: "agents", id: "account-2" }]);
  const logout = document.querySelector('[data-expose="core.settings-tab.account-logout"]');
  assert.deepEqual([logout.dataset.command, params(logout)], ["core.accounts.logout", { plugin: "agents", id: "account-1" }]);
  const removes = [...document.querySelectorAll('[data-expose="core.settings-tab.account-remove"]')].map((el) => params(el).id);
  assert.deepEqual(removes, ["account-2", "account-1"]);
  const add = document.querySelector('[data-expose="core.settings-tab.account-add"]');
  assert.deepEqual([add.dataset.command, params(add)], ["core.accounts.add", { plugin: "agents", name: "", kind: "claude" }]);
});

test("the new account name and kind are kept in the state of the tab and refuse an undeclared kind", async () => {
  await ctx.run("core.settings-tab.account-name", { name: "새 업무" });
  await ctx.run("core.settings-tab.account-kind", { kind: "codex" });
  const add = document.querySelector('[data-expose="core.settings-tab.account-add"]');
  assert.deepEqual(params(add), { plugin: "agents", name: "새 업무", kind: "codex" });
  await assert.rejects(ctx.run("core.settings-tab.account-kind", { kind: "gemini" }), /account kind gemini is not declared$/);
});

test("the rename field edits one account and cancel leaves the row with its buttons", async () => {
  await ctx.run("core.settings-tab.account-edit", { id: "account-1" });
  const field = document.querySelector('[data-expose="core.settings-tab.account-edit-name"]');
  assert.equal(field.value, "업무");
  await ctx.run("core.settings-tab.account-edit-name", { name: "회사" });
  const save = document.querySelector('[data-expose="core.settings-tab.account-save"]');
  assert.deepEqual([save.dataset.command, params(save)], ["core.accounts.rename", { plugin: "agents", id: "account-1", name: "회사" }]);
  const cancel = document.querySelector('[data-expose="core.settings-tab.account-edit-cancel"]');
  assert.deepEqual([cancel.dataset.command, params(cancel)], ["core.settings-tab.account-edit", { id: null }]);
  assert.equal(document.querySelectorAll('[data-expose="core.settings-tab.account-remove"]').length, 1, "the edited row kept its buttons");
  await ctx.run("core.settings-tab.account-edit", { id: null });
  assert.equal(document.querySelectorAll('[data-expose="core.settings-tab.account-save"]').length, 0);
});

test("the account commands are refused outside a page of a plugin with accounts", async () => {
  await ctx.run("core.settings-tab.nav", { page: "look" });
  await assert.rejects(ctx.run("core.settings-tab.account-name", { name: "a" }), /no page of a plugin with accounts shows/);
  wire.finish();
});
