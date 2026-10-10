// Checks the event catalog of this repository (docs/spec/logging.md#catalog, docs/spec/events.json):
//   node scripts/check-events.mjs                  every declared event is named by a source of this repository;
//   node scripts/check-events.mjs --logs DIR...    the host event files under DIR/logs (the configuration folders that the
//                                                  window checks used) hold only declared events with their required fields.
// The first form runs in `make events-check`. The second form is the log audit that follows the window checks.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { auditLog } from '../packages/log-contract/index.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const CATALOG = 'docs/spec/events.json';
const SOURCE_EXTENSIONS = /\.(go|rs|m|js|mjs)$/;
// A source that emits an event is not a test, a fixture, a generated frontend or a script of this repository.
const NOT_SOURCES = /(^|\/)(tests?|fixtures|node_modules|dist|benches|scripts)\/|\/src\/frontend\/|\.test\.mjs$|_test\.(go|rs|m)$/;

/** The text of the tracked sources that can emit events, by path. */
export function trackedSources() {
  const files = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n')
    .filter((path) => SOURCE_EXTENSIONS.test(path) && !NOT_SOURCES.test(path));
  return new Map(files.map((path) => [path, readFileSync(join(ROOT, path), 'utf8')]));
}

/**
 * The declared event names that no source names. A name with a placeholder is looked for by the text before its first
 * placeholder, because a source builds the rest of the name.
 */
export function declaredWithoutSource(catalog, sources) {
  const texts = [...sources.values()];
  return Object.keys(catalog.events).filter((name) => {
    const prefix = name.split('<')[0];
    // A host builds the layer part of a record name from the layer of the record, so the text after the layer names it too.
    const tail = prefix.slice(prefix.indexOf('.'));
    return !texts.some((text) => text.includes(prefix) || (tail.length > 1 && text.includes(tail)));
  });
}

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
  const catalog = JSON.parse(readFileSync(join(ROOT, CATALOG), 'utf8'));
  const logsIndex = argv.indexOf('--logs');
  if (logsIndex >= 0) {
    const directories = argv.slice(logsIndex + 1);
    if (directories.length === 0) throw new Error('--logs needs the configuration folders to audit');
    const findings = auditLogDirectories(catalog, directories);
    for (const finding of findings) process.stderr.write(`${finding}\n`);
    process.stdout.write(findings.length === 0 ? `Event log audit passed: ${directories.length} configuration folders\n` : `Event log audit failed: ${findings.length} findings\n`);
    return findings.length === 0 ? 0 : 1;
  }
  const missing = declaredWithoutSource(catalog, trackedSources());
  for (const name of missing) process.stderr.write(`${CATALOG}: ${name} is declared and no source names it\n`);
  process.stdout.write(missing.length === 0 ? `Event catalog checks passed: ${Object.keys(catalog.events).length} declared events\n` : `Event catalog checks failed: ${missing.length} declared events have no source\n`);
  return missing.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
