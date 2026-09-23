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

const REQUIRED_OSC_ROWS = [
  "0,2", "1,3", "4", "5,6", "10-12", "13-19,21,22,46", "50", "51", "52",
  "60-62", "104", "105,106", "110-112", "I,l,L", "7,8,9,133", "1337",
];

export function auditTerminalProtocolInventory({ engineSource = engine, testSource = tests, specSource = specification } = {}) {
  const errors = [];
  if (!specSource.includes("XTerm control sequences, patch 411, 2026-08-23")) {
    errors.push("pinned XTerm patch 411 reference is missing");
  }
  if (!specSource.includes("CSI: every standard final byte, parameter form, private mode, and device-response sequence")) {
    errors.push("specification does not state the complete CSI inventory contract");
  }

  const rows = [...engineSource.matchAll(/CsiSelectorEvidence \{\s*selector: "([^"]+)",\s*outcome: CsiOutcome::(Implemented|Unsupported),\s*test: "([^"]+)",?\s*\}/g)]
    .map(([, selector, outcome, test]) => ({ selector, outcome, test }));
  const oscRows = [...engineSource.matchAll(/OscSelectorEvidence \{\s*selector: "([^"]+)",\s*outcome: OscOutcome::(Implemented|Unsupported|Vendor),\s*test: "([^"]+)",?\s*\}/g)]
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
  const seenOsc = new Set();
  for (const row of oscRows) {
    if (seenOsc.has(row.selector)) errors.push(`duplicate OSC selector row: ${row.selector}`);
    seenOsc.add(row.selector);
    if (!testSource.includes(`fn ${row.test}(`)) errors.push(`${row.selector}: named OSC test is missing: ${row.test}`);
  }
  for (const selector of REQUIRED_OSC_ROWS) {
    if (!seenOsc.has(selector)) errors.push(`required OSC inventory row is missing: ${selector}`);
  }
  return { errors, rowCount: rows.length, oscRowCount: oscRows.length };
}

const result = auditTerminalProtocolInventory();
if (result.errors.length > 0) {
  for (const error of result.errors) console.error(`FAIL terminal protocol inventory: ${error}`);
  process.exitCode = 1;
} else {
  console.log(`PASS terminal protocol inventory: ${result.rowCount} unique CSI rows and ${result.oscRowCount} unique OSC rows with named tests`);
}
