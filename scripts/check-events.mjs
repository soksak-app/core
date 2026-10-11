// Checks the event catalog of this repository (docs/spec/logging.md#catalog, docs/spec/events.json):
//   node scripts/check-events.mjs                  every emit site of the sources names a declared event with its level and
//                                                  fields, and every declared event has an emit site;
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

const LEVELS = ['error', 'warn', 'info', 'debug', 'trace'];
const CLASSES = ['lifecycle', 'input', 'call', 'io', 'frame'];
const TYPES = ['string', 'number', 'boolean', 'array', 'object', 'null'];
const LANGUAGES = { go: 'go', rs: 'rs', m: 'm', js: 'js', mjs: 'js' };
const FORWARDED = 'forwarded';
// A marker comment lies on the line of an emit whose name is built, or at most this many lines above it.
const MARKER_REACH = 5;

/**
 * The entrances that store an event, by language. `level`, `event` and `fields` are the positions of the arguments of the
 * call (`fields` is absent when the call has none); `fixed` is the level of an entrance that has no level argument; `only`
 * limits an entrance to the files it is local to.
 */
const ENTRANCES = {
  go: [
    { re: /\bEmitHost\s*\(/g, level: 0, event: 1, fields: 2 },
    { re: /\bstoreEvent\s*\(/g, level: 0, event: 2, fields: 4 },
  ],
  rs: [
    { re: /\bemit_host\s*\(/g, level: 0, event: 1, fields: 2 },
    { re: /\bstore_event\s*\(/g, level: 0, event: 2, fields: 4 },
  ],
  js: [
    { re: /(?:\bemitEvent|\bbatcher\??\.emit|\bbatcher\??\.emitAndWait|\.emitAndWait)\s*\(/g, level: 0, event: 1, fields: 2 },
  ],
  m: [
    { re: /\bsp_event\s*\(/g, level: 0, event: 1, fields: 2 },
    { re: /\bstoreRecord\s*\(/g, level: 0, event: 1 },
    { re: /\bemit\s*\(/g, fixed: 'info', event: 0, fields: 1, only: /(^|\/)activity_observers\.m$/ },
  ],
};
// The text before the name of a call on its line when the call is the definition of the function.
const DEFINITION_PREFIX = {
  go: /^\s*func\s+(\([^)]*\)\s*)?$/,
  rs: /\bfn\s+$/,
  js: /\bfunction\s+$/,
  m: /^\s*(static\s+)?(void|bool|BOOL)\s+$/,
};
const LEVEL_TOKEN = /\bLevel(Error|Warn|Info|Debug|Trace)\b|\bLevel::(Error|Warn|Info|Debug|Trace)\b|\bSP_EVENT_(ERROR|WARN|INFO|DEBUG|TRACE)\b|["'`](error|warn|info|debug|trace)["'`]/g;
const FIELD_OBJECT = {
  go: /^map\[string\](?:any|string|interface\{\})\s*\{/,
  rs: /^(?:to_raw_value\(&)?(?:serde_json::)?json!\s*\(\s*\{/,
  m: /^@\{/,
  js: /^\{/,
};
const FIELD_KEY = {
  go: /^"([^"]+)"\s*:/,
  rs: /^"([^"]+)"\s*:/,
  m: /^@"([^"]+)"\s*:/,
  js: /^(?:"([^"]+)"|'([^']+)'|([A-Za-z_$][\w$]*))\s*(?::|$)/,
};

/** The text of the tracked sources that can emit events, by path. */
export function trackedSources() {
  const files = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n')
    .filter((path) => SOURCE_EXTENSIONS.test(path) && !NOT_SOURCES.test(path));
  return new Map(files.map((path) => [path, readFileSync(join(ROOT, path), 'utf8')]));
}

/**
 * Reads a source into `code` (the text with each comment blanked and its line breaks kept), `inString` (1 for each
 * character of a string, quotes included) and the `markers` (the comments `events: <names>`).
 */
function lex(path, text, language) {
  const code = text.split('');
  const inString = new Uint8Array(text.length);
  const markers = [];
  const lineAt = (offset) => text.slice(0, offset).split('\n').length;
  const blank = (from, to) => { for (let k = from; k < to; k += 1) if (code[k] !== '\n') code[k] = ' '; };
  const fail = (offset, what) => { throw new Error(`${path}:${lineAt(offset)}: ${what}`); };
  const skipQuoted = (from, quote) => {
    let k = from + 1;
    while (k < text.length && text[k] !== quote) k += text[k] === '\\' ? 2 : 1;
    if (k >= text.length) fail(from, 'a string that starts here does not end');
    return k + 1;
  };
  // Returns the offset after the template that starts at `from`; its `${…}` expressions are part of it.
  const skipTemplate = (from) => {
    let k = from + 1;
    while (k < text.length && text[k] !== '`') {
      if (text[k] === '\\') k += 2;
      else if (text[k] === '$' && text[k + 1] === '{') {
        let depth = 1;
        k += 2;
        while (k < text.length && depth > 0) {
          if (text[k] === '"' || text[k] === "'") k = skipQuoted(k, text[k]);
          else if (text[k] === '`') k = skipTemplate(k);
          else {
            depth += text[k] === '{' ? 1 : text[k] === '}' ? -1 : 0;
            k += 1;
          }
        }
      } else k += 1;
    }
    if (k >= text.length) fail(from, 'a template that starts here does not end');
    return k + 1;
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    let end;
    if (c === '/' && text[i + 1] === '/') {
      end = text.indexOf('\n', i);
      if (end < 0) end = text.length;
      const marker = /^events:\s*(.+?)\s*$/.exec(text.slice(i, end).replace(/^\/\/[/!]?\s*/, ''));
      if (marker) markers.push({ line: lineAt(i), names: marker[1].split(/[,\s]+/).filter(Boolean) });
      blank(i, end);
    } else if (c === '/' && text[i + 1] === '*') {
      end = text.indexOf('*/', i + 2);
      if (end < 0) fail(i, 'a comment that starts here does not end');
      end += 2;
      blank(i, end);
    } else if (c === '/' && language === 'js' && /(?:^|[(,=:[!&|?{};+\-*%<>~^]|\breturn|\btypeof)\s*$/.test(text.slice(Math.max(0, i - 12), i))) {
      // A regular expression literal: its quotes and backticks are not strings.
      end = i + 1;
      let inClass = false;
      while (end < text.length && (inClass || text[end] !== '/')) {
        if (text[end] === '\\') end += 1;
        else if (text[end] === '[') inClass = true;
        else if (text[end] === ']') inClass = false;
        else if (text[end] === '\n') fail(i, 'a regular expression that starts here does not end');
        end += 1;
      }
      end += 1;
      inString.fill(1, i, end);
    } else if (c === '"') {
      end = skipQuoted(i, '"');
      inString.fill(1, i, end);
    } else if (c === '`' && language === 'js') {
      end = skipTemplate(i);
      inString.fill(1, i, end);
    } else if (c === '`' && language === 'go') {
      end = text.indexOf('`', i + 1);
      if (end < 0) fail(i, 'a string that starts here does not end');
      end += 1;
      inString.fill(1, i, end);
    } else if (c === "'" && language === 'js') {
      end = skipQuoted(i, "'");
      inString.fill(1, i, end);
    } else if (c === "'") {
      // A character literal of Go, Rust and Objective-C; in Rust a lifetime has no closing quote and is left alone.
      const literal = /^'(?:\\[^']*|[^\\'])'/.exec(text.slice(i, i + 12));
      end = i + (literal ? literal[0].length : 1);
      if (literal) inString.fill(1, i, end);
    } else if (language === 'rs' && c === 'r' && /^r#*"/.test(text.slice(i, i + 12)) && !/\w/.test(text[i - 1] ?? '')) {
      const hashes = /^r(#*)"/.exec(text.slice(i, i + 12))[1];
      end = text.indexOf(`"${hashes}`, i + 2 + hashes.length);
      if (end < 0) fail(i, 'a raw string that starts here does not end');
      end += 1 + hashes.length;
      inString.fill(1, i, end);
    } else end = i + 1;
    i = end;
  }
  return { code: code.join(''), inString, markers, lineAt };
}

/** The offset of the bracket that closes the one at `open`. */
function matchClose(source, open) {
  const { code, inString } = source;
  let depth = 0;
  for (let k = open; k < code.length; k += 1) {
    if (inString[k]) continue;
    if ('([{'.includes(code[k])) depth += 1;
    else if (')]}'.includes(code[k])) {
      depth -= 1;
      if (depth === 0) return k;
    }
  }
  throw new Error(`${source.path}:${source.lineAt(open)}: a bracket that opens here does not close`);
}

/** The ranges `[start, end)` of the parts of `from..to` that commas separate outside brackets and strings, without blanks. */
function splitTop(source, from, to) {
  const { code, inString } = source;
  const parts = [];
  let depth = 0;
  let start = from;
  for (let k = from; k < to; k += 1) {
    if (inString[k]) continue;
    if ('([{'.includes(code[k])) depth += 1;
    else if (')]}'.includes(code[k])) depth -= 1;
    else if (code[k] === ',' && depth === 0) {
      parts.push([start, k]);
      start = k + 1;
    }
  }
  parts.push([start, to]);
  return parts.map(([a, b]) => {
    let x = a;
    let y = b;
    while (x < y && /\s/.test(code[x])) x += 1;
    while (y > x && /\s/.test(code[y - 1])) y -= 1;
    return [x, y];
  }).filter(([a, b]) => b > a);
}

/** The form of a name or family in which every placeholder is `*`. */
const normal = (name) => name.replace(/<[a-z_]+>|\*/g, '*');

/** The key of the catalog entry that declares `name`: the name itself, or the family whose pattern it matches. */
function declaredKey(catalog, name) {
  if (Object.hasOwn(catalog.events, name)) return name;
  const families = Object.keys(catalog.events).filter((key) => key.includes('<'));
  const same = families.find((key) => normal(key) === normal(name));
  if (same !== undefined) return same;
  if (name.includes('*') || name.includes('<')) return undefined;
  return families.find((key) => {
    const pattern = key.split(/<[a-z_]+>/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[a-z0-9_.]+');
    return new RegExp(`^${pattern}$`).test(name);
  });
}

/** The name that an expression gives literally (a template of a page as a family with `*`), or null when it is built. */
function literalName(source, [from, to]) {
  const expression = source.code.slice(from, to);
  const quoted = /^@?"((?:[^"\\]|\\.)*)"(?:\.(?:into|to_string|to_owned)\(\))?$/.exec(expression)
    ?? (source.language === 'js' ? /^'((?:[^'\\]|\\.)*)'$/.exec(expression) : null);
  if (quoted) return quoted[1];
  const template = source.language === 'js' ? /^`([^`]*)`$/.exec(expression) : null;
  return template ? template[1].replace(/\$\{[^}]*\}/g, '*') : null;
}

/** The levels that an expression names literally, or null when it names none. */
function levelsOf(source, range) {
  if (range === undefined) return null;
  const found = [...source.code.slice(...range).matchAll(LEVEL_TOKEN)].map((match) => (match[1] ?? match[2] ?? match[3] ?? match[4]).toLowerCase());
  return found.length === 0 ? null : [...new Set(found)];
}

/**
 * The keys of the object that an expression writes literally, as `{keys, open}`; `open` is true when the object also holds a
 * part that is no literal key (a spread or a computed key). It is null for an expression that is no object literal.
 */
function fieldsOf(source, range) {
  if (range === undefined) return null;
  const { code, language } = source;
  const [from, to] = range;
  if (language === 'go' && code.slice(from, to) === 'nil') return { keys: [], open: false };
  const opening = FIELD_OBJECT[language].exec(code.slice(from, to));
  if (!opening) return null;
  const open = from + opening[0].length - 1;
  const keys = [];
  let isOpen = false;
  for (const [a, b] of splitTop(source, open + 1, matchClose(source, open))) {
    const key = FIELD_KEY[language].exec(code.slice(a, b));
    if (key) keys.push(key[1] ?? key[2] ?? key[3]);
    else isOpen = true;
  }
  return { keys, open: isOpen };
}

/** The offset of the `{` that holds the offset `at`, or -1. */
function enclosingBrace(source, at) {
  let depth = 0;
  for (let k = at - 1; k >= 0; k -= 1) {
    if (source.inString[k]) continue;
    if (')]}'.includes(source.code[k])) depth += 1;
    else if ('([{'.includes(source.code[k])) {
      if (depth === 0) return source.code[k] === '{' ? k : -1;
      depth -= 1;
    }
  }
  return -1;
}

/**
 * The sites of one source where an event is stored, as `{line, call, name, levels, fields}` (`name` is null when the site
 * builds it), and the markers of the source.
 */
function sitesOf(path, text) {
  const language = LANGUAGES[path.slice(path.lastIndexOf('.') + 1)];
  const source = { path, language, ...lex(path, text, language) };
  const { code, inString } = source;
  const sites = [];
  for (const entrance of ENTRANCES[language]) {
    if (entrance.only && !entrance.only.test(path)) continue;
    for (const match of code.matchAll(entrance.re)) {
      if (inString[match.index]) continue;
      if (DEFINITION_PREFIX[language].test(code.slice(code.lastIndexOf('\n', match.index - 1) + 1, match.index))) continue;
      const open = match.index + match[0].length - 1;
      const args = splitTop(source, open + 1, matchClose(source, open));
      if (args[entrance.event] === undefined) throw new Error(`${path}:${source.lineAt(match.index)}: ${match[0]} has no argument ${entrance.event + 1}`);
      sites.push({
        line: source.lineAt(args[entrance.event][0]),
        call: source.lineAt(match.index),
        name: literalName(source, args[entrance.event]),
        levels: entrance.fixed ? [entrance.fixed] : levelsOf(source, args[entrance.level]),
        fields: fieldsOf(source, args[entrance.fields]),
      });
    }
  }
  // A record literal that holds `level`, `event` and `fields` is a site too: the pending events of the writers and the batcher.
  for (const match of code.matchAll(/\bevent\s*:/g)) {
    if (inString[match.index]) continue;
    const open = enclosingBrace(source, match.index);
    if (open < 0) continue;
    const entries = new Map();
    for (const [a, b] of splitTop(source, open + 1, matchClose(source, open))) {
      const entry = /^([A-Za-z_]\w*)\s*(?::\s*)?/.exec(code.slice(a, b));
      if (entry) entries.set(entry[1], [a + entry[0].length, b]);
    }
    if (!['level', 'event', 'fields'].every((key) => entries.has(key))) continue;
    const name = literalName(source, entries.get('event'));
    if (name === null) continue;
    sites.push({
      line: source.lineAt(match.index),
      call: source.lineAt(match.index),
      name,
      levels: levelsOf(source, entries.get('level')),
      fields: fieldsOf(source, entries.get('fields')),
    });
  }
  return { sites: sites.sort((a, b) => a.line - b.line), markers: source.markers };
}

/** The findings of the catalog itself: each entry has a layer the catalog lists, a class, levels and field types of the contract. */
export function catalogFindings(catalog) {
  const findings = [];
  for (const [name, entry] of Object.entries(catalog.events)) {
    const report = (message) => findings.push(`${CATALOG}: ${name} ${message}`);
    if (!catalog.layers.includes(entry.layer)) report(`has the layer ${entry.layer}, which the catalog does not list`);
    else if (!name.startsWith(`${entry.layer}.`) && !name.startsWith('log.')) report(`has the layer ${entry.layer} and a name that starts with neither ${entry.layer}. nor log.`);
    if (!CLASSES.includes(entry.class)) report(`has the class ${entry.class}, which is not one of ${CLASSES.join(', ')}`);
    for (const level of [entry.level].flat()) {
      if (!LEVELS.includes(level)) report(`has the level ${level}, which is not one of ${LEVELS.join(', ')}`);
    }
    for (const [field, type] of Object.entries(entry.fields)) {
      if (!String(type).split('|').every((part) => TYPES.includes(part))) {
        report(`has the field ${field.replace(/\?$/, '')} of type ${type}, which is not ${TYPES.slice(0, -1).join(', ')} or ${TYPES.at(-1)}`);
      }
    }
  }
  return findings;
}

/** The number of emit sites by language, as `{literal, built}`: sites that give their name, and sites that build it. */
export function siteCounts(sources) {
  const counts = {};
  for (const [path, text] of sources) {
    const language = LANGUAGES[path.slice(path.lastIndexOf('.') + 1)];
    counts[language] ??= { literal: 0, built: 0 };
    for (const site of sitesOf(path, text).sites) counts[language][site.name === null ? 'built' : 'literal'] += 1;
  }
  return counts;
}

/**
 * The findings of the emit sites of the sources against the catalog, in both directions: an emitted name that the catalog
 * does not declare, a declared name that no site emits, and the level and the fields of a literal site that differ from the
 * declaration. A site gives its name literally (a string, or a template of a page), or a comment `events: <declared names>`
 * above it names what it builds, or `events: forwarded` states that it passes on the name of its caller.
 */
export function emitFindings(catalog, sources) {
  const findings = [];
  const emitted = new Set();
  for (const [path, text] of sources) {
    const { sites, markers } = sitesOf(path, text);
    const found = [];
    const report = (line, message) => found.push({ line, message: `${path}:${line}: ${message}` });
    const claimed = new Set();
    for (const site of sites) {
      if (site.name === null) {
        const own = markers.filter((marker) => marker.line <= site.call && site.call - marker.line <= MARKER_REACH);
        if (own.length === 0) {
          report(site.line, 'the name of this emit is not a literal; write a comment `events: <declared names>` above it, or `events: forwarded` when it passes the name of its caller');
        }
        own.forEach((marker) => claimed.add(marker));
        continue;
      }
      const key = declaredKey(catalog, site.name);
      if (key === undefined) {
        report(site.line, `${site.name} is emitted and ${CATALOG} does not declare it`);
        continue;
      }
      emitted.add(key);
      const entry = catalog.events[key];
      const declaredLevels = [entry.level].flat();
      if (site.levels !== null && site.levels.some((level) => !declaredLevels.includes(level))) {
        report(site.line, `${site.name} is emitted at the level ${site.levels.join(', ')} and the catalog declares ${declaredLevels.join(', ')}`);
      }
      if (site.fields !== null) {
        const declared = Object.keys(entry.fields).map((field) => field.replace(/\?$/, ''));
        if (!site.fields.open) {
          for (const field of Object.keys(entry.fields).filter((name) => !name.endsWith('?'))) {
            if (!site.fields.keys.includes(field)) report(site.line, `${site.name} lacks the field ${field} that the catalog requires`);
          }
        }
        for (const field of site.fields.keys.filter((name) => !declared.includes(name))) {
          report(site.line, `${site.name} has the field ${field}, which the catalog does not declare`);
        }
      }
    }
    for (const marker of markers) {
      if (!claimed.has(marker)) {
        report(marker.line, 'this marker is not above an emit whose name is built');
        continue;
      }
      for (const name of marker.names.filter((candidate) => candidate !== FORWARDED)) {
        const key = declaredKey(catalog, name);
        if (key === undefined) report(marker.line, `${name} is named by a marker and ${CATALOG} does not declare it`);
        else emitted.add(key);
      }
    }
    findings.push(...found.sort((a, b) => a.line - b.line).map(({ message }) => message));
  }
  for (const name of Object.keys(catalog.events)) {
    if (!emitted.has(name)) findings.push(`${CATALOG}: ${name} is declared and no source emits it`);
  }
  return findings;
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
  const sources = trackedSources();
  const findings = [...catalogFindings(catalog), ...emitFindings(catalog, sources)];
  for (const finding of findings) process.stderr.write(`${finding}\n`);
  const sites = Object.entries(siteCounts(sources)).map(([language, { literal, built }]) => `${language} ${literal} literal ${built} built`).join(', ');
  process.stdout.write(findings.length === 0 ? `Event catalog checks passed: ${Object.keys(catalog.events).length} declared events, emit sites: ${sites}\n` : `Event catalog checks failed: ${findings.length} findings, emit sites: ${sites}\n`);
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
