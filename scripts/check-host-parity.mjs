// Mechanically compares the public API surfaces of the two hosts (docs/spec/host-parity.md).
//
// Proposition 1 (public bindings) checks the set of host.call names that each frontend runtime accepts and whether each name is actually connected
// to the implementation of each host. Proposition 2 (endpoint methods) compares the set of endpoint methods that each host declares
// per build flavor, and the diagnostic methods of each host with the diagnostic builds table of the endpoint specification. Proposition 3 (menu contract table) checks that the menu table of the host contract specification and the menu builder tables of both hosts are the same.
// Proposition 6 (platform callers) checks that a production source of each host outside src/platform calls every method of its
// platform interface from code that the product runs: a call inside a free function counts only when an entry point, an
// application source or another counting call reaches that function, so a function that only tests call does not keep a
// platform method called. The comparison of the actual menu bar belongs to the window check layer, and propositions 4 and 5 are the next
// extension.
import { LANGUAGE_TABLE, allowedDifferenceTables } from './check-hosts.mjs';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

/** Converts a camel case method name to snake case. It is the normal form for comparing binding names. */
export const snake = (name) => name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z])([A-Z][a-z])/g, '$1_$2').toLowerCase();

/** Reads the set of host.call names from the call name tables of a runtime (COMMAND, METHOD). */
export function runtimeCalls(runtime, tableDeclaration, file) {
  const table = runtime.indexOf(tableDeclaration);
  if (table < 0) throw new Error(`${file} has no ${tableDeclaration} table`);
  const body = runtime.slice(table, runtime.indexOf('};', table));
  return new Set([...body.matchAll(/([a-z][a-zA-Z0-9]*):\s*"/g)].map((match) => snake(match[1])));
}

/** The set of command names that the Rust `bindings!` block defines, also of a command that is generic over the runtime; the same macro generates the registration. */
export function rustHandlers(bindings) {
  const start = bindings.indexOf('\nbindings! {');
  if (start < 0) throw new Error('bindings.rs has no bindings! block');
  return new Set([...bindings.slice(start).matchAll(/#\[tauri::command[^\]]*\]\s*(?:async\s+)?fn ([a-z][a-z0-9_]*)(?:<[^>]*>)?\(/g)]
    .map((match) => match[1]));
}

/** The set of exported method names of the bound Host struct over all Go host packages. */
export function goHostMethods(sources) {
  const methods = new Set();
  for (const [file, source] of Object.entries(sources)) {
    for (const match of source.matchAll(/^func \(h \*Host\) ([A-Z]\w*)\(/gm)) methods.add(snake(match[1]));
  }
  return methods;
}

/** The set of method names that the Rust endpoint declares (per build flavor). */
export function rustEndpointMethods(source) {
  const collect = (name) => {
    const declaration = `const ${name}: &[&str] = &[`;
    const start = source.indexOf(declaration);
    if (start < 0) throw new Error(`endpoint.rs has no ${name} array`);
    const body = source.slice(start + declaration.length, source.indexOf('];', start));
    return new Set(body.split(/[\s,]+/).map((value) => value.replaceAll('"', '')).filter((value) => value.includes('.')));
  };
  const diagnostics = collect('DIAGNOSTICS');
  // The transcript methods of the diagnostic build are in the array by constant name, so they are taken from the constant declarations.
  const transcript = source.match(/const TRANSCRIPT: &str = "([a-z][a-z0-9_.]*)"/);
  if (transcript) diagnostics.add(transcript[1]);
  return { base: collect('METHODS'), diagnostics };
}

function goMapKeys(source, declaration) {
  const start = source.indexOf(declaration);
  if (start < 0) throw new Error(`source has no ${declaration}`);
  const body = source.slice(start, source.indexOf('\n}', start));
  return new Set([...body.matchAll(/"([a-z][a-z0-9_.]*)":/g)].map((match) => match[1]));
}

/** The set of method names that the Go endpoint declares (per build flavor). */
export function goEndpointMethods(endpoint, diagnosticsSource) {
  const assigned = (source) => [...source.matchAll(/^\s*diagnostic(Methods|Subscriptions)\["([a-z][a-z0-9_.-]*)"\] =/gm)]
    .map((match) => match[2]);
  const diagnosticOnly = new Set([
    ...assigned(diagnosticsSource),
    ...goMapKeys(endpoint, 'var diagnosticSubscriptions = map[string]subscriptionMethod{'),
  ]);
  const base = new Set([
    ...goMapKeys(endpoint, 'var endpointMethods = map[string]endpointMethod{'),
    ...goMapKeys(endpoint, 'var subscriptionMethods = map[string]subscriptionMethod{'),
    ...assigned(diagnosticsSource),
  ]);
  for (const name of diagnosticOnly) base.delete(name);
  return { base, diagnostics: diagnosticOnly };
}

/** Proposition 3: reads the menu table of the host contract specification. */
export function specMenuTables(specMarkdown) {
  const section = specMarkdown.slice(specMarkdown.indexOf('## Application menu'), specMarkdown.indexOf('## Contract cases'));
  if (!section) throw new Error('host contract spec has no Application menu section');
  const readTable = (header) => {
    const start = section.indexOf(header);
    if (start < 0) throw new Error(`Application menu section has no ${header.replace(/\|/g, '')} table`);
    const lines = section.slice(start, section.indexOf('\n\n', start)).split('\n');
    // A placeholder in parentheses (for example "(application name)") equals an empty value of the host table.
    const cells = (line) => line.split('|').slice(1, -1)
      .map((cell) => cell.trim()).map((cell) => (/^\(.*\)$/.test(cell) ? "" : cell));
    return { header: cells(lines[0]), rows: lines.slice(2).map(cells) };
  };
  const menus = readTable('| id | ko | en |');
  return {
    languages: menus.header.slice(1),
    menus: menus.rows,
    items: readTable('| menu | id | source | ko | en | key |').rows,
  };
}

/** Proposition 3: reads the table of the Rust menu builder. */
export function rustMenuTables(source) {
  const rows = (name, width) => {
    const start = source.indexOf(`pub const ${name}: &[`);
    if (start < 0) throw new Error(`menu builder has no ${name} table`);
    const body = source.slice(start, source.indexOf('];', start));
    return [...body.matchAll(new RegExp(`\\(${Array.from({ length: width }, () => '"([^"]*)"').join(', ')}\\)`, 'g'))]
      .map((match) => match.slice(1));
  };
  return { menus: rows('MENUS', 3), items: rows('ITEMS', 6) };
}

/** Proposition 3: reads the table of the Go menu builder. */
export function goMenuTables(source) {
  const rows = (name, width) => {
    const start = source.indexOf(`var ${name} = []struct{`);
    if (start < 0) throw new Error(`menu builder has no ${name} table`);
    const body = source.slice(start, source.indexOf('\n}', start));
    return [...body.matchAll(new RegExp(`\\{${Array.from({ length: width }, () => '"([^"]*)"').join(', ')}\\}`, 'g'))]
      .map((match) => match.slice(1));
  };
  return { menus: rows('menuTable', 3), items: rows('itemTable', 6) };
}

/** Proposition 3: compares the specification table with the tables of the two host builders. */
export function auditMenuTables(spec, rust, go) {
  const failures = [];
  const compare = (name, expected, actual) => {
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      failures.push(`menu ${name} table differs from the host contract spec`,
        `  spec: ${JSON.stringify(expected)}`,
        `  host: ${JSON.stringify(actual)}`);
    }
  };
  compare('menus', spec.menus, rust.menus);
  compare('items', spec.items, rust.items);
  compare('menus', spec.menus, go.menus);
  compare('items', spec.items, go.items);
  return failures;
}

/** Reads the quoted names of the list that starts at declaration and ends at the first closing bracket after it. */
function quotedList(source, declaration, close, file) {
  const start = source.indexOf(declaration);
  if (start < 0) throw new Error(`${file} has no ${declaration}`);
  const body = source.slice(start + declaration.length, source.indexOf(close, start + declaration.length));
  return [...body.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

/**
 * Proposition 5: reads the common-only keys of the copy of workbench.json that each language host library embeds, of the browser runtime and of the workbench declaration
 * (packages/workbench/workbench.json), which refuse them in project settings
 * (docs/spec/projects.md#persistence).
 */
export function commonOnlyKeys({ tauriv2DeclarationSource, wailsv3DeclarationSource, browserStorageSource, workbenchDeclarationSource }) {
  return {
    tauriv2: JSON.parse(tauriv2DeclarationSource).settings.commonOnly,
    wailsv3: JSON.parse(wailsv3DeclarationSource).settings.commonOnly,
    browser: quotedList(browserStorageSource, 'const COMMON_ONLY = Object.freeze([', '])', 'apps/browser/runtime/browser-storage.js'),
    workbench: JSON.parse(workbenchDeclarationSource).settings.commonOnly,
  };
}

/** Proposition 5: each host refuses the common-only keys that the workbench refuses. */
export function auditCommonOnlyKeys(keys) {
  const failures = [];
  const expected = JSON.stringify([...keys.workbench].sort());
  for (const host of ['tauriv2', 'wailsv3', 'browser']) {
    const actual = JSON.stringify([...keys[host]].sort());
    if (actual !== expected) {
      failures.push(`${host} common-only keys ${actual} differ from the common-only keys of the workbench ${expected}`);
    }
  }
  return failures;
}

/**
 * Reads the endpoint methods that exist in one language only from the language table of the allowed differences of the host
 * specification (docs/spec/hosts.md). A row whose ID is E<number> declares endpoint methods; its Go and Rust cells list method
 * names in backticks or `none`.
 */
export function allowedEndpointMethods(hostsMarkdown) {
  const rows = allowedDifferenceTables(hostsMarkdown).get(LANGUAGE_TABLE.title);
  const allowed = { go: new Set(), rust: new Set() };
  for (const [id, row] of rows) {
    if (!/^E\d+$/.test(id)) continue;
    for (const [language, cell] of [['go', row[LANGUAGE_TABLE.left]], ['rust', row[LANGUAGE_TABLE.right]]]) {
      if (cell === 'none') continue;
      const names = [...(cell ?? '').matchAll(/`([a-z][a-z0-9_.]*)`/g)].map((match) => match[1]);
      if (names.length === 0) throw new Error(`hosts spec row ${id} has no method name or none in the ${language} cell: ${cell}`);
      for (const name of names) allowed[language].add(name);
    }
  }
  return allowed;
}

/**
 * Reads the methods of the diagnostic builds table of the endpoint specification (docs/spec/endpoint.md): each row whose
 * first cell is one method name in backticks.
 */
export function specDiagnosticMethods(endpointMarkdown) {
  const start = endpointMarkdown.indexOf('## Diagnostic builds');
  if (start < 0) throw new Error('endpoint spec has no Diagnostic builds section');
  const end = endpointMarkdown.indexOf('\n## ', start + 1);
  const section = endpointMarkdown.slice(start, end < 0 ? undefined : end);
  const methods = new Set();
  for (const line of section.split('\n')) {
    const name = /^`([a-z][a-z0-9_.-]*)`$/.exec(line.split('|').slice(1, -1).map((cell) => cell.trim())[0] ?? '');
    if (name) methods.add(name[1]);
  }
  if (methods.size === 0) throw new Error('the Diagnostic builds section of the endpoint spec has no method row');
  return methods;
}

/** The method names of every trait that the Rust platform interface (src/platform/platform.rs) declares. */
export function rustPlatformMethods(source) {
  const methods = [];
  for (const trait of source.matchAll(/^pub trait (\w+)[^{\n]*\{\n([\s\S]*?)^\}/gm)) {
    for (const match of trait[2].matchAll(/^ {4}fn ([a-z_][a-z0-9_]*)/gm)) methods.push(match[1]);
  }
  return methods;
}

/** The method names of every interface that the Go platform interface (src/platform/platform.go) declares. */
export function goPlatformMethods(source) {
  const methods = [];
  for (const block of source.matchAll(/^type (\w+) interface \{\n([\s\S]*?)^\}/gm)) {
    for (const match of block[2].matchAll(/^\t([A-Z]\w*)\(/gm)) methods.push(match[1]);
  }
  return methods;
}

// A line whose first text is a line comment calls nothing; it becomes empty, so the lines keep their positions. A cgo `//export` line
// is a directive that makes C a caller of the function below it, and it stays.
const withoutCommentLines = (source) => source.split('\n')
  .map((line) => (line.trimStart().startsWith('//') && !line.startsWith('//export ') ? '' : line)).join('\n');

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const RUST_FREE_FUNCTION = /^(?:pub(?:\([^)]*\))? )?(?:const )?(?:async )?(?:unsafe )?(?:extern "C" )?fn ([a-z_][a-z0-9_]*)/;
const GO_FUNCTION = /^func (\([^)]*\) )?([A-Za-z_]\w*)/;
const RUST_USE = /^\s*(?:pub(?:\([^)]*\))? )?use /;
const APPLICATION = 'application:';

/**
 * Returns the free function at the top level of a source that encloses line `at`, as {name, start, end, attributes}, or null when
 * the line lies in another context: a method, an impl, a module, a static or a package-level value. The sources are formatted by
 * rustfmt and gofmt, so a top-level item starts at the first column, a signature continues on lines that start with `)`, `where` or
 * `{`, and a function ends at the line `}`.
 */
function enclosingFreeFunction(language, lines, at) {
  for (let index = at; index >= 0; index -= 1) {
    const line = lines[index];
    if (line === '' || /^\s/.test(line) || /^(#\[|\)|where\b|\{|\/\/)/.test(line)) continue;
    if (line.startsWith('}')) return null;
    const match = language === 'rust' ? line.match(RUST_FREE_FUNCTION) : line.match(GO_FUNCTION);
    if (!match || (language === 'go' && match[1])) return null;
    const end = lines.findIndex((text, position) => position > index && text === '}');
    if (end >= 0 && end < at) return null;
    const attributes = [];
    for (let back = index - 1; back >= 0 && /^(#\[|\/\/export )/.test(lines[back]); back -= 1) attributes.push(lines[back]);
    return { name: language === 'rust' ? match[1] : match[2], start: index, end: end < 0 ? lines.length : end, attributes };
  }
  return null;
}

const directoryOf = (file) => (file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '');

/**
 * Judges the callers of the free functions of one host. A site that calls a function counts when it lies outside a free function
 * (in a method, an impl or a package-level value, which this audit does not resolve) or inside a live free function. A free function
 * is live when it is an entry point, `main`, Go `init`, a Rust `#[tauri::command]` or a cgo `//export` function, or when a counting
 * site outside its own body names it: in Rust as `<module>::name`, with `crate`, `self`, `super` or the crate name at the crate root,
 * or unqualified in its own file or a file whose `use` names it; in Go unqualified in its own package or as `<package>.Name`.
 */
function callerGraph(language, sources, scope) {
  const lines = Object.fromEntries(Object.entries(sources).map(([file, source]) => [file, source.split('\n')]));
  const packages = {};
  if (language === 'go') {
    for (const [file, source] of Object.entries(sources)) {
      const declared = source.match(/^package (\w+)/m);
      if (!declared) throw new Error(`${file} declares no package`);
      packages[directoryOf(file)] = declared[1];
    }
  }
  const references = new Map();
  const referencesOf = (file, name) => {
    const key = `${file}\n${name}`;
    if (references.has(key)) return references.get(key);
    const sites = [];
    const pattern = new RegExp(`(?:(\\w+)(?:::|\\.)|(\\.)|\\b)${escapeRegExp(name)}\\b`, 'g');
    const module = file.split('/').at(-1).replace(/\.rs$/, '');
    const roots = [scope.crate, ...(scope.adapterCrates ?? []).map((crate) => ({ root: `${APPLICATION}${crate.root}`, name: crate.name }))];
    const qualifiers = new Set([module, 'crate', 'self', 'super', ...roots.filter((crate) => file === crate?.root).map((crate) => crate.name)]);
    for (const [other, text] of Object.entries(lines)) {
      const imported = language === 'rust' && (other === file || [...sources[other].matchAll(/^\s*(?:pub(?:\([^)]*\))? )?use [^;]*;/gm)]
        .some((use) => use[0].includes(`${module}::`) && new RegExp(`\\b${escapeRegExp(name)}\\b`).test(use[0])));
      const samePackage = language === 'go' && directoryOf(other) === directoryOf(file);
      text.forEach((line, index) => {
        if (language === 'rust' && RUST_USE.test(line)) return;
        const definition = language === 'rust' ? line.match(RUST_FREE_FUNCTION) : line.match(GO_FUNCTION);
        for (const match of line.matchAll(pattern)) {
          if (other === file && definition && definition.at(-1) === name && !(language === 'go' && definition[1])) continue;
          if (match[2]) continue;
          const qualifier = match[1];
          const separator = qualifier ? line.slice(match.index + qualifier.length, match.index + qualifier.length + 2) : '';
          if (language === 'rust' ? (qualifier ? separator === '::' && qualifiers.has(qualifier) : imported)
            : (qualifier ? separator.startsWith('.') && qualifier === packages[directoryOf(file)] : samePackage)) {
            sites.push({ file: other, index });
          }
        }
      });
    }
    references.set(key, sites);
    return sites;
  };
  const live = new Map();
  const isLive = (file, fn, visiting) => {
    const key = `${file}\n${fn.name}`;
    if (live.has(key)) return live.get(key);
    if (fn.name === 'main' || (language === 'go' && fn.name === 'init')
      || fn.attributes.some((attribute) => attribute.startsWith('#[tauri::command') || attribute.startsWith('//export '))) {
      live.set(key, true);
      return true;
    }
    if (visiting.has(key)) return false;
    visiting.add(key);
    const result = referencesOf(file, fn.name)
      .filter((site) => site.file !== file || site.index < fn.start || site.index > fn.end)
      .some((site) => counts(site, visiting));
    visiting.delete(key);
    // A negative result computed while another function is in progress can depend on that function, so only a result that
    // depends on no function in progress is kept.
    if (result || visiting.size === 0) live.set(key, result);
    return result;
  };
  const counts = (site, visiting = new Set()) => {
    const fn = enclosingFreeFunction(language, lines[site.file], site.index);
    return !fn || isLive(site.file, fn, visiting);
  };
  return { lines, counts };
}

/**
 * Returns a failure for each platform method that no host source outside src/platform calls. A Rust method is called as
 * `.name(` or `::name(`; a Go method is called as `.Name(` or passed as the method value `.Name`. A call counts only when its site
 * counts by the rules of `callerGraph`, so a call in a free function that only tests reach is not a caller. The sources are the
 * production sources of the language host library outside src/platform, without test files; scope names the language, the
 * framework adapter and the applications that link the library ({path: source}) and, for Rust, the library crate ({root, name})
 * and the crates of the framework adapters (adapterCrates, each {root, name} with the root by its path in the repository).
 */
export function auditPlatformCallers(host, methods, sources, scope) {
  const all = Object.fromEntries([
    ...Object.entries(sources),
    ...Object.entries(scope.applications).map(([file, source]) => [`${APPLICATION}${file}`, source]),
  ].map(([file, source]) => [file, withoutCommentLines(source)]));
  const graph = callerGraph(scope.language, all, scope);
  return methods
    .filter((name) => {
      const pattern = new RegExp(`(\\.|::)${escapeRegExp(name)}\\b`);
      return !Object.entries(graph.lines).some(([file, lines]) =>
        lines.some((line, index) => pattern.test(line) && graph.counts({ file, index })));
    })
    .sort()
    .map((name) => `${host} platform method ${name} has no caller outside src/platform`);
}

// The configuration predicate of an item that only test builds compile: `test`, or `all(...)` with `test` as one of its terms.
const testOnlyConfiguration = (predicate) => predicate === 'test'
  || /^all\((.*)\)$/.test(predicate) && predicate.slice(4, -1).split(',').map((term) => term.trim()).includes('test');

/**
 * Removes each item of a Rust source that only test builds compile: the `#[cfg(test)]` or `#[cfg(all(test, ...))]` line, the
 * attributes that follow it and the item. The sources are formatted by rustfmt, so an item whose first line ends with `;` is that
 * line, and any other item ends at the line `}` or `};` at the indentation of its attribute.
 */
export function withoutRustTestItems(source) {
  const lines = source.split('\n');
  const kept = [];
  for (let index = 0; index < lines.length; index += 1) {
    const configuration = lines[index].match(/^(\s*)#\[cfg\((.*)\)\]\s*$/);
    if (!configuration || !testOnlyConfiguration(configuration[2].trim())) {
      kept.push(lines[index]);
      continue;
    }
    const [, indent] = configuration;
    let first = index + 1;
    while (first < lines.length && lines[first].trimStart().startsWith('#[')) first += 1;
    let last = first;
    if (!(lines[first] ?? '').trimEnd().endsWith(';')) {
      last = lines.findIndex((line, at) => at > first && (line === `${indent}}` || line === `${indent}};`));
      if (last < 0) throw new Error(`the ${lines[index].trim()} item at line ${index + 1} has no closing line at its indentation`);
    }
    index = last;
  }
  return kept.join('\n');
}

/**
 * Reads the product sources of a host: every file with the extension under directory, outside the platform folder, without test
 * files (names that end in `_test` before the extension). Returns the text of each file by its path relative to directory.
 */
export function hostProductSources(directory, extension) {
  const sources = {};
  for (const entry of readdirSync(directory, { recursive: true, withFileTypes: true })) {
    const file = relative(directory, join(entry.parentPath, entry.name)).split(sep).join('/');
    if (!entry.isFile() || !file.endsWith(extension) || file.endsWith(`_test${extension}`) || file.startsWith('platform/')) continue;
    sources[file] = readFileSync(join(directory, file), 'utf8');
  }
  return Object.fromEntries(Object.entries(sources).sort(([left], [right]) => left.localeCompare(right)));
}

/** Judges propositions 1, 2, 3 and 6 on the injected sources and returns the list of failures. */
export function auditHostParity({ tauriv2Runtime, tauriv2Bindings, wailsv3Runtime, wailsv3HostSources,
  tauriv2EndpointSource, wailsv3EndpointSource, wailsv3DiagnosticsSource,
  hostContractSpec, tauriv2MenuSource, wailsv3MenuSource, hostsSpec, endpointSpec,
  tauriv2DeclarationSource, wailsv3DeclarationSource, browserStorageSource, workbenchDeclarationSource,
  tauriv2PlatformSource, wailsv3PlatformSource, tauriv2ProductSources, wailsv3ProductSources,
  tauriv2ApplicationSources, wailsv3ApplicationSources, tauriv2Crate, tauriv2AdapterCrate }) {
  const failures = [];
  const tauriv2 = {
    calls: runtimeCalls(tauriv2Runtime, 'const COMMAND = {', 'tauriv2 runtime'),
    handlers: rustHandlers(tauriv2Bindings),
  };
  const wailsv3 = {
    calls: runtimeCalls(wailsv3Runtime, 'const METHOD = {', 'wailsv3 runtime'),
    methods: goHostMethods(wailsv3HostSources),
  };
  for (const name of [...tauriv2.calls].filter((item) => !wailsv3.calls.has(item)).sort()) {
    failures.push(`tauriv2 host.call(${name}) does not exist on wailsv3`);
  }
  for (const name of [...wailsv3.calls].filter((item) => !tauriv2.calls.has(item)).sort()) {
    failures.push(`wailsv3 host.call(${name}) does not exist on tauriv2`);
  }
  for (const name of [...tauriv2.calls].filter((item) => !tauriv2.handlers.has(item)).sort()) {
    failures.push(`tauriv2 host.call(${name}) has no registered handler`);
  }
  for (const name of [...wailsv3.calls].filter((item) => !wailsv3.methods.has(item)).sort()) {
    failures.push(`wailsv3 host.call(${name}) has no Host method`);
  }
  const endpointT = rustEndpointMethods(tauriv2EndpointSource);
  const endpointW = goEndpointMethods(wailsv3EndpointSource, wailsv3DiagnosticsSource);
  const allowed = allowedEndpointMethods(hostsSpec);
  for (const [name, left, right] of [
    ['endpoint base methods', endpointT.base, endpointW.base],
    ['endpoint diagnostics methods', endpointT.diagnostics, endpointW.diagnostics],
  ]) {
    for (const method of [...left].filter((item) => !right.has(item) && !allowed.rust.has(item)).sort()) {
      failures.push(`tauriv2 ${name} has "${method}" that wailsv3 does not`);
    }
    for (const method of [...right].filter((item) => !left.has(item) && !allowed.go.has(item)).sort()) {
      failures.push(`wailsv3 ${name} has "${method}" that tauriv2 does not`);
    }
  }
  const documented = specDiagnosticMethods(endpointSpec);
  for (const [host, methods] of [['tauriv2', endpointT.diagnostics], ['wailsv3', endpointW.diagnostics]]) {
    for (const method of [...methods].filter((item) => !documented.has(item)).sort()) {
      failures.push(`${host} diagnostic method "${method}" is not in the diagnostic builds table of the endpoint specification`);
    }
  }
  for (const method of [...documented].filter((item) => !endpointT.diagnostics.has(item) && !endpointW.diagnostics.has(item)).sort()) {
    failures.push(`the diagnostic builds table of the endpoint specification lists "${method}", which no host declares`);
  }
  failures.push(...auditMenuTables(specMenuTables(hostContractSpec), rustMenuTables(tauriv2MenuSource),
    goMenuTables(wailsv3MenuSource)));
  failures.push(...auditCommonOnlyKeys(commonOnlyKeys({ tauriv2DeclarationSource, wailsv3DeclarationSource, browserStorageSource, workbenchDeclarationSource })));
  const tauriv2Callers = Object.fromEntries(Object.entries(tauriv2ProductSources)
    .map(([file, source]) => [file, withoutRustTestItems(source)]));
  failures.push(...auditPlatformCallers('tauriv2', rustPlatformMethods(tauriv2PlatformSource), tauriv2Callers,
    { language: 'rust', crate: tauriv2Crate, adapterCrates: tauriv2AdapterCrate ? [tauriv2AdapterCrate] : [], applications: tauriv2ApplicationSources }));
  failures.push(...auditPlatformCallers('wailsv3', goPlatformMethods(wailsv3PlatformSource), wailsv3ProductSources,
    { language: 'go', applications: wailsv3ApplicationSources }));
  return failures;
}

/**
 * Reads the library crate of a Cargo manifest: the source path of `[lib]` relative to `src/` and the crate name, which is the
 * package name with `-` replaced by `_`.
 */
export function libraryCrate(manifest, file) {
  const name = manifest.match(/^\[package\]\n(?:[^\[][^\n]*\n)*?name = "([^"]+)"/m)?.[1];
  const path = manifest.match(/^\[lib\]\n(?:[^\[][^\n]*\n)*?path = "src\/([^"]+)"/m)?.[1];
  if (!name || !path) throw new Error(`${file} declares no package name or no [lib] path under src/`);
  return { root: path, name: name.replaceAll('-', '_') };
}

if (process.argv[1] && process.argv[1].endsWith('check-host-parity.mjs')) {
  const read = (path) => readFileSync(join(ROOT, path), 'utf8');
  // The sources of an application that links a host, by their path in the repository.
  const applicationSources = (directory, extension) => Object.fromEntries(
    Object.entries(hostProductSources(join(ROOT, directory), extension)).map(([file, source]) => [`${directory}/${file}`, source]));
  const wailsv3Sources = {};
  for (const file of readdirSync(join(ROOT, 'packages/host/go/src'))) {
    if (file.endsWith('.go') && !file.endsWith('_test.go')) {
      wailsv3Sources[file] = read(join('packages/host/go/src', file));
    }
  }
  const failures = auditHostParity({
    tauriv2Runtime: read('apps/tauriv2/runtime/index.js'),
    tauriv2Bindings: read('packages/host/tauriv2/src/bindings.rs'),
    wailsv3Runtime: read('apps/wailsv3/runtime/index.js'),
    wailsv3HostSources: wailsv3Sources,
    tauriv2EndpointSource: read('packages/host/rust/src/endpoint.rs'),
    wailsv3EndpointSource: read('packages/host/go/src/endpoint.go'),
    wailsv3DiagnosticsSource: read('packages/host/go/src/diagnostics.go'),
    hostContractSpec: read('docs/spec/host-contract.md'),
    tauriv2MenuSource: read('packages/host/rust/src/menu.rs'),
    wailsv3MenuSource: read('packages/host/go/src/menu.go'),
    hostsSpec: read('docs/spec/hosts.md'),
    endpointSpec: read('docs/spec/endpoint.md'),
    tauriv2DeclarationSource: read('packages/host/rust/src/workbench.json'),
    wailsv3DeclarationSource: read('packages/host/go/src/workbench.json'),
    browserStorageSource: read('apps/browser/runtime/browser-storage.js'),
    workbenchDeclarationSource: read('packages/workbench/workbench.json'),
    tauriv2PlatformSource: read('packages/host/rust/src/platform/platform.rs'),
    wailsv3PlatformSource: read('packages/host/go/src/platform/platform.go'),
    tauriv2ProductSources: hostProductSources(join(ROOT, 'packages/host/rust/src'), '.rs'),
    wailsv3ProductSources: hostProductSources(join(ROOT, 'packages/host/go/src'), '.go'),
    tauriv2ApplicationSources: { ...applicationSources('packages/host/tauriv2/src', '.rs'), ...applicationSources('apps/tauriv2/src', '.rs') },
    wailsv3ApplicationSources: { ...applicationSources('packages/host/wailsv3/src', '.go'), ...applicationSources('apps/wailsv3/src', '.go') },
    tauriv2Crate: libraryCrate(read('packages/host/rust/Cargo.toml'), 'packages/host/rust/Cargo.toml'),
    tauriv2AdapterCrate: ((crate) => ({ ...crate, root: `packages/host/tauriv2/src/${crate.root}` }))(
      libraryCrate(read('packages/host/tauriv2/Cargo.toml'), 'packages/host/tauriv2/Cargo.toml')),
  });
  for (const failure of failures) console.error(`FAIL: ${failure}`);
  if (failures.length > 0) {
    console.error(`host parity: ${failures.length} difference(s)`);
    process.exit(1);
  }
  console.log('Host parity passed: host.call names, handler wiring, endpoint method sets, the diagnostic builds table, menu tables and common-only keys are equal, and every platform method has a caller');
}
