#!/usr/bin/env node
// Checks that the sources of a repository record their occurrences (docs/spec/logging.md#census), as every repository calls it:
//
//   soksak-events [--census <file>] [--catalog <file>] [--list] [repository]
//
// The census rules (census-rules.json) list, per language, each source of occurrences that has neither an event in its function
// nor a reason comment `(default|silent): <reason>`. `--census` names the file in which the repository declares its entrance
// files, the files it leaves out and the rules that wait for an entrance item (`pending`). `--catalog` also checks the emit
// sites of the sources against the event catalog (docs/spec/events.json of core): every emit site names a declared event with its
// level and fields, and every declared event has an emit site.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

const SOURCE_EXTENSIONS = /\.(go|rs|m|js|mjs|cjs)$/;
// A source that emits an event is not a test, a fixture, a generated frontend or a script of this repository.
const NOT_SOURCES = /(^|\/)(tests?|fixtures|node_modules|dist|benches|scripts)\/|\/src\/frontend\/|\.test\.mjs$|_test\.(go|rs|m)$/;

const LEVELS = ['error', 'warn', 'info', 'debug', 'trace'];
const CLASSES = ['lifecycle', 'input', 'call', 'io', 'frame'];
const CATALOG_SCHEMA = 3;
const fieldSchemaAjv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
const LANGUAGES = { go: 'go', rs: 'rs', m: 'm', js: 'js', mjs: 'js', cjs: 'js' };
const FORWARDED = 'forwarded';
// A marker comment lies on the line of an emit whose name is built, or at most this many lines above it.
const MARKER_REACH = 5;

/**
 * The entrances that store an event, by language. `level`, `event` and `fields` are the positions of the arguments of the
 * call (`fields` is absent when the call has none); `class` is the position of the argument that gives the class, for an entrance
 * whose producer chooses it (the native library); `fixed` is the level of an entrance that has no level argument; `only`
 * limits an entrance to the files it is local to. `name` is the event of an entrance that stores one event and gives no name argument
 * (`event` is then the position of its first argument). `levelGroup` is the group of the pattern that holds the level of an entrance
 * that names it in the call, and `relative` marks an entrance whose event name lacks the prefix `plugin.<plugin>.`. `prefix` is
 * the text that the entrance adds before the name of its call (the performance trace adds `page.trace.`).
 */
const ENTRANCES = {
  go: [
    { re: /\bEmitHost(?:Placed)?\s*\(/g, level: 0, event: 1, fields: 2 },
    { re: /\bEmitHostCids\s*\(/g, level: 0, event: 1, fields: 3 },
    { re: /\bstoreEvent\s*\(/g, level: 0, event: 2, fields: 5 },
    // The events that the writer itself stores (log.open, log.rotated, log.dropped, ...).
    { re: /\bwriterEvent\s*\(/g, level: 0, event: 1, fields: 2 },
    // The events that the writer reports about itself from another goroutine (log.policy).
    { re: /\benqueueWriterEvent\s*\(/g, level: 0, event: 1, fields: 2 },
  ],
  rs: [
    { re: /\bemit_host(?:_placed)?\s*\(/g, level: 0, event: 1, fields: 2 },
    { re: /\bemit_host_cids\s*\(/g, level: 0, event: 1, fields: 3 },
    { re: /\bstore_event\s*\(/g, level: 0, event: 2, fields: 5 },
    { re: /\bPending::writer_event\s*\(/g, level: 0, event: 1, fields: 2 },
    { re: /\benqueue_writer_event\s*\(/g, level: 0, event: 1, fields: 2 },
  ],
  js: [
    { re: /(?:\bemitEvent|\bbatcher(?:\?)?\.emit|\bbatcher(?:\?)?\.emitAndWait|\.emitAndWait)\s*\(/g, level: 0, event: 1, fields: 2 },
    // The entrance of a plugin (docs/spec/plugins.md#logging): the level is the member (`runtime.log.info(`) or a computed key
    // (`runtime.log[level](`), and the event name has no `plugin.<plugin>.` prefix, which the runtime adds.
    { re: /\bruntime\.log\.(error|warn|info|debug|trace)\s*\(/g, levelGroup: 1, relative: true, event: 0, fields: 1 },
    { re: /\bruntime\.log\[[^\]]+\]\s*\(/g, relative: true, event: 0, fields: 1 },
  ],
  m: [
    { re: /\bsp_event\s*\(/g, class: 0, level: 1, event: 2, fields: 3 },
    { re: /\bsp_event_cids\s*\(/g, class: 0, level: 1, event: 2, fields: 4 },
    // The internal entrance of the ring, which stores the events that the library reports about itself without asking the gate.
    { re: /\bpushEvent\s*\(/g, class: 0, level: 1, event: 2, fields: 4 },
    { re: /\bstoreRecord\s*\(/g, level: 0, event: 1 },
    { re: /\bsp_log_error\s*\(/g, fixed: 'error', name: 'native.record.error', event: 0 },
    { re: /\bsp_log_info\s*\(/g, fixed: 'info', name: 'native.record.info', event: 0 },
    { re: /\bemit\s*\(/g, class: 0, fixed: 'info', event: 1, fields: 2, only: /(^|\/)activity_observers\.m$/ },
  ],
};
// The text before the name of a call on its line when the call is the definition of the function.
const DEFINITION_PREFIX = {
  go: /^\s*func\s+(\([^)]*\)\s*)?$/,
  rs: /\bfn\s+$/,
  js: /\bfunction\s+$/,
  m: /^\s*(static\s+)?(void|bool|BOOL)\s+$/,
};
const CLASS_TOKEN = /\bSP_CLASS_(LIFECYCLE|INPUT|CALL|IO|FRAME)\b/;
const LEVEL_TOKEN = /\bLevel(Error|Warn|Info|Debug|Trace)\b|\bLevel::(Error|Warn|Info|Debug|Trace)\b|\bSP_EVENT_(ERROR|WARN|INFO|DEBUG|TRACE)\b|["'`](error|warn|info|debug|trace)["'`]/g;
const FIELD_OBJECT = {
  go: /^map\[string\](?:any|string|interface\{\})\s*\{/,
  rs: /^&?(?:to_raw_value\(&)?(?:serde_json::)?json!\s*\(\s*\{/,
  m: /^@\{/,
  // A builder `() => ({...})` holds the fields of the event as the object it returns.
  js: /^(?:\(\s*\)\s*=>\s*\(\s*)?\{/,
};
const FIELD_KEY = {
  go: /^"([^"]+)"\s*:/,
  rs: /^"([^"]+)"\s*:/,
  m: /^@"([^"]+)"\s*:/,
  js: /^(?:"([^"]+)"|'([^']+)'|([A-Za-z_$][\w$]*))\s*(?::|$)/,
};

/** The text of the tracked sources of the repository at `root` that can emit events, by path. */
export function trackedSources(root) {
  const files = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n')
    .filter((path) => SOURCE_EXTENSIONS.test(path) && !NOT_SOURCES.test(path));
  return new Map(files.map((path) => [path, readFileSync(join(root, path), 'utf8')]));
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
    } else if (language === 'rs' && c === 'r' && /^r#*"/.test(text.slice(i, i + 12)) && !(i > 0 && /\w/.test(text[i - 1]))) {
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
  if (name.startsWith('plugin.*.')) {
    const rest = name.slice('plugin.*.'.length).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return Object.keys(catalog.events).find((key) => new RegExp(`^plugin\\.[^.]+\\.${rest}$`).test(key));
  }
  if (name.includes('*') || name.includes('<')) return undefined;
  return families.find((key) => {
    const pattern = key.split(/<[a-z_]+>/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[a-z0-9_.]+');
    return new RegExp(`^${pattern}$`).test(name);
  });
}

/** The name that an expression gives literally (a template of a page as a family with `*`), or null when it is built. */
function literalName(source, [from, to]) {
  const expression = source.code.slice(from, to);
  const quoted = /^@?"((?:[^"\\]|\\.)*)"(?:\.(?:into|to_string|to_owned)\(\))?$/.exec(expression);
  if (quoted) return quoted[1];
  const single = source.language === 'js' ? /^'((?:[^'\\]|\\.)*)'$/.exec(expression) : null;
  if (single) return single[1];
  const template = source.language === 'js' ? /^`([^`]*)`$/.exec(expression) : null;
  return template ? template[1].replace(/\$\{[^}]*\}/g, '*') : null;
}

/** The class that an expression names literally (`SP_CLASS_<NAME>`), or null when it names none. */
function classOf(source, range) {
  if (range === undefined) return null;
  const found = CLASS_TOKEN.exec(source.code.slice(...range));
  return found ? found[1].toLowerCase() : null;
}

/** The name of a site of a plugin entrance with the plugin left open (`plugin.*.<event>`); the catalog gives the plugin. */
const relativeName = (entrance, name) => (entrance.relative && name !== null ? `plugin.*.${name}` : name);
const prefixedName = (entrance, name) => (entrance.prefix !== undefined && name !== null ? `${entrance.prefix}${name}` : name);

/** The levels that an expression names literally, or null when it names none. */
function levelsOf(source, range) {
  if (range === undefined) return null;
  const found = [...source.code.slice(...range).matchAll(LEVEL_TOKEN)].map((match) => match.slice(1).find((part) => part !== undefined).toLowerCase());
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
    if (key) keys.push(key.slice(1).find((part) => part !== undefined));
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
 * The sites of one source where an event is stored, as `{at, line, call, name, levels, fields}` (`at` is the offset of the call) (`name` is null when the site
 * builds it), and the markers of the source.
 */
export function sitesOf(path, text, emitters = {}) {
  const language = LANGUAGES[path.slice(path.lastIndexOf('.') + 1)];
  const source = { path, language, ...lex(path, text, language) };
  const { code, inString } = source;
  const sites = [];
  // default: a repository that declares no emitters for the language has only the entrances of this package.
  for (const entrance of [...ENTRANCES[language], ...(emitters[language] ?? [])]) {
    if (entrance.only && !entrance.only.test(path)) continue;
    for (const match of code.matchAll(entrance.re)) {
      if (inString[match.index]) continue;
      if (DEFINITION_PREFIX[language].test(code.slice(code.lastIndexOf('\n', match.index - 1) + 1, match.index))) continue;
      const open = match.index + match[0].length - 1;
      const args = splitTop(source, open + 1, matchClose(source, open));
      if (args[entrance.event] === undefined) throw new Error(`${path}:${source.lineAt(match.index)}: ${match[0]} has no argument ${entrance.event + 1}`);
      sites.push({
        at: match.index,
        line: source.lineAt(args[entrance.event][0]),
        call: source.lineAt(match.index),
        // default: an entrance without a fixed name reads the name from the literal argument of the call.
        name: entrance.name ?? relativeName(entrance, prefixedName(entrance, literalName(source, args[entrance.event]))),
        levels: entrance.fixed ? [entrance.fixed] : entrance.levelGroup ? [match[entrance.levelGroup]] : levelsOf(source, args[entrance.level]),
        class: entrance.class === undefined ? null : classOf(source, args[entrance.class]),
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
      at: match.index,
      line: source.lineAt(match.index),
      call: source.lineAt(match.index),
      name,
      levels: levelsOf(source, entries.get('level')),
      class: null,
      fields: fieldsOf(source, entries.get('fields')),
    });
  }
  return { sites: sites.sort((a, b) => a.line - b.line), markers: source.markers };
}

/** The findings of the catalog at `catalogPath` itself: each entry has a layer the catalog lists, a class, levels and field types of the contract. */
/** The properties and fields required in every branch of a JSON Schema declaration. */
function fieldSchemaMembers(schema) {
  if (schema?.$schema !== 'https://json-schema.org/draft/2020-12/schema') return null;
  const branches = schema?.oneOf ?? [schema]; // default: a JSON Schema without oneOf declares this schema as its sole branch.
  if (!Array.isArray(branches) || branches.length === 0) return null;
  const propertyNames = new Set();
  let required = null;
  const requiredByBranch = [];
  for (const branch of branches) {
    if (branch?.type !== 'object' || branch.properties === null || typeof branch.properties !== 'object' || Array.isArray(branch.properties)) return null;
    const requiredBranch = branch.required;
    if (!Array.isArray(requiredBranch) || requiredBranch.some((field) => typeof field !== 'string' || !Object.hasOwn(branch.properties, field))) return null;
    Object.keys(branch.properties).forEach((field) => propertyNames.add(field));
    requiredByBranch.push(requiredBranch);
    required = required === null ? new Set(requiredBranch) : new Set([...required].filter((field) => requiredBranch.includes(field)));
  }
  return { properties: [...propertyNames], required: [...required], requiredByBranch };
}

export function catalogFindings(catalog, catalogPath) {
  const findings = [];
  if (catalog.schema !== CATALOG_SCHEMA) findings.push(`${catalogPath}: event catalog schema ${catalog.schema === undefined ? 'is missing' : `is ${JSON.stringify(catalog.schema)}`}; expected ${CATALOG_SCHEMA}`);
  for (const [name, entry] of Object.entries(catalog.events)) {
    const report = (message) => findings.push(`${catalogPath}: ${name} ${message}`);
    if (!catalog.layers.includes(entry.layer)) report(`has the layer ${entry.layer}, which the catalog does not list`);
    else if (!name.startsWith(`${entry.layer}.`) && !name.startsWith('log.')) report(`has the layer ${entry.layer} and a name that starts with neither ${entry.layer}. nor log.`);
    if (!CLASSES.includes(entry.class)) report(`has the class ${entry.class}, which is not one of ${CLASSES.join(', ')}`);
    for (const level of [entry.level].flat()) {
      if (!LEVELS.includes(level)) report(`has the level ${level}, which is not one of ${LEVELS.join(', ')}`);
    }
    try {
      fieldSchemaAjv.compile(entry.fields);
    } catch (error) {
      report(`has an invalid JSON Schema for fields: ${error.message}`);
      continue;
    }
    if (fieldSchemaMembers(entry.fields) === null) report('has a field schema outside the object, properties and oneOf form');
  }
  return findings;
}

/** The number of emit sites by language, as `{literal, built}`: sites that give their name, and sites that build it. */
export function siteCounts(sources, emitters = {}) {
  const counts = {};
  for (const [path, text] of sources) {
    const language = LANGUAGES[path.slice(path.lastIndexOf('.') + 1)];
    if (!counts[language]) counts[language] = { literal: 0, built: 0 };
    for (const site of sitesOf(path, text, emitters).sites) counts[language][site.name === null ? 'built' : 'literal'] += 1;
  }
  return counts;
}

/**
 * The findings of the emit sites of the sources against the catalog, in both directions: an emitted name that the catalog
 * does not declare, a declared name that no site emits, and the level and the fields of a literal site that differ from the
 * declaration. A site gives its name literally (a string, or a template of a page), or a comment `events: <declared names>`
 * above it names what it builds, or `events: forwarded` states that it passes on the name of its caller.
 */
export function emitFindings(catalog, sources, catalogPath, config = { emitters: {} }) {
  const findings = [];
  const emitted = new Set();
  for (const [path, text] of sources) {
    const { sites, markers } = sitesOf(path, text, config.emitters);
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
        report(site.line, `${site.name} is emitted and ${catalogPath} does not declare it`);
        continue;
      }
      emitted.add(key);
      const entry = catalog.events[key];
      const declaredLevels = [entry.level].flat();
      if (site.levels !== null && site.levels.some((level) => !declaredLevels.includes(level))) {
        report(site.line, `${site.name} is emitted at the level ${site.levels.join(', ')} and the catalog declares ${declaredLevels.join(', ')}`);
      }
      if (site.class !== null && site.class !== entry.class) {
        report(site.line, `${site.name} is emitted with the class ${site.class} and the catalog declares ${entry.class}`);
      }
      const shape = fieldSchemaMembers(entry.fields);
      // A family whose entry declares no properties leaves the fields of each of its events to the site (the performance trace of the page).
      const fieldsDeclared = !(key.includes('<') && shape?.properties.length === 0);
      if (site.fields !== null && fieldsDeclared) {
        const declared = shape?.properties ?? []; // default: an invalid shape declares no usable fields; catalogFindings reports the schema error.
        if (!site.fields.open) {
          if (shape?.requiredByBranch.length > 1) {
            const emitted = new Set(site.fields.keys);
            if (!shape.requiredByBranch.some((required) => required.every((field) => emitted.has(field)))) {
              report(site.line, `${site.name} does not provide the required fields of any declared JSON Schema branch`);
            }
          } else {
            for (const field of shape?.required ?? []) { // default: an invalid shape declares no usable required fields; catalogFindings reports the schema error.
              if (!site.fields.keys.includes(field)) report(site.line, `${site.name} lacks the field ${field} that the catalog requires`);
            }
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
        if (key === undefined) report(marker.line, `${name} is named by a marker and ${catalogPath} does not declare it`);
        else emitted.add(key);
      }
    }
    findings.push(...found.sort((a, b) => a.line - b.line).map(({ message }) => message));
  }
  for (const name of Object.keys(catalog.events)) {
    if (!emitted.has(name)) findings.push(`${catalogPath}: ${name} is declared and no source emits it`);
  }
  return findings;
}


/** The reason marker `(default|silent): <reason>`, with a reason of at least ten characters. */
export const REASON = /(?<![\w-])(?:default|silent): \S.{9,}/;
const COMMENT = /^\s*(?:\/\/|\*|\/\*)/;
const MARKER_OPENING = /(?:\/\/[/!]?|\/\*+|^\s*\*)\s*(기본값|default|silent|fallback)\s*[:：-]/i;

/** The reason on the line at `index` or in the comment lines directly above it, or null. */
export function reasonFor(lines, index) {
  const current = lines[index].match(REASON);
  if (current) return current[0].trim();
  for (let above = index - 1; above >= 0 && COMMENT.test(lines[above]); above -= 1) {
    const match = lines[above].match(REASON);
    if (match) return match[0].trim();
  }
  return null;
}

/**
 * The comments of a source that open with a word of a reason marker in another form than `(default|silent): <reason>`, as
 * `<file>:<line>: reason marker "<text>" is not the form "(default|silent): <reason>"`. There is one form: no other word, case,
 * language, separator or missing space is accepted.
 */
export function markerErrors(file, text) {
  const errors = [];
  text.split('\n').forEach((line, index) => {
    const found = MARKER_OPENING.exec(line);
    if (!found) return;
    const written = line.slice(found.index + found[0].lastIndexOf(found[1])).replace(/\s+$/, '');
    if (/^(?:default|silent): \S/.test(written)) return;
    errors.push(`${file}:${index + 1}: reason marker "${written.slice(0, 40)}" is not the form "(default|silent): <reason>"`);
  });
  return errors;
}

/** The source of a file with its comments blanked, as `{path, language, code, inString, lineAt, markers}`. */
export function lexSource(path, text) {
  const language = LANGUAGES[path.slice(path.lastIndexOf('.') + 1)];
  return { path, language, ...lex(path, text, language) };
}

/** The offset of the `{` of the innermost block that holds `at`, or -1; brackets that are open around `at` are passed. */
function enclosingBlock(source, at) {
  let depth = 0;
  for (let k = at - 1; k >= 0; k -= 1) {
    if (source.inString[k]) continue;
    if (')]}'.includes(source.code[k])) depth += 1;
    else if ('([{'.includes(source.code[k])) {
      if (depth > 0) depth -= 1;
      else if (source.code[k] === '{') return k;
    }
  }
  return -1;
}

const CONTROL = /^(?:if|else|for|while|switch|do|try|catch|finally|select|defer|@try|@catch|@finally|@synchronized|@autoreleasepool)\b/;
const FUNCTION_HEADER = {
  go: (header) => /^func\s+(?:\([^)]*\)\s*)?[A-Za-z_]/.test(header),
  rs: (header) => /\bfn\s+[A-Za-z_]/.test(header),
  js: (header) => !CONTROL.test(header) && /\bfunction\b|=>|\)\s*$/.test(header),
};

/** The text of the block header before the `{` at `open`: the text since the previous `;`, `{` or `}`. */
function headerOf(source, open) {
  let k = open - 1;
  while (k >= 0 && (source.inString[k] || !';{}'.includes(source.code[k]))) k -= 1;
  return source.code.slice(k + 1, open).trim();
}

/**
 * The range `[start, end]` of the function that holds the offset `at`: the innermost named function of Go and Rust, the
 * innermost function-like block of JavaScript and the outermost block of Objective-C (a method, a function or a block inside
 * a call all belong to it). It is the whole file when no block holds `at`.
 */
export function functionRange(source, at) {
  let open = enclosingBlock(source, at);
  let chosen = -1;
  while (open >= 0) {
    if (source.language === 'm') chosen = open;
    else if (FUNCTION_HEADER[source.language](headerOf(source, open))) {
      chosen = open;
      break;
    }
    open = enclosingBlock(source, open);
  }
  if (chosen < 0) return [0, source.code.length];
  return [chosen, matchClose(source, chosen)];
}

/** The census rules of the package. */
export function censusRules() {
  return JSON.parse(readFileSync(new URL('./census-rules.json', import.meta.url), 'utf8')).rules;
}

const EMITTER_KEYS = ['call', 'level', 'fixed', 'event', 'fields', 'name', 'only', 'prefix', 'bare'];

/**
 * The emit sites that a repository declares for the writer methods of its own language (`emitters`: language to a list of
 * `{call, level | fixed, event, fields?, name?, only?}`), as the entrances of `ENTRANCES`. `call` is the name of the method or
 * function; `level`, `event` and `fields` are the positions of its arguments, `fixed` is the level of a call without a level
 * argument, `name` is the event that such a call stores, `prefix` is the text that the event name of the call starts with, `bare`
 * is true for a function that is not a method (a call after `.` does not count), and `only` is a pattern of the paths the call is local to.
 */
function parseEmitters(file, emitters) {
  const fail = (message) => { throw new Error(`${file}: ${message}`); };
  if (emitters === null || typeof emitters !== 'object' || Array.isArray(emitters)) fail('emitters is not an object of languages');
  const parsed = {};
  for (const [language, list] of Object.entries(emitters)) {
    if (!Object.values(LANGUAGES).includes(language)) fail(`emitters names the language ${language}, which is not one of ${[...new Set(Object.values(LANGUAGES))].join(', ')}`);
    if (!Array.isArray(list)) fail(`emitters.${language} is not a list`);
    parsed[language] = list.map((emitter, index) => {
      const at = `emitters.${language}[${index}]`;
      for (const key of Object.keys(emitter)) if (!EMITTER_KEYS.includes(key)) fail(`${at}: has the key ${key}, which is not one of ${EMITTER_KEYS.join(', ')}`);
      if (typeof emitter.call !== 'string' || !/^[A-Za-z_]\w*$/.test(emitter.call)) fail(`${at}: call ${JSON.stringify(emitter.call)} is not an identifier`);
      if (list.slice(0, index).some((earlier) => earlier.call === emitter.call)) fail(`${at}: call ${emitter.call} is declared twice`);
      if (emitter.level === undefined && emitter.fixed === undefined) fail(`${at}: needs level (the position of the level argument) or fixed (the level of the call)`);
      if (emitter.level !== undefined && emitter.fixed !== undefined) fail(`${at}: has level and fixed; a call names its level in one of them`);
      const position = (key) => {
        if (!Number.isInteger(emitter[key]) || emitter[key] < 0) fail(`${at}: ${key} must be a non-negative integer, found ${JSON.stringify(emitter[key])}`);
      };
      if (emitter.level !== undefined) position('level');
      position('event');
      if (emitter.fields !== undefined) position('fields');
      if (emitter.fixed !== undefined && !LEVELS.includes(emitter.fixed)) fail(`${at}: fixed ${JSON.stringify(emitter.fixed)} is not a level`);
      if (emitter.name !== undefined && typeof emitter.name !== 'string') fail(`${at}: name is not a string`);
      let only;
      if (emitter.only !== undefined) {
        try {
          only = new RegExp(emitter.only);
        } catch {
          fail(`${at}: only is not a pattern: ${JSON.stringify(emitter.only)}`);
        }
      }
      if (emitter.prefix !== undefined && typeof emitter.prefix !== 'string') fail(`${at}: prefix is not a string`);
      if (emitter.bare !== undefined && typeof emitter.bare !== 'boolean') fail(`${at}: bare is not a boolean`);
      // A bare call is a function, not a method: a call of `x.call(` does not count (the lookbehind), as a method of the writer does.
      const head = emitter.bare ? `(?<![.\\w$])${emitter.call}` : `\\b${emitter.call}`;
      return { re: new RegExp(`${head}\\s*\\(`, 'g'), level: emitter.level, fixed: emitter.fixed, event: emitter.event, fields: emitter.fields, name: emitter.name, prefix: emitter.prefix, only };
    });
  }
  return parsed;
}

/**
 * Reads the census declaration of a repository (`file`, its text `text`): `exclude` (a pattern of the paths that the census
 * leaves out), `entrances` (rule id to the patterns of the entrance files that may hold the rule's source) and `pending` (rule
 * id to the checklist item that enables it). A rule id that no rule has is an error.
 */
export function parseCensusConfig(file, text, rules = censusRules()) {
  const fail = (message) => { throw new Error(`${file}: ${message}`); };
  let config;
  try {
    config = JSON.parse(text);
  } catch (error) {
    throw new Error(`${file}: ${error.message}`, { cause: error });
  }
  const known = rules.map((rule) => rule.id);
  const allowed = ['exclude', 'entrances', 'pending', 'emitters'];
  for (const key of Object.keys(config)) if (!allowed.includes(key)) fail(`has the key ${key}, which is not one of ${allowed.join(', ')}`);
  // default: a declaration without entrances declares none.
  const entrances = config.entrances ?? {};
  const pending = config.pending ?? {}; // default: a declaration without pending rules enforces every rule.
  for (const id of [...Object.keys(entrances), ...Object.keys(pending)]) if (!known.includes(id)) fail(`names the rule ${id}, which no census rule has`);
  for (const [id, item] of Object.entries(pending)) if (!/^F\d+(?:[.-]\d+)*$/.test(item)) fail(`gives the rule ${id} the pending item ${JSON.stringify(item)}, which is no checklist id`);
  for (const [id, patterns] of Object.entries(entrances)) {
    if (!Array.isArray(patterns) || patterns.some((pattern) => typeof pattern !== 'string')) fail(`gives the rule ${id} entrances that are not a list of patterns`);
  }
  return {
    emitters: parseEmitters(file, config.emitters ?? {}), // default: a declaration without emitters declares none.
    exclude: config.exclude === undefined ? null : new RegExp(config.exclude),
    entrances: Object.fromEntries(Object.entries(entrances).map(([id, patterns]) => [id, patterns.map((pattern) => new RegExp(pattern))])),
    pending,
  };
}

/**
 * The census of the sources (a map of path to text): every match of a rule of the language of the file that is outside the
 * entrance files of the rule and has neither an event in its function nor a reason marker on its lines or in the comment above
 * it (a rule that requires an entrance accepts neither). A finding is `{file, line, rule, message, pending}`; `pending` is the
 * item that waits to enable the rule, or null.
 */
export function censusFindings(sources, config, rules = censusRules()) {
  const findings = [];
  for (const [path, text] of sources) {
    if (config.exclude && config.exclude.test(path)) continue;
    const language = LANGUAGES[path.slice(path.lastIndexOf('.') + 1)];
    // default: a rule that the declaration gives no entrance has no entrance file.
    const own = rules.filter((rule) => rule.language === language && !(config.entrances[rule.id] ?? []).some((entrance) => entrance.test(path)));
    if (own.length === 0) continue;
    const source = lexSource(path, text);
    const lines = text.split('\n');
    let sites = null;
    for (const rule of own) {
      for (const match of source.code.matchAll(new RegExp(rule.pattern, 'g'))) {
        if (source.inString[match.index]) continue;
        if (rule.id === 'rs.lock-result' && /^\.(?:wait|wait_timeout|wait_while|wait_timeout_while)\s*\($/.test(match[0])) {
          const open = match.index + match[0].lastIndexOf('(');
          const close = matchClose(source, open);
          if (source.code.slice(open + 1, close).trim() === '') continue;
          if (!/^\s*(?:\.\s*(?:map_err|expect|unwrap|ok)\s*\(|\?)/.test(source.code.slice(close + 1))) continue;
        }
        const line = source.lineAt(match.index);
        // default: a rule that no declaration marks pending is enforced.
        const finding = (message) => findings.push({ file: path, line, rule: rule.id, message: `${path}:${line}: ${message}`, pending: config.pending[rule.id] ?? null });
        if (rule.requires === 'entrance') {
          finding(`${rule.id} is outside its entrance files`);
          continue;
        }
        // default: a rule that requires recovery has no marker and no event that excuses its match.
        if (rule.requires === 'recovery') {
          finding(`${rule.id} is a poisoned lock that is not recovered`);
          continue;
        }
        const last = source.lineAt(match.index + match[0].length - 1);
        if (reasonFor(lines, line - 1) !== null || lines.slice(line, last).some((text) => REASON.test(text))) continue;
        if (sites === null) sites = sitesOf(path, text, config.emitters).sites;
        const [start, end] = functionRange(source, match.index);
        if (sites.some((site) => site.at >= start && site.at <= end)) continue;
        finding(`${rule.id} has neither an event nor a stated reason`);
      }
    }
  }
  return findings.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
}

/** The census declaration of the repository at `root` in `configFile`; a repository without one declares nothing. */
function censusConfig(root, configFile) {
  return configFile === undefined ? parseCensusConfig('(no census declaration)', '{}') : parseCensusConfig(configFile, readFileSync(join(root, configFile), 'utf8'));
}

/** The tracked sources of the repository that its census declaration does not exclude; an excluded file (a vendored bundle) is not read. */
function declaredSources(root, config) {
  return new Map([...trackedSources(root)].filter(([path]) => !(config.exclude && config.exclude.test(path))));
}

/** The result of the census of the repository at `root`: the findings, the pending rules, the marker errors and the number of sources. */
export function census(root, configFile) {
  const config = censusConfig(root, configFile);
  const sources = declaredSources(root, config);
  const findings = censusFindings(sources, config);
  const markers = [...sources].flatMap(([path, text]) => markerErrors(path, text));
  return { findings, pending: config.pending, markers, sources: sources.size };
}

/**
 * The findings of the emit sites of the repository at `root` against the catalog at `catalogPath`, and the emit site counts.
 * The sources are those that the census declaration `configFile` does not exclude.
 */
export function catalogReport(root, catalogPath, configFile) {
  const catalog = JSON.parse(readFileSync(join(root, catalogPath), 'utf8'));
  const config = censusConfig(root, configFile);
  const sources = declaredSources(root, config);
  const findings = [...catalogFindings(catalog, catalogPath), ...emitFindings(catalog, sources, catalogPath, config)];
  const sites = Object.entries(siteCounts(sources, config.emitters)).map(([language, { literal, built }]) => `${language} ${literal} literal ${built} built`).join(', ');
  return { findings, declared: Object.keys(catalog.events).length, sites };
}

const USAGE = 'usage: soksak-events [--census <file>] [--catalog <file>] [--list] [repository]';

function main(argv) {
  const options = { census: undefined, catalog: undefined, list: false, repository: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--census' || argv[i] === '--catalog') {
      if (argv[i + 1] === undefined) throw new Error(`${argv[i]} needs a file; ${USAGE}`);
      options[argv[i].slice(2)] = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--list') options.list = true;
    else if (argv[i].startsWith('--') || options.repository !== undefined) throw new Error(USAGE);
    else options.repository = argv[i];
  }
  // default: when [repository] of the usage is omitted, the repository in the current folder is checked.
  const root = resolve(options.repository ?? '.');
  if (!existsSync(root)) throw new Error(`${root}: the repository does not exist`);
  const { findings, pending, markers, sources } = census(root, options.census);
  const failing = findings.filter((finding) => finding.pending === null);
  for (const text of [...markers, ...failing.map((finding) => finding.message)]) process.stderr.write(`${text}\n`);
  for (const [rule, item] of Object.entries(pending)) {
    const waiting = findings.filter((finding) => finding.rule === rule);
    process.stdout.write(`pending ${item}: ${rule} is not enforced; ${waiting.length} findings wait for it\n`);
    if (options.list) for (const finding of waiting) process.stdout.write(`  ${finding.message}\n`);
  }
  const failed = markers.length + failing.length;
  process.stdout.write(`${failed === 0 ? 'Census passed' : `Census failed: ${failed} findings`}: ${sources} sources, ${Object.keys(pending).length} rules pending\n`);
  let code = failed === 0 ? 0 : 1;
  if (options.catalog !== undefined) {
    const report = catalogReport(root, options.catalog, options.census);
    for (const finding of report.findings) process.stderr.write(`${finding}\n`);
    process.stdout.write(report.findings.length === 0 ? `Event catalog checks passed: ${report.declared} declared events, emit sites: ${report.sites}\n` : `Event catalog checks failed: ${report.findings.length} findings, emit sites: ${report.sites}\n`);
    if (report.findings.length > 0) code = 1;
  }
  return code;
}

// A package manager places a package as a link, so the started path is resolved before it is compared with this module.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
