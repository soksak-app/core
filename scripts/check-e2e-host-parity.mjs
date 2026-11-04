import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The window checks of the e2e folder; the unit tests of their helpers are in e2e/test/ (docs/operations/examples.md#test-kinds).
const ROOT = new URL("../e2e/", import.meta.url);

// A window check iterates the applications of the session, Object.values(APPS), or, when its subject is the main page or a
// modal web view, the applications that have one, MAIN_PAGE_APPS (docs/operations/examples.md#window-checks). These
// operations go over every application of such a list; any other use of APPS or MAIN_PAGE_APPS selects a part of it.
const EVERY = new Set(["forEach", "map", "flatMap", "reduce", "every", "some"]);
const COLLECTION = /\bObject\.(\w+)\(\s*APPS\s*\)|\bMAIN_PAGE_APPS\b|\bAPPS\b/g;

/** The source with its import statements and comments replaced by blank text of the same lines. */
function code(source) {
  const blank = (text) => text.replace(/[^\n]/g, " ");
  return source
    .replace(/^import\s[^;]*;/gm, blank)
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|\s)\/\/[^\n]*/g, (text, space) => space + blank(text.slice(space.length)));
}

/** The uses of APPS and MAIN_PAGE_APPS in the code that select a part of the applications, as `<line>: <expression>`. */
function selections(text) {
  const found = [];
  for (const match of text.matchAll(COLLECTION)) {
    const line = text.slice(0, match.index).split("\n").length;
    const whole = match[1] === "values" || match[0] === "MAIN_PAGE_APPS";
    if (match[1] !== undefined && !whole) {
      found.push(`${line}: ${match[0].replace(/\s+/g, "")}`);
      continue;
    }
    const next = /^\s*(?:\.\s*(\w+)|(\[))/.exec(text.slice(match.index + match[0].length));
    const expression = match[1] === "values" ? "Object.values(APPS)" : match[0];
    if (next?.[2]) found.push(`${line}: ${expression}[`);
    else if (next?.[1] && !(whole && EVERY.has(next[1]))) found.push(`${line}: ${expression}.${next[1]}`);
    else if (!whole && !next) found.push(`${line}: ${expression}`);
  }
  return found;
}

export function auditE2EHostParity(
  files = readdirSync(ROOT).filter((file) => file.endsWith(".test.mjs")),
  read = (file) => readFileSync(new URL(file, ROOT), "utf8"),
) {
  const errors = [];
  const shared = [];
  for (const file of files.sort()) {
    const source = read(file);
    if (!/import\s*\{[^}]*\b(APPS|MAIN_PAGE_APPS)\b[^}]*\}\s*from\s+["']@soksak\/window-check\/app\.mjs["']/.test(source)) {
      errors.push(`${file}: app behavior test imports neither APPS nor MAIN_PAGE_APPS`);
      continue;
    }
    const text = code(source);
    const selected = selections(text);
    for (const item of selected) {
      const [line, expression] = item.split(": ");
      errors.push(`${file}:${line}: window check selects ${expression}; it iterates Object.values(APPS) or MAIN_PAGE_APPS`);
    }
    if (selected.length) continue;
    if (!/Object\.values\(\s*APPS\s*\)|\bMAIN_PAGE_APPS\b/.test(text)) {
      errors.push(`${file}: app behavior test iterates neither Object.values(APPS) nor MAIN_PAGE_APPS`);
      continue;
    }
    shared.push(file);
  }
  return { errors, shared };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = auditE2EHostParity();
  if (result.errors.length > 0) {
    console.error(`E2E host parity audit failed: ${result.errors.length} issue(s)`);
    for (const error of result.errors) console.error(`- ${error}`);
    process.exitCode = 1;
  } else {
    console.log(`E2E host parity audit passed: ${result.shared.length} shared app suites`);
  }
}
