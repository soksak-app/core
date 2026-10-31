// Checks which plugin opens a file and which paths core.file.open accepts (docs/spec/plugins.md#pluginjson).
import assert from "node:assert/strict";
import test from "node:test";
import { checkOpenPath, chooseOpener } from "../file-open.js";

const plugins = [
  { id: "notes", opens: ["md", "txt"] },
  { id: "rust", opens: ["rs"] },
  { id: "plain", opens: null },
];

test("the plugin that declares the extension opens a file, and a file whose extension no plugin declares has no opener", () => {
  assert.equal(chooseOpener(plugins, "docs/a.md"), "notes");
  assert.equal(chooseOpener(plugins, "docs/A.MD"), "notes");
  assert.equal(chooseOpener(plugins, "src/main.rs"), "rust");
  assert.throws(() => chooseOpener(plugins, "src/main.go"), /^Error: no plugin opens src\/main\.go$/);
  assert.throws(() => chooseOpener(plugins, "Makefile"), /^Error: no plugin opens Makefile$/);
  assert.throws(() => chooseOpener(plugins, ".gitignore"), /^Error: no plugin opens \.gitignore$/);
  // A declaration of * is not a declaration of any extension.
  assert.throws(() => chooseOpener([...plugins, { id: "any", opens: ["*"] }], "Makefile"), /^Error: no plugin opens Makefile$/);
  assert.throws(() => chooseOpener([...plugins, { id: "other", opens: ["md"] }], "a.md"), /a\.md is opened by notes and other/);
});

test("a path to open is relative to the project root", () => {
  assert.equal(checkOpenPath("docs/a.md"), "docs/a.md");
  for (const path of ["/etc/hosts", "../a.md", "docs/../../a.md", ""]) {
    assert.throws(() => checkOpenPath(path), /path must be relative to the project root/, path);
  }
});
