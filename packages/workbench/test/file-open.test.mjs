// Checks which plugin opens a file and which paths core.file.open accepts (docs/spec/plugins.md#pluginjson).
import assert from "node:assert/strict";
import test from "node:test";
import { checkOpenPath, chooseOpener } from "../file-open.js";

const plugins = [
  { id: "notes", opens: ["md", "txt"] },
  { id: "any", opens: ["*"] },
  { id: "plain", opens: null },
];

test("the plugin that declares the extension opens a file, and otherwise the plugin that declares *", () => {
  assert.equal(chooseOpener(plugins, "docs/a.md"), "notes");
  assert.equal(chooseOpener(plugins, "docs/A.MD"), "notes");
  assert.equal(chooseOpener(plugins, "src/main.rs"), "any");
  assert.equal(chooseOpener(plugins, "Makefile"), "any");
  assert.equal(chooseOpener(plugins, ".gitignore"), "any");
  assert.throws(() => chooseOpener([{ id: "notes", opens: ["md"] }], "a.rs"), /no plugin opens a\.rs/);
  assert.throws(() => chooseOpener([...plugins, { id: "other", opens: ["md"] }], "a.md"), /a\.md is opened by notes and other/);
  assert.throws(() => chooseOpener([...plugins, { id: "rest", opens: ["*"] }], "a.rs"), /a\.rs is opened by any and rest/);
});

test("a path to open is relative to the project root", () => {
  assert.equal(checkOpenPath("docs/a.md"), "docs/a.md");
  for (const path of ["/etc/hosts", "../a.md", "docs/../../a.md", ""]) {
    assert.throws(() => checkOpenPath(path), /path must be relative to the project root/, path);
  }
});
