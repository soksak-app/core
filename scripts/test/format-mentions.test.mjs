// The mechanical tie of the installed format number: every spec, test and fixture mention of the format of
// plugins/installed.json matches the number the reader requires, and the migration fixture names the previous released
// form (docs/spec/installation.md#stored-data-migration, F189).
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const ROOT = new URL("../..", import.meta.url).pathname;

const installedFormat = Number(/const InstalledFormat = (\d+)/.exec(readFileSync(join(ROOT, "packages/sok/wailsv3/src/install.go"), "utf8"))[1]);
const installedFormatRust = Number(/pub const INSTALLED_FORMAT: u64 = (\d+)/.exec(readFileSync(join(ROOT, "packages/sok/tauriv2/src/install.rs"), "utf8"))[1]);

test("both command lines require the same installed format number", () => {
  assert.equal(installedFormatRust, installedFormat);
});

test("every spec mention of the installed format number matches the reader", () => {
  const findings = [];
  for (const dir of ["docs/spec", "docs/operations", "docs/plans"]) {
    for (const name of readdirSync(join(ROOT, dir))) {
      if (!name.endsWith(".md") && !name.endsWith(".ko.md")) continue;
      const text = readFileSync(join(ROOT, dir, name), "utf8");
      for (const match of text.matchAll(/format must be (\d)|`format` (?:is not|이 아닌) (\d)|has `format` (\d)|`format` (\d+)과|format` (\d+)은/g)) {
        const found = Number(match.slice(1).find((group) => group !== undefined));
        // The legitimate mentions are the closed format-1 lineage, the floor 2, the previous and the current form.
        const allowed = new Set([1, 2, installedFormat - 1, installedFormat]);
        if (!allowed.has(found)) findings.push(`${dir}/${name}: format ${found}`);
      }
    }
  }
  assert.deepEqual(findings, []);
});

test("the stored fixtures of the tests name the current form or the released form one below", () => {
  const findings = [];
  const files = [
    "packages/sok/wailsv3/tests/install_test.go",
    "packages/sok/wailsv3/tests/plugins_test.go",
    "packages/sok/wailsv3/tests/plugin_catalog_test.go",
    "packages/sok/wailsv3/tests/replay_test.go",
    "packages/sok/tauriv2/tests/install_test.rs",
    "packages/sok/tauriv2/tests/plugins_test.rs",
    "packages/sok/tauriv2/tests/plugin_catalog_test.rs",
    "packages/sok/tauriv2/tests/replay_test.rs",
  ];
  for (const file of files) {
    const text = readFileSync(join(ROOT, file), "utf8");
    for (const [, line, number] of text.matchAll(/^(.*"format":\s*(\d+).*)$/gm)) {
      // The registry index file legitimately holds format 1; the closed lineage, the floor, the released form one below
      // the current one and the above-chain form 9 are the forms the tests may store.
      if (line.includes("index.json") || line.includes("registry")) continue;
      const allowed = new Set([1, 2, installedFormat - 1, installedFormat, 9]);
      if (!allowed.has(Number(number))) findings.push(`${file}: format ${number}`);
    }
  }
  // The migration tests hold the released form and forms outside the chain.
  assert.deepEqual(findings, []);
});

test("the migration fixture names the previous released form", () => {
  const text = readFileSync(join(ROOT, "packages/sok/wailsv3/tests/migrate_test.go"), "utf8");
  assert.match(text, new RegExp(`"format": ${installedFormat - 1}`), "the migration fixture no longer names the previous released form; it must track it so the release step keeps its meaning");
});
