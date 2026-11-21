// The agent group of the settings window and the core.setup entries (docs/spec/settings.md#agents). The host calls of the setup
// parts are answered by the page-wire case setup-parts-settings; the settings window itself is drawn by this document without a host.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { EXPOSURE_ERRORS } from "@soksak/plugin-api";
import { selectPageWire } from "@soksak/runtime";

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

test("the agent group reads the parts, shows the PATH preference, and runs the setup commands", { timeout: 10000 }, async () => {
  const dom = new JSDOM("<body><div id=plane></div></body>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  globalThis.CSS = dom.window.CSS ?? { escape: (text) => text };
  globalThis.addEventListener = dom.window.addEventListener.bind(dom.window);
  const memory = { common: {}, projects: [] };
  // The settings window and its modules are loaded without a host, so this document draws the card.
  const settings = await import("../settings.js");
  await settings.connectSettings({
    snapshot: async () => structuredClone(memory),
    settings: async (id, values) => { memory.common = { ...memory.common, ...values }; },
    onChange: () => () => {},
  });
  const { registry } = await import("../exposure.js");
  registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
  await import("../page-log.js");
  await import("../commands.js");
  // The setup parts read the host of the case.
  const wire = selectPageWire("setup-parts-settings");
  const { installSetupExposure } = await import("../setup-exposure.js");
  const ui = await import("../settings-ui.js");
  const shown = [];
  installSetupExposure({ showError: (text) => shown.push(text), changed: () => ui.drawSettings() });
  const rows = () => [...document.querySelectorAll('[data-expose="core.settings-modal.setup"]')].map((row) => [
    row.querySelector(".set-row__name").textContent,
    row.querySelector(".set-setup__state").textContent,
    row.querySelector(".set-caption").textContent,
    row.querySelector(".set-setup__step")?.textContent ?? null,
  ]);
  const control = (name) => document.querySelector(`[data-expose="${name}"]`);
  const status = async () => (await registry.handle({ method: "status.get", params: { name: "core.setup" } })).result;
  try {
    assert.deepEqual(await status(), { parts: [], running: null }, "core.setup before the first read");
    ui.openSettings();
    ui.showSection("general");
    await settled();
    assert.equal(wire.calls.filter(({ name }) => name === "setupState").length, 1, "showing the group did not read the parts once");
    assert.deepEqual(rows(), [
      ["명령 경로", "설치 안 됨", "/Users/person/.local/bin/sok", null],
      ["스킬", "다름", "/Users/person/.claude/skills/soksak/SKILL.md", null],
      ["MCP 등록", "설치 안 됨", "/Users/person/.claude.json", null],
      ["훅", "설치 안 됨", "/Users/person/.claude/settings.json", null],
    ]);
    const pathToggle = control("core.settings-modal.setup-change");
    assert.deepEqual([pathToggle.textContent, pathToggle.dataset.command, JSON.parse(pathToggle.dataset.params)],
      ["끄기", "core.setup.change", { part: "path", enabled: false }]);
    const install = control("core.settings-modal.setup-install");
    assert.equal(install?.textContent, "설치", "a missing skill or mcp part shows no 설치");
    assert.deepEqual([install.dataset.command, JSON.parse(install.dataset.params)], ["core.setup.install", { parts: ["skill", "mcp"] }]);
    const check = control("core.settings-modal.setup-check");
    assert.deepEqual([check.textContent, check.dataset.command], ["다시 확인", "core.setup.check"]);

    const installed = await registry.handle({ method: "command.run", params: { name: "core.setup.install", params: JSON.parse(install.dataset.params) } });
    assert.deepEqual(installed.result.parts.map(({ part, state, changed }) => [part, state, changed]),
      [["path", "missing", false], ["skill", "ok", true], ["mcp", "ok", true], ["hook", "ok", false]]);
    await settled();
    assert.deepEqual((await status()).parts, installed.result.parts);
    assert.deepEqual(rows().map(([name, state]) => [name, state]), [["명령 경로", "설치 안 됨"], ["스킬", "설치됨"], ["MCP 등록", "설치됨"], ["훅", "설치됨"]]);
    assert.equal(control("core.settings-modal.setup-install"), null, "설치 is shown while every skill and mcp part is ok");

    const refused = await registry.handle({ method: "command.run", params: { name: "core.setup.install", params: { parts: ["path"] } } });
    assert.equal(refused.error?.code, EXPOSURE_ERRORS.invalidParams, "an install of the path entry is not refused as invalid params");

    for (const params of [{ part: "skill", enabled: false }, { part: "path" }, { part: "path", enabled: "off" }]) {
      const invalid = await registry.handle({ method: "command.run", params: { name: "core.setup.change", params } });
      assert.equal(invalid.error?.code, EXPOSURE_ERRORS.invalidParams, JSON.stringify(params));
    }
    const disabled = await registry.handle({ method: "command.run", params: { name: "core.setup.change", params: JSON.parse(pathToggle.dataset.params) } });
    assert.equal(disabled.result.parts[0].enabled, false);
    await settled();
    assert.equal(rows()[0][1], "사용 안 함");
    const enablePath = control("core.settings-modal.setup-change");
    assert.deepEqual([enablePath.textContent, JSON.parse(enablePath.dataset.params)], ["켜기", { part: "path", enabled: true }]);

    await registry.handle({ method: "command.run", params: { name: "core.setup.check", params: {} } });
    await settled();
    const error = "read /Users/person/.claude/skills/soksak/SKILL.md: permission denied";
    const state = document.querySelector('[data-expose="core.settings-modal.setup"] .set-setup__state');
    assert.deepEqual([state.textContent, state.dataset.error], [error, "setup:skill:/Users/person/.claude/skills/soksak/SKILL.md"],
      "the error of a part is not drawn through the error display path");
    assert.ok(control("core.settings-modal.setup-install"), "설치 is not shown for a skill part in error");

    // Closing hides the group, and showing it again reads the parts again.
    ui.closeSettings();
    ui.openSettings();
    await settled();
    assert.deepEqual(rows(), []);
    assert.ok([...document.querySelectorAll(".set-caption")].some((el) => el.textContent === "이 컴퓨터에서 설정할 에이전트 항목이 없습니다."),
      "a machine without parts does not say so");
    assert.equal(control("core.settings-modal.setup-install"), null);
    assert.deepEqual(shown, []);
    ui.closeSettings();
    wire.finish();
  } finally {
    dom.window.close();
  }
});
