// The agent page of the settings tab and the core.setup entries (docs/spec/settings.md#agents). The host calls of the setup
// parts are answered by the page-wire case setup-parts-settings.
import assert from "node:assert/strict";
import test from "node:test";
import { EXPOSURE_ERRORS } from "@soksak/plugin-api";
import { selectPageWire } from "@soksak/runtime";
import { startSettingsTab, openSettingsTab } from "./support/settings-tab-window.mjs";

/** Settles the reads and the draws that a command or the showing started. */
const settled = () => new Promise((resolve) => setImmediate(resolve));

test("changing the desired PATH setup sends the selected value and publishes the resulting state", async () => {
  const { createSetupParts } = await import("../setup-parts.js");
  const parts = [{ part: "path", enabled: false, state: "ok", file: "/Users/person/.local/bin/sok", step: "" }];
  const calls = [];
  const setup = createSetupParts({
    host: { call: async (name, params) => {
      calls.push({ name, params });
      return { parts };
    } },
    changed() {},
    failed: assert.fail,
  });
  assert.deepEqual(await setup.change({ part: "path", enabled: false }), { parts });
  assert.deepEqual(calls, [{ name: "setupChange", params: { part: "path", enabled: false } }]);
  assert.deepEqual(setup.status(), { parts, running: null });
});

test("the agent page reads the parts when it shows, shows the PATH preference, and runs the setup commands", { timeout: 10000 }, async (t) => {
  const wire = selectPageWire("setup-parts-settings");
  const ctx = await startSettingsTab(t, { connect: false });
  const { installSetupExposure } = await import("../setup-exposure.js");
  const shown = [];
  installSetupExposure({ showError: (text) => shown.push(text), changed: () => ctx.core.redrawSettings() });
  const { document } = ctx;
  await openSettingsTab(ctx);
  const rows = () => [...document.querySelectorAll('[data-expose="core.settings-tab.setup"]')].map((row) => [
    row.querySelector(".set-row__name").textContent,
    row.querySelector(".set-badge").textContent,
    row.querySelector(".set-caption").textContent,
  ]);
  const control = (name) => document.querySelector(`[data-expose="${name}"]`);
  const params = (el) => JSON.parse(el.dataset.params);
  const showAgents = async () => {
    await ctx.run("core.settings-tab.nav", { page: "agents" });
    await settled();
    await settled();
  };

  assert.deepEqual(await ctx.status("core.setup"), { parts: [], running: null }, "core.setup before the first read");
  await showAgents();
  assert.equal(wire.calls.filter(({ name }) => name === "setupState").length, 1, "showing the agent page did not read the parts once");
  assert.deepEqual(rows(), [
    ["명령 경로", "없음", "/Users/person/.local/bin/sok"],
    ["스킬", "다름", "/Users/person/.claude/skills/soksak/SKILL.md"],
    ["MCP 등록", "없음", "/Users/person/.claude.json"],
    ["훅", "없음", "/Users/person/.claude/settings.json"],
  ]);
  // A skill file that differs is a missing part whose reason is differs (docs/spec/cli.md#setup-parts): its badge is differs and its button is Fix.
  const fix = document.querySelector('[data-expose="core.settings-tab.setup-install"]');
  assert.deepEqual([fix.textContent, fix.dataset.command, params(fix)], ["고치기", "core.setup.install", { parts: ["skill"] }]);
  const pathToggle = control("core.settings-tab.setup-change");
  assert.deepEqual([pathToggle.textContent, pathToggle.dataset.command, params(pathToggle)],
    ["끄기", "core.setup.change", { part: "path", enabled: false }]);
  const all = control("core.settings-tab.setup-install-all");
  assert.deepEqual([all.textContent, all.dataset.command, params(all)], ["모두 설치", "core.setup.install", { parts: ["skill", "mcp"] }]);
  const check = control("core.settings-tab.setup-check");
  assert.deepEqual([check.textContent, check.dataset.command], ["다시 확인", "core.setup.check"]);

  const installed = await ctx.run("core.setup.install", params(all));
  assert.deepEqual(installed.parts.map(({ part, state, changed }) => [part, state, changed]),
    [["path", "missing", false], ["skill", "ok", true], ["mcp", "ok", true], ["hook", "ok", false]]);
  await settled();
  assert.deepEqual((await ctx.status("core.setup")).parts, installed.parts);
  assert.deepEqual(rows().map(([name, state]) => [name, state]), [["명령 경로", "없음"], ["스킬", "설치됨"], ["MCP 등록", "설치됨"], ["훅", "설치됨"]]);
  assert.equal(document.querySelectorAll('[data-expose="core.settings-tab.setup-install"]').length, 0, "no row offers 설치 while every skill and mcp part is ok");
  assert.equal(control("core.settings-tab.setup-install-all").disabled, true, "모두 설치 is enabled while every skill and mcp part is ok");

  const refused = await ctx.registry.handle({ method: "command.run", params: { name: "core.setup.install", params: { parts: ["path"] } } });
  assert.equal(refused.error?.code, EXPOSURE_ERRORS.invalidParams, "an install of the path entry is not refused as invalid params");

  for (const params of [{ part: "skill", enabled: false }, { part: "path" }, { part: "path", enabled: "off" }]) {
    const invalid = await ctx.registry.handle({ method: "command.run", params: { name: "core.setup.change", params } });
    assert.equal(invalid.error?.code, EXPOSURE_ERRORS.invalidParams, JSON.stringify(params));
  }
  const disabled = await ctx.run("core.setup.change", { part: "path", enabled: false });
  assert.equal(disabled.parts[0].enabled, false);
  await settled();
  assert.equal(rows()[0][1], "사용 안 함");
  const enablePath = control("core.settings-tab.setup-change");
  assert.deepEqual([enablePath.textContent, params(enablePath)], ["켜기", { part: "path", enabled: true }]);

  await ctx.run("core.setup.check", {});
  await settled();
  const error = "read /Users/person/.claude/skills/soksak/SKILL.md: permission denied";
  assert.deepEqual(rows(), [["스킬", "오류", "/Users/person/.claude/skills/soksak/SKILL.md"]], "the row of the failed part keeps its state label");
  const toast = document.querySelector(".toast__title");
  assert.equal(toast?.textContent, error, "the error of a part shows in the error toast");
  assert.equal(document.querySelectorAll('[data-expose="core.settings-tab.setup-install"]').length, 0, "설치 is not shown for a skill part in error");

  // Closing the tab and showing the agent page again reads the parts again, and a machine without parts says so.
  await ctx.run("core.settings.close");
  await openSettingsTab(ctx);
  await showAgents();
  assert.equal(wire.calls.filter(({ name }) => name === "setupState").length, 3, "showing the agent page again did not read the parts");
  assert.deepEqual(rows(), []);
  assert.ok([...document.querySelectorAll(".set-caption")].some((el) => el.textContent === "이 컴퓨터에서 설정할 에이전트 항목이 없습니다."),
    "a machine without parts does not say so");
  assert.equal(document.querySelectorAll('[data-expose="core.settings-tab.setup-install-all"]').length, 1);
  assert.deepEqual(shown, []);
  wire.finish();
});
