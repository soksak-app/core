// The accounts of the plugins of a window (docs/spec/plugins.md#accounts). The host calls are answered by the page-wire cases accounts-*
// (docs/spec/cases/page-wire/README.md), and the plugin key accounts is kept by the plugin store of plugin-data.js.
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { host, selectPageWire } from "@soksak/runtime";

const dom = new JSDOM("<body></body>", { url: "https://example.test/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;

const { configureData, declareProjectData, viewDataOf } = await import("../plugin-data.js");
const { createAccounts } = await import("../accounts.js");

// The plugin store of the host: the entries of each plugin.
const entries = {};
configureData({
  data: {
    get: () => ({}),
    set: async () => { throw new Error("an account record was written as project data"); },
    plugin: {
      get: (plugin) => entries[plugin] ?? {},
      put: async (plugin, key, entry, base, fallback) => {
        const stored = entries[plugin]?.[key]?.value ?? fallback;
        if (base !== undefined && JSON.stringify(stored) !== JSON.stringify(base)) return false;
        entries[plugin] = { ...entries[plugin], [key]: entry };
        return true;
      },
    },
  },
});
declareProjectData("agents", { accounts: { schema: { type: "array" }, default: [], scope: "plugin" } });
declareProjectData("notes", {});

const PATTERNS = [{ pattern: "[a-z]+" }, { pattern: "/.+" }];
const DECLARED = {
  accounts: {
    kinds: [{ value: "claude", label: "Claude Code" }, { value: "codex", label: "Codex" }],
    programs: { status: "account-status", login: "account-login", logout: "account-logout" },
  },
  programs: Object.fromEntries(["account-status", "account-login", "account-logout"].map((name) =>
    [name, { program: "plugin:bin/account.mjs", args: PATTERNS }])),
};

/** Settles the runs that the commands and the notices started. */
const settled = () => new Promise((resolve) => setImmediate(resolve));
const store = (records) => { entries.agents = { accounts: { format: 1, value: records } }; };
const stored = () => entries.agents.accounts.value;

/** The accounts over the host of the selected case, with the record of the shown errors. */
function open(name) {
  const wire = selectPageWire(name);
  const shown = [];
  let changes = 0;
  const accounts = createAccounts({
    host,
    declarations: (plugin) => (plugin === "agents" ? DECLARED : plugin === "notes" ? { accounts: null, programs: {} } : null),
    data: (plugin) => viewDataOf(null, plugin),
    changed: () => { changes += 1; },
    failed: (plugin, text) => shown.push([plugin, text]),
  });
  return { wire, accounts, shown, changes: () => changes };
}

test("showing a page runs status for each account in turn, a failure keeps the state before, and window-active reads again", { timeout: 5000 }, async () => {
  store([{ id: "account-1", name: "업무", kind: "claude" }, { id: "account-2", name: "개인", kind: "codex" }]);
  const { wire, accounts, shown } = open("accounts-status-read");
  accounts.follow();
  assert.equal(accounts.status(), null);
  accounts.show("agents");
  assert.deepEqual(accounts.status().accounts.map((item) => [item.name, item.login, item.usage, item.running]),
    [["개인", null, [], false], ["업무", null, [], false]], "an account before its first status run has a state");
  await settled();
  await settled();
  assert.deepEqual(accounts.status(), { plugin: "agents", accounts: [
    { id: "account-2", name: "개인", kind: "codex", login: null, until: null, usage: [], running: false },
    { id: "account-1", name: "업무", kind: "claude", login: true, until: "2026-12-01T09:00:00+09:00",
      usage: [{ label: "5시간", used: 42, resets: "2026-11-26T15:00:00+09:00" }], running: false },
  ] });
  assert.deepEqual(shown, [["agents", "account 개인: account-status exited with 1: codex: command not found"]]);
  // Drawing the shown page again starts no run.
  accounts.show("agents");
  await settled();
  assert.equal(wire.calls.length, 3);

  wire.deliverNotice();
  await settled();
  await settled();
  assert.deepEqual(shown.at(-1), ["agents", "account 업무: account-status printed no JSON"]);
  assert.deepEqual(accounts.list("agents").map((item) => [item.name, item.login]), [["개인", false], ["업무", true]],
    "a failed run replaced the state of its account");
  accounts.show(null);
  assert.equal(accounts.status(), null);
  wire.finish();
});

test("an add takes the least identifier that no record and no home has, and a remove removes the record and the home", { timeout: 5000 }, async () => {
  store([]);
  const { wire, accounts } = open("accounts-add-remove");
  const finished = [];
  accounts.onFinished((command, plugin) => finished.push([command, plugin]));
  assert.deepEqual(await accounts.add({ plugin: "agents", name: "업무", kind: "claude" }), { id: "account-2" });
  assert.deepEqual(stored(), [{ id: "account-2", name: "업무", kind: "claude" }]);
  assert.deepEqual(finished, [["core.accounts.add", "agents"]]);
  await settled();
  assert.equal(accounts.list("agents")[0].login, false);
  assert.equal(await accounts.remove({ plugin: "agents", id: "account-2" }), null);
  assert.deepEqual(stored(), []);
  assert.deepEqual(accounts.list("agents"), []);
  wire.finish();
});

test("a login reports running until it ends, a cancel ends it, and a login and a logout read the status after them", { timeout: 5000 }, async () => {
  store([{ id: "account-1", name: "업무", kind: "claude" }]);
  const { wire, accounts } = open("accounts-login");
  const first = accounts.login({ plugin: "agents", id: "account-1" });
  await settled();
  assert.equal(accounts.list("agents")[0].running, true);
  for (const refused of [
    () => accounts.login({ plugin: "agents", id: "account-1" }),
    () => accounts.logout({ plugin: "agents", id: "account-1" }),
    () => accounts.rename({ plugin: "agents", id: "account-1", name: "다른" }),
    () => accounts.remove({ plugin: "agents", id: "account-1" }),
  ]) await assert.rejects(refused(), /^Error: the login of account 업무 is running$/);
  assert.equal(await accounts.loginCancel({ plugin: "agents", id: "account-1" }), null);
  wire.release("accountRun");
  assert.equal(await first, null);
  assert.equal(accounts.list("agents")[0].running, false);

  assert.equal(await accounts.login({ plugin: "agents", id: "account-1" }), null);
  await settled();
  assert.equal(accounts.list("agents")[0].login, true);
  assert.equal(await accounts.logout({ plugin: "agents", id: "account-1" }), null);
  await settled();
  assert.equal(accounts.list("agents")[0].login, false);
  wire.finish();
});

test("the commands refuse what the contract refuses before any host call", { timeout: 5000 }, async () => {
  store([{ id: "account-1", name: "업무", kind: "claude" }]);
  const { wire, accounts } = open("accounts-refused");
  const refusals = [
    [() => accounts.add({ plugin: "notes", name: "a", kind: "claude" }), "plugin notes declares no accounts"],
    [() => accounts.add({ plugin: "other", name: "a", kind: "claude" }), "plugin other declares no accounts"],
    [() => accounts.add({ plugin: "agents", name: "", kind: "claude" }), "account name must be 1 to 40 characters without a control character"],
    [() => accounts.add({ plugin: "agents", name: "가".repeat(41), kind: "claude" }), "account name must be 1 to 40 characters without a control character"],
    [() => accounts.add({ plugin: "agents", name: "a\nb", kind: "claude" }), "account name must be 1 to 40 characters without a control character"],
    [() => accounts.add({ plugin: "agents", name: "업무", kind: "claude" }), "account name 업무 is already used"],
    [() => accounts.add({ plugin: "agents", name: "a", kind: "gemini" }), "account kind gemini is not declared by agents"],
    [() => accounts.rename({ plugin: "agents", id: "account-9", name: "a" }), "account account-9 is not defined"],
    [() => accounts.remove({ plugin: "agents", id: "account-9" }), "account account-9 is not defined"],
    [() => accounts.loginCancel({ plugin: "agents", id: "account-1" }), "no login of account 업무 is running"],
  ];
  for (const [call, text] of refusals) await assert.rejects(call(), new Error(text));

  for (const [records, reason] of [
    [[{ id: "account-1", name: "a" }], "record 0 must be {id, name, kind}"],
    [[{ id: "Account", name: "a", kind: "claude" }], "record 0 id \"Account\" is not an account identifier"],
    [[{ id: "account-1", name: "", kind: "claude" }], "record 0 name must be 1 to 40 characters without a control character"],
    [[{ id: "account-1", name: "a", kind: "gemini" }], "record 0 kind \"gemini\" is not declared"],
    [[{ id: "account-1", name: "a", kind: "claude" }, { id: "account-1", name: "b", kind: "claude" }], "id account-1 repeats"],
    [[{ id: "account-1", name: "a", kind: "claude" }, { id: "account-2", name: "a", kind: "codex" }], "name a repeats"],
  ]) {
    store(records);
    assert.throws(() => accounts.list("agents"), new Error(`plugin agents data accounts: ${reason}`));
  }
  assert.equal(wire.calls.length, 0);
  wire.finish();
});
