// Checks the event catalog of this repository (docs/spec/logging.md#catalog, docs/spec/events.json):
//   node scripts/check-events.mjs                  every emit site of the sources names a declared event with its level and
//                                                  fields, and every declared event has an emit site;
//   node scripts/check-events.mjs --logs DIR...    the host event files under DIR/logs (the configuration folders that the
//                                                  window checks used) hold only declared events with their required fields.
// The first form runs in `make events-check`; its rules are in packages/plugin-api/events-check.js, which every repository
// calls as `soksak-events`. The second form is the log audit that follows the window checks.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { auditLog } from '../packages/log-contract/index.js';
import { catalogReport, trackedSources } from '../packages/plugin-api/events-check.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const CATALOG = 'docs/spec/events.json';

/** The text of the tracked sources of this repository that can emit events, by path. */
export const repositorySources = () => trackedSources(ROOT);

/** The host event files of a configuration folder. */
function eventFiles(directory) {
  const logs = join(directory, 'logs');
  let names;
  try {
    names = readdirSync(logs);
  } catch (error) {
    throw new Error(`${logs}: ${error.message}`, { cause: error });
  }
  const files = names.filter((name) => /^host-\d+-\d+\.jsonl(\.\d)?$/.test(name)).map((name) => join(logs, name));
  if (files.length === 0) throw new Error(`${logs}: no host event file`);
  return files.filter((path) => statSync(path).isFile());
}

/** The findings `<file>:<line>: <message>` of the host event files of the configuration folders. */
export function auditLogDirectories(catalog, directories) {
  const findings = [];
  for (const directory of directories) {
    for (const file of eventFiles(directory)) {
      for (const { line, message } of auditLog(file, readFileSync(file, 'utf8'), catalog)) findings.push(`${file}:${line}: ${message}`);
    }
  }
  return findings;
}

function main(argv) {
  const logsIndex = argv.indexOf('--logs');
  if (logsIndex >= 0) {
    const catalog = JSON.parse(readFileSync(join(ROOT, CATALOG), 'utf8'));
    const directories = argv.slice(logsIndex + 1);
    if (directories.length === 0) throw new Error('--logs needs the configuration folders to audit');
    const findings = auditLogDirectories(catalog, directories);
    for (const finding of findings) process.stderr.write(`${finding}\n`);
    process.stdout.write(findings.length === 0 ? `Event log audit passed: ${directories.length} configuration folders\n` : `Event log audit failed: ${findings.length} findings\n`);
    return findings.length === 0 ? 0 : 1;
  }
  const { findings, declared, sites } = catalogReport(ROOT, CATALOG);
  for (const finding of findings) process.stderr.write(`${finding}\n`);
  process.stdout.write(findings.length === 0 ? `Event catalog checks passed: ${declared} declared events, emit sites: ${sites}\n` : `Event catalog checks failed: ${findings.length} findings, emit sites: ${sites}\n`);
  return findings.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
