// The performance goals of the three hosts (docs/spec/hosts.md#performance-goals): docs/spec/performance-goals.json holds their
// numeric bounds, and the tables of the section Performance goals of docs/spec/hosts.md and of docs/spec/hosts.ko.md are copies of
// that file. Each test renders the rows of the file in the language of a document and compares them with the rows of its tables.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const FILE = "docs/spec/performance-goals.json";
const read = (path) => readFileSync(join(ROOT, path), "utf8");

/** The words of the rendered rows in each language. */
const WORDS = {
  en: {
    conditions: {
      runs: (n) => ["Runs of each application in a session", `${n}`],
      refreshRate: (n) => ["Refresh rate of the display mode", `${n} Hz`],
      backingScale: (n) => ["Backing scale of each window", `${n}`],
      swapUseBelow: (n) => ["Swap use at the start of a run", `below ${n} of the swap total`],
      fseventsdCoreBelow: (n) => ["CPU share of `fseventsd` at the start of a run", `below ${n} of a core`],
    },
    over: { median: "median", each: "each run" },
    bound: {
      equals: (n, unit) => (unit === "verdict" ? n : `equals ${n}`),
      atMost: (n, unit) => `at most ${n} ${unit}`,
      atLeast: (n, unit) => `at least ${n} ${unit}`,
      below: (n, unit) => `below ${n} ${unit}`,
    },
    relative: "each other host and baseline host",
  },
  ko: {
    conditions: {
      runs: (n) => ["session에서 각 application의 run 수", `${n}`],
      refreshRate: (n) => ["display mode의 refresh rate", `${n} Hz`],
      backingScale: (n) => ["각 window의 backing scale", `${n}`],
      swapUseBelow: (n) => ["run 시작 시 swap 사용량", `swap 전체의 ${n} 미만`],
      fseventsdCoreBelow: (n) => ["run 시작 시 `fseventsd`의 CPU 비율", `core 하나의 ${n} 미만`],
    },
    over: { median: "median", each: "각 run" },
    bound: {
      equals: (n, unit) => (unit === "verdict" ? n : `정확히 ${n}`),
      atMost: (n, unit) => `${n} ${unit} 이하`,
      atLeast: (n, unit) => `${n} ${unit} 이상`,
      below: (n, unit) => `${n} ${unit} 미만`,
    },
    relative: "각 other host와 baseline host",
  },
};

/** The rows of the run condition table and of the value table that the file gives in the language `lang`. */
function renderedRows(goals, lang) {
  const words = WORDS[lang];
  const condition = (key, n) => {
    const render = words.conditions[key];
    assert.ok(render, `${FILE} holds the condition ${key}, which the test does not render`);
    return render(n);
  };
  const conditions = [condition("runs", goals.runs), ...Object.entries(goals.conditions).map(([key, n]) => condition(key, n))];
  const values = goals.values.map((value) => {
    const entries = Object.entries(value.bound ?? {});
    assert.ok(entries.length <= 1, `${value.id} has ${entries.length} bounds`);
    const bound = entries.map(([kind, n]) => {
      const render = words.bound[kind];
      assert.ok(render, `${value.id} has the bound ${kind}, which the test does not render`);
      return `${render(n, value.unit)}${value.constant === undefined ? "" : ` (\`${value.constant}\`)`}`;
    })[0] ?? "—";
    const compared = value.relative ? words.relative : value.against === undefined ? "—" : `\`${value.against}\``;
    return [`\`${value.id}\``, value.goal, value.scenario, `\`${value.target}\``, value.unit, words.over[value.over], bound, compared];
  });
  return { conditions, values };
}

/** The cells of each table row of the section `## Performance goals` of a document, by table, without the header and rule rows. */
function documentTables(text, path) {
  const start = text.indexOf("\n## Performance goals\n");
  assert.notEqual(start, -1, `${path} has no section Performance goals`);
  const end = text.indexOf("\n## ", start + 1);
  const section = text.slice(start, end === -1 ? undefined : end);
  const tables = [];
  let rows = null;
  for (const line of section.split("\n")) {
    if (!line.startsWith("|")) {
      rows = null;
      continue;
    }
    if (rows === null) {
      rows = [];
      tables.push(rows);
      continue;
    }
    if (/^\|(?:\s*-+\s*\|)+$/.test(line)) continue;
    rows.push(line.slice(1, -1).split(/(?<!\\)\|/).map((cell) => cell.trim()));
  }
  return tables;
}

test("docs/spec/performance-goals.json names each value once and compares a value only with a value that it holds", { timeout: 1000 }, () => {
  const goals = JSON.parse(read(FILE));
  const ids = goals.values.map((value) => value.id);
  assert.deepEqual(ids.filter((id, index) => ids.indexOf(id) !== index), [], "these values are named twice");
  const unknown = goals.values.filter((value) => value.against !== undefined && !ids.includes(value.against)).map((value) => value.id);
  assert.deepEqual(unknown, [], "these values are compared with a value that the file does not hold");
  const constants = goals.values.filter((value) => value.constant !== undefined).map((value) => value.constant).sort();
  assert.deepEqual(constants, ["IDLE_TAB_BOUND_KB", "SPLIT_LOAD_GROWTH_BOUND_KB"]);
});

/** Compares the tables of the section Performance goals of the document `path` with the rows of the file in the language `lang`. */
function assertTablesCopy(lang, path) {
  const expected = renderedRows(JSON.parse(read(FILE)), lang);
  const tables = documentTables(read(path), path);
  assert.equal(tables.length, 2, `${path} has ${tables.length} tables in the section Performance goals, expected the run conditions and the values`);
  assert.deepEqual(tables[0], expected.conditions, `the run condition table of ${path} differs from ${FILE}`);
  assert.deepEqual(tables[1], expected.values, `the value table of ${path} differs from ${FILE}`);
}

test("the tables of the section Performance goals of docs/spec/hosts.md are copies of docs/spec/performance-goals.json", { timeout: 1000 }, () => {
  assertTablesCopy("en", "docs/spec/hosts.md");
});

test("the tables of the section Performance goals of docs/spec/hosts.ko.md are copies of docs/spec/performance-goals.json", { timeout: 1000 }, () => {
  assertTablesCopy("ko", "docs/spec/hosts.ko.md");
});
