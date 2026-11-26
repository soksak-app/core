// The group 계정 of the plugin page of the settings window (docs/spec/plugins.md#accounts, docs/spec/settings.md#controls). The host
// calls are answered by the page-wire case settings-accounts-draw.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { selectPageWire } from "@soksak/runtime";

const PATTERNS = [{ pattern: "[a-z]+" }, { pattern: "/.+" }];

test("the plugin page draws a row per account with the buttons of its login, and the fields keep their text for 추가 and 저장", { timeout: 5000 }, async () => {
  const dom = new JSDOM("<body><div id=plane></div></body>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  globalThis.CSS = dom.window.CSS ?? { escape: (text) => text };
  globalThis.addEventListener = dom.window.addEventListener.bind(dom.window);
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  // The settings window and its modules are loaded without a host, so this document draws the card.
  const { installEnvironment } = await import("../environment.js");
  const { configureData } = await import("../plugin-data.js");
  const entries = { agents: { accounts: { format: 1, value: [
    { id: "account-1", name: "업무", kind: "claude" }, { id: "account-2", name: "개인", kind: "codex" },
  ] } } };
  configureData({ data: { get: () => ({}), set: async () => {}, plugin: { get: (plugin) => entries[plugin] ?? {}, put: async () => true } } });
  assert.deepEqual(installEnvironment({
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
  } }] }), [], "the fixture environment refused a plugin");
  const { registry } = await import("../exposure.js");
  registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
  await import("../page-log.js");
  await import("../commands.js");
  // The accounts and the setup parts take the host of the case when their modules load.
  const wire = selectPageWire("settings-accounts-draw");
  const { installAccountsExposure } = await import("../accounts-exposure.js");
  const ui = await import("../settings-ui.js");
  const shown = [];
  installAccountsExposure({ showError: (plugin, text) => shown.push([plugin, text]), changed: () => ui.drawSettings() });
  const settled = () => new Promise((resolve) => setImmediate(resolve));
  try {
    ui.openSettings();
    ui.showSection("plugins");
    ui.showPlugin("agents");
    await settled();
    await settled();
    assert.deepEqual(shown, []);
    const card = document.getElementById("settings");
    const rows = [...card.querySelectorAll('[data-expose="core.settings-modal.account"]')];
    assert.deepEqual(rows.map((row) => row.dataset.account), ["account-2", "account-1"], "the rows are not in the order of the names");
    assert.equal(rows[1].querySelector(".set-account__line").textContent, "업무 · Claude Code · 로그인됨 · 2026-12-01T09:00:00+09:00까지");
    assert.deepEqual([...rows[1].querySelectorAll(".set-caption")].map((line) => line.textContent), ["5시간 42% · 2026-11-26T15:00:00+09:00 초기화"]);
    assert.equal(rows[0].querySelector(".set-account__line").textContent, "개인 · Codex · 로그인 필요");
    const controls = () => ui.settingsModalState().controls;
    const named = (name) => controls().filter((control) => control.name === name);
    assert.deepEqual(named("core.settings-modal.account-login").map((control) => control.command),
      [{ name: "core.accounts.login", params: { plugin: "agents", id: "account-2" } }]);
    assert.deepEqual(named("core.settings-modal.account-logout").map((control) => control.command),
      [{ name: "core.accounts.logout", params: { plugin: "agents", id: "account-1" } }]);
    assert.deepEqual(named("core.settings-modal.account-remove").map((control) => control.command.params.id), ["account-2", "account-1"]);
    assert.deepEqual(named("core.settings-modal.account-kind")[0].options, ["claude", "codex"]);
    assert.deepEqual(named("core.settings-modal.account-add")[0].command,
      { name: "core.accounts.add", params: { plugin: "agents", name: "", kind: "claude" } });

    ui.setAccountName("새 업무");
    ui.setAccountKind("codex");
    assert.deepEqual(named("core.settings-modal.account-add")[0].command.params, { plugin: "agents", name: "새 업무", kind: "codex" });
    assert.equal(named("core.settings-modal.account-name")[0].value, "새 업무");
    assert.throws(() => ui.setAccountKind("gemini"), /account kind gemini is not declared by agents/);

    ui.editAccount("account-1");
    assert.equal(named("core.settings-modal.account-edit-name")[0].value, "업무");
    ui.setAccountEditName("회사");
    assert.deepEqual(named("core.settings-modal.account-save")[0].command,
      { name: "core.accounts.rename", params: { plugin: "agents", id: "account-1", name: "회사" } });
    assert.deepEqual(named("core.settings-modal.account-edit-cancel")[0].command,
      { name: "core.settings-modal.account-edit", params: { id: null } });
    assert.equal(named("core.settings-modal.account-remove").length, 1, "the edited row kept its buttons");
    ui.editAccount(null);
    assert.equal(named("core.settings-modal.account-save").length, 0);
    ui.showPlugin(null);
    assert.throws(() => ui.setAccountName("a"), /no page of a plugin with accounts shows/);
  } finally {
    ui.closeSettings();
    dom.window.close();
  }
  wire.finish();
});
