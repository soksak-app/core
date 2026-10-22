// Audits one event log with the event contract (docs/spec/logging.md) and prints the findings as a JSON array.
//
//   node scripts/audit-log.mjs <log file> <catalog file>
//
// The host tests run this command on the logs they write, so that a test reads no file of the log-contract package.
import { readFileSync } from "node:fs";
import { auditLog } from "../packages/log-contract/index.js";

const [log, catalog] = process.argv.slice(2);
if (!log || !catalog) {
  console.error("usage: node scripts/audit-log.mjs <log file> <catalog file>");
  process.exit(2);
}
console.log(JSON.stringify(auditLog(log, readFileSync(log, "utf8"), JSON.parse(readFileSync(catalog, "utf8")))));
