// The account group of a plugin page names the CLI accounts of the plugin with the description of the group of the design
// (docs/spec/settings.md#plugins). The login sentence is not part of the group.
import assert from "node:assert/strict";
import test from "node:test";
import { startSettingsTab, openSettingsTab } from "./support/settings-tab-window.mjs";

const SURFACE = { composition: { kind: "view", page: "ui/page.html", regions: [{ name: "page", kind: "document", input: "native" }], overlays: [] } };
const PATTERN = [{ pattern: "[a-z]+" }, { pattern: "/.+" }];
// The plugin store of the host: the entries of each plugin, with no record yet.
const entries = {};
const { configureData } = await import("../plugin-data.js");
configureData({
  data: {
    get: () => ({}),
    set: async () => { throw new Error("an account record was written as project data"); },
    plugin: {
      get: (plugin) => entries[plugin] ?? {},
      put: async (plugin, key, entry) => { entries[plugin] = { ...entries[plugin], [key]: entry }; return true; },
    },
  },
});

const ctx = await startSettingsTab(null, {
  setup: async () => {
    const { installEnvironment } = await import("../environment.js");
    const refused = installEnvironment({
      runtime: "runtime",
      workspace: { focus: "main", grid: { root: { card: "main", tabs: [{ plugin: "gamma", title: "감마" }] } } },
      sidebars: { sets: [], links: [] },
    }, { plugins: [
      { id: "gamma", package: "@fixture/gamma", version: "1.0.0", folder: "/installed/plugin", manifest: {
        id: "gamma", name: "감마", description: "감마 계정.", mark: "g", icon: "<path/>", surface: SURFACE, categories: ["terminal"],
        data: { accounts: { schema: { type: "array" }, default: [], scope: "plugin" } },
        programs: {
          "account-status": { program: "bin/status", args: PATTERN },
          "account-login": { program: "bin/login", args: PATTERN },
          "account-logout": { program: "bin/logout", args: PATTERN },
        },
        accounts: {
          kinds: [{ value: "claude", label: "Claude Code" }],
          programs: { status: "account-status", login: "account-login", logout: "account-logout" },
        },
      } },
    ] });
    if (refused.length > 0) throw new Error(`fixture refused: ${refused.join(", ")}`);
  },
});

test("the account group of a plugin page reads the description of the design", async () => {
  await openSettingsTab(ctx);
  await ctx.run("core.settings-tab.plugin", { plugin: "gamma" });
  const group = document.querySelector('[data-group="account"]') ?? [...document.querySelectorAll(".set-group")].find((el) => el.querySelector(".set-group__name")?.textContent === "계정");
  assert.ok(group, "the plugin page shows the account group");
  assert.equal(group.querySelector(".set-caption")?.textContent, "에이전트 CLI 계정.");
});
