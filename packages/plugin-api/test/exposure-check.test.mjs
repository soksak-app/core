import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
  exposes: { status: [{ name: "probe.state" }], commands: [{ name: "probe.open" }], dom: [{ name: "probe.view" }] },
  sections: [{ id: "probe.list", module: "ui/list.js" }],
};

test("a plugin repository whose sources match its declarations passes", (t) => {
  const root = repository(t, manifest, {
    "ui/page.js": 'expose.status("probe.state", read);\nexpose.command("probe.open", open);\nel.dataset.expose = "probe.view";\n',
    "ui/list.js": 'context.status("core.grid");\n',
  });
  assert.deepEqual(checkPluginRepository(root, { status: ["core.grid"], commands: [] }), []);
});

test("an undeclared name, an unregistered entry and an unknown core name are reported", (t) => {
  const root = repository(t, manifest, {
    "ui/page.js": 'expose.status("probe.state", read);\nrun("probe.close");\n',
    "ui/list.js": 'context.status("core.nothing");\n',
  });
  assert.deepEqual(checkPluginRepository(root, { status: ["core.grid"], commands: [] }), [
    "ui/list.js:1: core.nothing is not a declared core status or command",
    "ui/page.js:2: probe.close is not declared",
    "ui/page.js:2: probe.close is run but is not a declared command",
    "plugin probe: command probe.open is declared but not registered",
    "plugin probe: dom probe.view is declared but no element carries it",
  ]);
});

test("the core names hold statuses and commands", () => {
  const core = coreExposure();
  assert.ok(core.status.includes("core.grid") && core.commands.length > 0);
});

test("a manifest with a status-form section and a module-form section is checked by the form of each section", (t) => {
  const root = repository(t, {
    ...manifest,
    sections: [{ id: "probe.list", module: "ui/list.js" }, { id: "probe.declared", name: "Declared", status: "probe.state" }],
  }, {
    "ui/page.js": 'expose.status("probe.state", read);\nexpose.command("probe.open", open);\nel.dataset.expose = "probe.view";\n',
    "ui/list.js": 'context.status("core.grid");\n',
  });
  assert.deepEqual(checkPluginRepository(root, { status: ["core.grid"], commands: [] }), []);
});

test("a status-form section carries no module source, and a module violation is still reported", (t) => {
  const root = repository(t, {
    ...manifest,
    sections: [{ id: "probe.declared", name: "Declared", status: "probe.state" }],
  }, {
    "ui/page.js": 'expose.status("probe.state", read);\nexpose.command("probe.open", open);\nel.dataset.expose = "probe.view";\n',
  });
  assert.deepEqual(checkPluginRepository(root, { status: ["core.grid"], commands: [] }), []);
  const violating = repository(t, {
    ...manifest,
    sections: [{ id: "probe.declared", name: "Declared", status: "probe.state" }, { id: "probe.list", module: { horizontal: "ui/horizontal.js", vertical: "ui/vertical.js" } }],
  }, {
    "ui/page.js": 'expose.status("probe.state", read);\nexpose.command("probe.open", open);\nel.dataset.expose = "probe.view";\n',
    "ui/horizontal.js": 'context.status("core.nothing");\n',
    "ui/vertical.js": 'context.status("core.grid");\n',
  });
  assert.deepEqual(checkPluginRepository(violating, { status: ["core.grid"], commands: [] }), [
    "ui/horizontal.js:1: core.nothing is not a declared core status or command",
  ]);
});

test("a surface module runs a command of core through runtime.command, and an unknown core command is reported", (t) => {
  const root = repository(t, manifest, {
    "ui/page.js": 'expose.status("probe.state", read);\nexpose.command("probe.open", open);\nel.dataset.expose = "probe.view";\n'
      + 'await context.runtime.command("core.file.place", { name });\nawait context.runtime.command("core.nothing", {});\n',
  });
  assert.deepEqual(checkPluginRepository(root, { status: [], commands: ["core.file.place"] }), [
    "ui/page.js:5: core.nothing is run through runtime.command but is not a command of core",
  ]);
});
