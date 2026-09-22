import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const engine = readFileSync(`${ROOT}sidecars/vt-alacritty/src/engine.rs`, "utf8");
const tests = readFileSync(`${ROOT}sidecars/vt-alacritty/tests/engine_test.rs`, "utf8");
const specification = readFileSync(`${ROOT}docs/spec/terminal-protocols.md`, "utf8");

const REQUIRED_ROWS = [
  "A/B/C/D/G/H/f/s/u",
  "E/F",
  "?12h/l",
  "?25h/l",
  "0,7 SP q",
  "1-6 SP q",
  "CSI framing",
  "m",
  "?1049h/l",
  "S/T;r",
  "J/K",
  "@/P",
  "L/M",
  "I/Z",
  "6n/c",
  "5n/6n",
  "c/>c",
  "b",
  "14t",
  "other t",
  "rectangle/protected/palette",
  "?47/?1047/?1048h/l",
  "?1,?1000,?1002,?1003,?1004,?1005,?1006,?1007,?2004 h/l",
  "ESC =/>",
];

export function auditTerminalProtocolInventory({ engineSource = engine, testSource = tests, specSource = specification } = {}) {
  const errors = [];
  if (!specSource.includes("XTerm control sequences, patch 411, 2026-08-23")) {
    errors.push("pinned XTerm patch 411 reference is missing");
  }
  if (!specSource.includes("CSI: every standard final byte, parameter form, private mode, and device-response sequence")) {
    errors.push("specification does not state the complete CSI inventory contract");
  }

  const rows = [...engineSource.matchAll(/CsiSelectorEvidence \{ selector: "([^"]+)", outcome: CsiOutcome::(Implemented|Unsupported), test: "([^"]+)" \}/g)]
    .map(([, selector, outcome, test]) => ({ selector, outcome, test }));
  const seen = new Set();
  for (const row of rows) {
    if (seen.has(row.selector)) errors.push(`duplicate CSI selector row: ${row.selector}`);
    seen.add(row.selector);
    if (!testSource.includes(`fn ${row.test}(`)) errors.push(`${row.selector}: named test is missing: ${row.test}`);
  }
  for (const selector of REQUIRED_ROWS) {
    if (!seen.has(selector)) errors.push(`required CSI inventory row is missing: ${selector}`);
  }
  return { errors, rowCount: rows.length };
}

const result = auditTerminalProtocolInventory();
if (result.errors.length > 0) {
  for (const error of result.errors) console.error(`FAIL terminal protocol inventory: ${error}`);
  process.exitCode = 1;
} else {
  console.log(`PASS terminal protocol inventory: ${result.rowCount} unique CSI rows with named tests`);
}
