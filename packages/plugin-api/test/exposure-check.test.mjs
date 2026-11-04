import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  exposes: { status: [{ name: "probe.state" }], commands: [{ name: "probe.open" }], dom: [{ name: "probe.view" }] },
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
    "plugin probe: dom probe.view is declared but no element carries it",
  ]);
});

test("the core names hold statuses and commands", () => {
  const core = coreExposure();
  assert.ok(core.status.includes("core.grid") && core.commands.length > 0);
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

// The contract copies of a release (docs/spec/plugins.md#contract-copies): contract-copies.json names each copy with the
// SHA-256 of its bytes, and each copy is the file of the same name in contract/ of this package.
const published = (name) => createHash("sha256").update(readFileSync(new URL(`../contract/${name}`, import.meta.url))).digest("hex");
const copies = (declaration) => ({ "contract-copies.json": JSON.stringify(declaration) });

test("a contract copy with the SHA-256 of the published contract file passes", (t) => {
  const root = repository(t, { id: "probe" }, copies({ "expose.json": published("expose.json") }));
  assert.deepEqual(checkPluginRepository(root, { status: [], commands: [] }), []);
});

test("a contract copy whose SHA-256 differs from the published contract file is reported", (t) => {
  const root = repository(t, { id: "probe" }, copies({ "expose.json": published("calls.json") }));
  assert.deepEqual(checkPluginRepository(root, { status: [], commands: [] }), [
    "contract copy expose.json differs from contract/expose.json",
  ]);
});

test("a contract copy without a published contract file is reported", (t) => {
  const root = repository(t, { id: "probe" }, copies({ "declared-ui-snapshot.json": published("expose.json"), "../package.json": published("expose.json") }));
  assert.deepEqual(checkPluginRepository(root, { status: [], commands: [] }), [
    "contract copy declared-ui-snapshot.json has no published contract/declared-ui-snapshot.json",
    "contract copy ../package.json has no published contract/../package.json",
  ]);
});

test("a release without contract-copies.json holds no contract copy", (t) => {
  const root = repository(t, { id: "probe" }, {});
  assert.deepEqual(checkPluginRepository(root, { status: [], commands: [] }), []);
});
