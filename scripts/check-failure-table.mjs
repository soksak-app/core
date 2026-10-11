// Checks that the failure table of docs/spec/diagnostics.md (and its translation) lists every error record that a host or
// the native library writes at a place the source spells out:
//   node scripts/check-failure-table.mjs
// The place of a record is the first argument of `LogError` (Go), `log_error` and `log_failure` (Rust) and `sp_log_error`
// (native). The check reads the literal text of that argument, cut where the call fills in the rest of the place (`%s`,
// `{name}`, or a string that the source concatenates), and requires the table to write `error <layer> <place>` followed by `:`
// or by the end of a code span, or by ` <` when the call fills in the rest. A place that a source takes from a variable or a
// constant (the path of a file, a label that a caller computed) has no literal text and is not read.
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { repositorySources } from "./check-events.mjs";

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const TABLES = ['docs/spec/diagnostics.md', 'docs/spec/diagnostics.ko.md'];
const LITERAL = '"((?:[^"\\\\]|\\\\.)*)"';

// What each language writes before the literal, where its call fills in the place, and the host or library that it belongs to.
const LANGUAGES = [
  { layer: 'host', path: /^packages\/host\/wailsv3\/src\/.*\.go$/, call: new RegExp(`\\bLogError\\(\\s*(?:fmt\\.Sprintf\\()?${LITERAL}(\\s*\\+)?`, 'g'), fills: /%/ },
  { layer: 'host', path: /^packages\/host\/tauriv2\/src\/.*\.rs$/, call: new RegExp(`\\b(?:log_error|log_failure)\\(\\s*(?:&format!\\()?${LITERAL}`, 'g'), fills: /\{/ },
  { layer: 'native', path: /^native\/darwin\/src\/.*\.m$/, call: new RegExp(`\\bsp_log_error\\(\\s*@?${LITERAL}`, 'g'), fills: /(?!)/ },
];

/** The error records at literal places in `sources` (a map of path to text): `{layer, place, filled, path}` in source order. */
export function failureSites(sources) {
  const sites = [];
  for (const [path, text] of sources) {
    for (const language of LANGUAGES) {
      if (!language.path.test(path)) continue;
      for (const match of text.matchAll(language.call)) {
        const cut = match[1].search(language.fills);
        const place = (cut < 0 ? match[1] : match[1].slice(0, cut)).trim();
        sites.push({ layer: language.layer, place, filled: cut >= 0 || /\s$/.test(match[1]) || Boolean(match[2]), path });
      }
    }
  }
  return sites;
}

/** The error records at literal places in the tracked sources of this repository. */
export const trackedFailureSites = () => failureSites(repositorySources());

/** The failure table of a diagnostics document: the text between its table header and the section that follows it. */
export function failureTable(markdown) {
  const start = markdown.search(/^\| (Failure|실패) \|/m);
  const end = markdown.search(/^## (Reading|읽기)/m);
  if (start < 0 || end < start) throw new Error('the diagnostics document has no failure table before its reading section');
  return markdown.slice(start, end);
}

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The records (`error <layer> <place>`, with ` <` after a filled place) that `table` does not write, once each. */
export function recordsMissingFromTable(sites, table) {
  const missing = [];
  for (const { layer, place, filled } of sites) {
    const record = `error ${layer} ${place}${filled ? ' <' : ''}`;
    const written = new RegExp(`${escape(`error ${layer} ${place}`)}${filled ? ' <' : '(?=[:`])'}`);
    if (!written.test(table) && !missing.includes(record)) missing.push(record);
  }
  return missing;
}

function main() {
  const sites = trackedFailureSites();
  let findings = 0;
  for (const file of TABLES) {
    const table = failureTable(readFileSync(`${ROOT}${file}`, 'utf8'));
    for (const record of recordsMissingFromTable(sites, table)) {
      process.stderr.write(`${file}: the failure table does not list \`${record}\`\n`);
      findings++;
    }
  }
  process.stdout.write(findings === 0 ? `Failure table checks passed: ${sites.length} error records\n` : `Failure table checks failed: ${findings} records\n`);
  return findings === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
