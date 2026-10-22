import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { specMenuTables } from "../check-host-parity.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (path) => readFileSync(join(ROOT, path), "utf8");

const OWNERS = ["native menu", "workbench", "view"];
const TABLE = JSON.parse(read("packages/workbench/shortcuts.json")).shortcuts;
const EXPOSURE_EN = read("docs/spec/exposure.md");
const EXPOSURE_KO = read("docs/spec/exposure.ko.md");
const HOST_CONTRACT = read("docs/spec/host-contract.md");

/** The lower-case key of a shortcut: the last segment of `cmd+shift+n`, or `Enter`. */
const keyName = (key) => key.split("+").at(-1).toLowerCase();

/** Cells of the rows of the shortcut section of a spec, without the header and the separator line. */
function specRows(markdown, heading) {
  const start = markdown.indexOf(heading);
  assert.ok(start >= 0, `the spec has no ${heading} section`);
  const end = markdown.indexOf("\n## ", start + 1);
  const section = markdown.slice(start, end < 0 ? undefined : end);
  return section.split("\n")
    .filter((line) => line.startsWith("|"))
    .slice(2)
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim().replace(/^`(.*)`$/, "$1")));
}

/**
 * The key names that the key comparisons of one source text test: `e.key === "Enter"` and `event.key.toLowerCase() === "n"`,
 * lower-cased. A `typeof x.key` test compares a type name, not a key, so it is not a key comparison.
 */
function keyComparisons(source) {
  const pattern = /(?<!typeof\s+[\w$.]*)\.key(?:\.toLowerCase\(\))?\s*[!=]==?\s*["']([^"']+)["']/g;
  return new Set([...source.matchAll(pattern)].map((match) => match[1].toLowerCase()));
}

/** Key comparisons of the workbench key handlers. */
function workbenchKeyLiterals() {
  const dir = join(ROOT, "packages/workbench");
  const files = readdirSync(dir).filter((file) => file.endsWith(".js") || file.endsWith(".html"));
  const literals = new Set();
  for (const file of files) {
    for (const key of keyComparisons(read(`packages/workbench/${file}`))) literals.add(key);
  }
  return literals;
}

/** The key comparisons that no workbench row of rows declares. */
function undeclaredKeys(literals, rows) {
  const declared = new Set(rows.filter((entry) => entry.owner === "workbench").map((entry) => keyName(entry.key)));
  return [...literals].filter((key) => !declared.has(key));
}

test("every shortcut has a key, an owner, a command, and a context", () => {
  for (const entry of TABLE) {
    assert.ok(entry.key, `shortcut without a key: ${JSON.stringify(entry)}`);
    assert.ok(OWNERS.includes(entry.owner), `${entry.key} has the owner ${entry.owner}`);
    assert.ok(entry.command, `${entry.key} has no command`);
    assert.ok(entry.when, `${entry.key} has no context`);
  }
});

test("a view row is a plan rule 7 rule: it names no command and no menu item", () => {
  for (const entry of TABLE.filter((item) => item.owner === "view")) {
    assert.equal(entry.command, "none", `${entry.key} is a view rule and names the command ${entry.command}`);
    assert.equal(entry.menu, null, `${entry.key} is a view rule and names a menu item`);
    assert.ok(
      entry.key === "Escape" || entry.key === "text input keys",
      `${entry.key} is not a key that a plugin view handles under plan rule 7`,
    );
  }
});

test("every application menu key equivalent is a native menu shortcut", () => {
  const { items } = specMenuTables(HOST_CONTRACT);
  const menuRows = items.filter(([, , , , , key]) => key !== "");
  assert.ok(menuRows.length > 0, "the menu table has no key equivalents");
  for (const [menu, id, , , , key] of menuRows) {
    const item = `${menu}/${id}`;
    assert.ok(
      TABLE.some((entry) => entry.owner === "native menu" && entry.menu === item && entry.key === key),
      `menu item ${item} with key ${key} is missing from packages/workbench/shortcuts.json`,
    );
  }
  for (const entry of TABLE.filter((item) => item.owner === "native menu")) {
    assert.ok(
      menuRows.some(([menu, id, , , , key]) => `${menu}/${id}` === entry.menu && key === entry.key),
      `native menu shortcut ${entry.key} for ${entry.menu} is not a key equivalent of the menu table`,
    );
  }
});

test("every workbench key handler has a workbench or view shortcut, and every such shortcut has a handler", () => {
  const handled = workbenchKeyLiterals();
  assert.ok(handled.size > 0, "no workbench key handler was found");
  for (const key of undeclaredKeys(handled, TABLE)) {
    assert.fail(`workbench key handler for ${key} is missing from packages/workbench/shortcuts.json`);
  }
  const declared = new Set(TABLE.filter((entry) => entry.owner === "workbench").map((entry) => keyName(entry.key)));
  for (const key of declared) {
    assert.ok(handled.has(key), `packages/workbench/shortcuts.json declares ${key}, which no workbench key handler compares`);
  }
});

test("an arrow-key comparison without a workbench row is reported, and the table row clears it", () => {
  const source = 'if (event.key === "ArrowLeft") moveTreeFocus();';
  const withoutRow = TABLE.filter((entry) => keyName(entry.key) !== "arrowleft");
  assert.deepEqual(undeclaredKeys(keyComparisons(source), withoutRow), ["arrowleft"], "the ArrowLeft comparison has no row");
  assert.deepEqual(undeclaredKeys(keyComparisons(source), TABLE), [], "the table row of ArrowLeft does not clear the comparison");
});

test("a typeof test of a key property is not a key comparison", () => {
  const source = 'if (typeof params.key !== "string" || params.key === "") throw new TypeError("requires a key");\nif (event.key === "Enter") run();';
  assert.deepEqual([...keyComparisons(source)], ["enter"]);
});

test("the exposure spec table lists every shortcut and nothing else", () => {
  const rowOf = (entry) => [
    entry.key, entry.owner, entry.command, entry.menu ?? "—", entry.when,
  ];
  const expected = TABLE.map(rowOf).map((row) => row.join(" | ")).sort();
  const actual = specRows(EXPOSURE_EN, "## Keyboard shortcuts").map((row) => row.join(" | ")).sort();
  assert.deepEqual(actual, expected);
});

test("the Korean exposure spec table lists the same keys, owners, and commands", () => {
  const expected = TABLE.map((entry) => [entry.key, entry.owner, entry.command].join(" | ")).sort();
  const actual = specRows(EXPOSURE_KO, "## 키보드 단축키").map((row) => row.slice(0, 3).join(" | ")).sort();
  assert.deepEqual(actual, expected);
});

test("the exposure spec cites the machine-readable shortcut table", () => {
  assert.ok(EXPOSURE_EN.includes("packages/workbench/shortcuts.json"));
  assert.ok(EXPOSURE_KO.includes("packages/workbench/shortcuts.json"));
});
