// Checks the event catalog of this repository (docs/spec/logging.md#catalog, docs/spec/events.json):
//   node scripts/check-events.mjs                  every emit site of the sources names a declared event with its level and
//                                                  fields, and every declared event has an emit site;
//   node scripts/check-events.mjs --logs DIR...    the event files of every layer under DIR/logs (the configuration folders
//                                                  that the window checks used) hold only declared events with their required
//                                                  fields, consecutive seq across generations and the debug file, complete
//                                                  chains and no error event.
// The first form runs in `make check-events`; its rules are in the kit, which every repository
// calls as `sok-check events`. The second form audits configuration folders without the judgment of tests;
// `node scripts/audit-run.mjs <run folder>` audits a run and judges each test by the log.
import { parseArgs } from 'node:util';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { auditLogs } from '../packages/log-contract/index.js';
import { catalogOf } from '@soksak/window-check/catalog.mjs';
import { catalogReport, trackedSources } from '@soksak/kit/events';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const CATALOG = 'docs/spec/events.json';
// The event source declaration of this repository: its emitters, its excluded paths and its entrances (docs/spec/logging.md#event-sources).
const EVENT_SOURCES = 'scripts/event-sources.json';

/** The text of the tracked sources of this repository that can emit events, by path. */
export const repositorySources = () => trackedSources(ROOT);

// The catalog join of a configuration folder is the one of @soksak/window-check, whose release the checks of a plugin repository use.
export { catalogOf, installedPluginCatalogs, installedSidecarCatalogs } from '@soksak/window-check/catalog.mjs';

/** The event files of every layer (`<role>-<pid>-<time>`: the host, `sok` and each sidecar), generation and debug file of a configuration folder, in name order. */
export function eventFiles(directory) {
  const logs = join(directory, 'logs');
  let names;
  try {
    names = readdirSync(logs);
  } catch (error) {
    throw new Error(`${logs}: ${error.message}`, { cause: error });
  }
  const files = names.filter((name) => /^[a-z][a-z0-9]*-\d+-\d+(\.debug)?\.jsonl(\.[1-9]\d*)?$/.test(name)).sort().map((name) => join(logs, name));
  if (files.length === 0) throw new Error(`${logs}: no host event file`);
  return files.filter((path) => statSync(path).isFile());
}

/** The findings `<file>:<line>: <message>` of the event files of the configuration folders; an `error` event is a finding. */
export function auditLogDirectories(catalog, directories) {
  return directories.flatMap((directory) => {
    const logs = eventFiles(directory).map((file) => ({ file, text: readFileSync(file, 'utf8') }));
    return auditLogs(logs, catalogOf(catalog, directory)).map(({ file, line, message }) => `${file}:${line}: ${message}`);
  });
}

function main(argv) {
  const { values, positionals } = parseArgs({ args: argv, options: { logs: { type: 'boolean', default: false } }, allowPositionals: true, strict: true });
  if (!values.logs && positionals.length > 0) throw new Error(`folders are given only with --logs: ${positionals.join(' ')}`);
  if (values.logs) {
    const catalog = JSON.parse(readFileSync(join(ROOT, CATALOG), 'utf8'));
    const directories = positionals;
    if (directories.length === 0) throw new Error('--logs needs the configuration folders to audit');
    const findings = auditLogDirectories(catalog, directories);
    for (const finding of findings) process.stderr.write(`${finding}\n`);
    process.stdout.write(findings.length === 0 ? `Event log audit passed: ${directories.length} configuration folders\n` : `Event log audit failed: ${findings.length} findings\n`);
    return findings.length === 0 ? 0 : 1;
  }
  const { findings, declared, sites } = catalogReport(ROOT, CATALOG, EVENT_SOURCES);
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
