import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../e2e/", import.meta.url);
const UNIT_ONLY = new Map([
  ["app-contract.test.mjs", "endpoint freshness is a client-side unit contract"],
  ["composition-measurement.test.mjs", "pixel and gesture measurement helpers are host-independent"],
  ["terminal-processes.test.mjs", "process-row parsing is host-independent"],
]);

export function auditE2EHostParity(
  files = readdirSync(ROOT).filter((file) => file.endsWith(".test.mjs")),
  read = (file) => readFileSync(new URL(file, ROOT), "utf8"),
) {
  const errors = [];
  const shared = [];
  const unitOnly = [];
  for (const file of files.sort()) {
    const source = read(file);
    const reason = UNIT_ONLY.get(file);
    if (reason) {
      unitOnly.push({ file, reason });
      continue;
    }
    if (!/import\s*\{[^}]*\bAPPS\b[^}]*\}\s*from\s+["']@soksak\/window-check\/app\.mjs["']/.test(source)) {
      errors.push(`${file}: app behavior test does not import APPS`);
      continue;
    }
    if (!/Object\.values\(APPS\)/.test(source)) {
      errors.push(`${file}: app behavior test does not iterate both adapters through Object.values(APPS)`);
      continue;
    }
    shared.push(file);
  }
  return { errors, shared, unitOnly };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = auditE2EHostParity();
  if (result.errors.length > 0) {
    console.error(`E2E host parity audit failed: ${result.errors.length} issue(s)`);
    for (const error of result.errors) console.error(`- ${error}`);
    process.exitCode = 1;
  } else {
    console.log(`E2E host parity audit passed: ${result.shared.length} shared app suites, ${result.unitOnly.length} explicit unit suites`);
  }
}
