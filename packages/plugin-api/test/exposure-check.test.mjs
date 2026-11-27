import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkPluginRepository, coreExposure } from "../exposure-check.js";

/** A temporary plugin repository made of plugin.json and ui sources. */
function repository(t, manifest, files) {
  const root = mkdtempSync(join(tmpdir(), "plugin-exposure-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "plugin.json"), JSON.stringify(manifest));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const manifest = {
  id: "probe",
  exposes: { status: [{ name: "probe.state" }], commands: [{ name: "probe.open" }], element: [{ name: "probe.view" }] },
  sections: [{ id: "probe.declared", name: "Declared", composition: { kind: "view", page: "ui/section.html" }, height: "fill" }],
};

test("a plugin repository whose sources match its declarations passes", (t) => {
  const root = repository(t, manifest, {
    "ui/page.js": 'expose.status("probe.state", read);\nexpose.command("probe.open", open);\nel.dataset.expose = "probe.view";\n',
  });
  assert.deepEqual(checkPluginRepository(root, { status: ["core.grid"], commands: [] }), []);
});

test("an undeclared name, an unregistered entry and an unknown core name are reported", (t) => {
  const root = repository(t, manifest, {
    "ui/page.js": 'expose.status("probe.state", read);\nrun("probe.close");\n',
  });
  assert.deepEqual(checkPluginRepository(root, { status: ["core.grid"], commands: [] }), [
    "ui/page.js:2: probe.close is not declared",
    "ui/page.js:2: probe.close is run but is not a declared command",
    "plugin probe: command probe.open is declared but not registered",
    "plugin probe: element probe.view is declared but no element carries it",
  ]);
});

test("the core names hold statuses and commands", () => {
  const core = coreExposure();
  assert.ok(core.status.includes("core.grid") && core.commands.length > 0);
});

test("the core names hold the workbench statuses and the toasts, and no page status", () => {
  const core = coreExposure();
  for (const name of ["core.window.workbench", "core.toasts", "core.notices", "core.workbench.audit"]) {
    assert.ok(core.status.includes(name), `core exposure lacks ${name}`);
  }
  assert.deepEqual(core.status.filter((name) => /^core\.(page\.|window\.document$)/.test(name)), []);
});

test("a name registered with expose.element is an element name and must be declared", (t) => {
  const root = repository(t, manifest, {
    "ui/page.js": 'expose.status("probe.state", read);\nexpose.command("probe.open", open);\nawait expose.element("probe.view", el);\n'
      + 'await context.exposure.element("probe.missing", other);\n',
  });
  assert.deepEqual(checkPluginRepository(root, { status: [], commands: [] }), [
    "ui/page.js:4: probe.missing is not declared",
    "ui/page.js:4: data-expose probe.missing is not a declared element entry",
  ]);
});

test("a data-expose name that no element entry declares is reported", (t) => {
  const root = repository(t, manifest, {
    "ui/page.js": 'expose.status("probe.state", read);\nexpose.command("probe.open", open);\nel.dataset.expose = "probe.view";\n',
    "ui/page.html": '<button data-expose="probe.other">x</button>\n',
  });
  assert.deepEqual(checkPluginRepository(root, { status: [], commands: [] }), [
    "ui/page.html:1: probe.other is not declared",
    "ui/page.html:1: data-expose probe.other is not a declared element entry",
  ]);
});

test("a surface module runs a command of core through runtime.command, and an unknown core command is reported", (t) => {
  const root = repository(t, manifest, {
    "ui/page.js": 'expose.status("probe.state", read);\nexpose.command("probe.open", open);\nel.dataset.expose = "probe.view";\n'
      + 'await context.runtime.command("core.file.place", { name });\nawait context.runtime.command("core.nothing", {});\n',
  });
  assert.deepEqual(checkPluginRepository(root, { status: [], commands: ["core.file.place"] }), [
    "ui/page.js:5: core.nothing is run through runtime.command but is not a command of core or a declared command of the plugin",
  ]);
});

test("a view registers a command through commands.register, names a declared section id, and runs its own command", (t) => {
  const root = repository(t, manifest, {
    "ui/page.js": 'expose.status("probe.state", read);\nel.dataset.expose = "probe.view";\n',
    "ui/section.js": 'commands.register("probe.open", open);\nif (section.id === "probe.declared") draw();\n'
      + 'runtime.command("probe.open", null, { surface });\n',
  });
  assert.deepEqual(checkPluginRepository(root, { status: [], commands: [] }), []);
});

test("runtime.command of an undeclared command of the plugin is still reported", (t) => {
  const root = repository(t, manifest, {
    "ui/page.js": 'expose.status("probe.state", read);\nexpose.command("probe.open", open);\nel.dataset.expose = "probe.view";\n'
      + 'runtime.command("probe.missing", null);\n',
  });
  assert.deepEqual(checkPluginRepository(root, { status: [], commands: [] }), [
    "ui/page.js:4: probe.missing is not declared",
    "ui/page.js:4: probe.missing is run through runtime.command but is not a command of core or a declared command of the plugin",
  ]);
});

// A plugin depends on core only through engines.soksak and the SDK release that it pins (docs/spec/plugins.md#plugin-tests): the
// check reads no contract-copies.json, so a copy that differs from contract/ of this package is not an error of the plugin.
test("the check of a plugin repository reads no contract copies", (t) => {
  const root = repository(t, { id: "probe" }, { "contract-copies.json": JSON.stringify({ "expose.json": "0".repeat(64) }) });
  assert.deepEqual(checkPluginRepository(root, { status: [], commands: [] }), []);
});
