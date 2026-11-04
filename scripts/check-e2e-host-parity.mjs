import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The window checks of the e2e folder; the unit tests of their helpers are in e2e/test/ (docs/operations/examples.md#test-kinds).
const ROOT = new URL("../e2e/", import.meta.url);

/** Whether a window check names the applications in any other way than the whole of Object.values(APPS). */
function iteratesOtherSet(source) {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/^import\s[^;]*;/gm, "");
  return /\bAPPS\b/.test(code.replace(/Object\.values\(APPS\)(?!\s*\.\s*(?:filter|find|findLast|slice|at)\b)/g, ""));
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
      errors.push(`${file}: app behavior test does not import APPS`);
      continue;
    }
    if (!/Object\.values\(APPS\)|\bMAIN_PAGE_APPS\b/.test(source)) {
      errors.push(`${file}: app behavior test does not iterate the applications through Object.values(APPS) or MAIN_PAGE_APPS`);
      continue;
    }
    if (iteratesOtherSet(source)) {
      errors.push(`${file}: window check iterates a set other than Object.values(APPS) and MAIN_PAGE_APPS`);
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
