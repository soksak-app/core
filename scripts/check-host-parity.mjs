// Mechanically compares the public API surfaces of the two hosts (docs/spec/host-parity.md).
//
// Proposition 1 (public bindings) checks the set of host.call names that each frontend runtime accepts and whether each name is actually connected
// to the implementation of each host. Proposition 2 (endpoint methods) compares the set of endpoint methods that each host declares
// per build flavor. Proposition 3 (menu contract table) checks that the menu table of the host contract specification and the menu builder tables of both hosts are the same.
// The comparison of the actual menu bar belongs to the window check layer, and propositions 4 and 5 are the next extension.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
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

/** The set of command names that the Rust `bindings!` block defines; the same macro generates the registration. */
export function rustHandlers(bindings) {
  const start = bindings.indexOf('\nbindings! {');
  if (start < 0) throw new Error('bindings.rs has no bindings! block');
  return new Set([...bindings.slice(start).matchAll(/#\[tauri::command[^\]]*\]\s*(?:async\s+)?fn ([a-z][a-z0-9_]*)\(/g)]
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
  const assigned = (source) => [...source.matchAll(/^\s*diagnostic(Methods|Subscriptions)\["([a-z][a-z0-9_.]*)"\] =/gm)]
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

/**
 * Reads the endpoint methods that exist on one host only from the allowed differences table of the host specification
 * (docs/spec/hosts.md). A row whose ID is E<number> declares endpoint methods; its Wails and Tauri cells list method names
 * in backticks or `none`.
 */
export function allowedEndpointMethods(hostsMarkdown) {
  const start = hostsMarkdown.indexOf('## Allowed differences');
  if (start < 0) throw new Error('hosts spec has no Allowed differences section');
  const end = hostsMarkdown.indexOf('\n## ', start + 1);
  const section = hostsMarkdown.slice(start, end < 0 ? undefined : end);
  const allowed = { wailsv3: new Set(), tauriv2: new Set() };
  for (const line of section.split('\n')) {
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    if (!/^E\d+$/.test(cells[0] ?? '')) continue;
    for (const [host, cell] of [['wailsv3', cells[1]], ['tauriv2', cells[2]]]) {
      if (cell === 'none') continue;
      const names = [...cell.matchAll(/`([a-z][a-z0-9_.]*)`/g)].map((match) => match[1]);
      if (names.length === 0) throw new Error(`hosts spec row ${cells[0]} has no method name or none in the ${host} cell: ${cell}`);
      for (const name of names) allowed[host].add(name);
    }
  }
  return allowed;
}

/** Judges propositions 1, 2, and 3 on the injected sources and returns the list of failures. */
export function auditHostParity({ tauriv2Runtime, tauriv2Bindings, wailsv3Runtime, wailsv3HostSources,
  tauriv2EndpointSource, wailsv3EndpointSource, wailsv3DiagnosticsSource,
  hostContractSpec, tauriv2MenuSource, wailsv3MenuSource, hostsSpec }) {
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
    for (const method of [...left].filter((item) => !right.has(item) && !allowed.tauriv2.has(item)).sort()) {
      failures.push(`tauriv2 ${name} has "${method}" that wailsv3 does not`);
    }
    for (const method of [...right].filter((item) => !left.has(item) && !allowed.wailsv3.has(item)).sort()) {
      failures.push(`wailsv3 ${name} has "${method}" that tauriv2 does not`);
    }
  }
  failures.push(...auditMenuTables(specMenuTables(hostContractSpec), rustMenuTables(tauriv2MenuSource),
    goMenuTables(wailsv3MenuSource)));
  return failures;
}

if (process.argv[1] && process.argv[1].endsWith('check-host-parity.mjs')) {
  const read = (path) => readFileSync(join(ROOT, path), 'utf8');
  const wailsv3Sources = {};
  for (const file of readdirSync(join(ROOT, 'packages/host/wailsv3/src'))) {
    if (file.endsWith('.go') && !file.endsWith('_test.go')) {
      wailsv3Sources[file] = read(join('packages/host/wailsv3/src', file));
    }
  }
  const failures = auditHostParity({
    tauriv2Runtime: read('apps/tauriv2/runtime/index.js'),
    tauriv2Bindings: read('packages/host/tauriv2/src/bindings.rs'),
    wailsv3Runtime: read('apps/wailsv3/runtime/index.js'),
    wailsv3HostSources: wailsv3Sources,
    tauriv2EndpointSource: read('packages/host/tauriv2/src/endpoint.rs'),
    wailsv3EndpointSource: read('packages/host/wailsv3/src/endpoint.go'),
    wailsv3DiagnosticsSource: read('packages/host/wailsv3/src/diagnostics.go'),
    hostContractSpec: read('docs/spec/host-contract.md'),
    tauriv2MenuSource: read('packages/host/tauriv2/src/menu.rs'),
    wailsv3MenuSource: read('packages/host/wailsv3/src/menu.go'),
    hostsSpec: read('docs/spec/hosts.md'),
  });
  for (const failure of failures) console.error(`FAIL: ${failure}`);
  if (failures.length > 0) {
    console.error(`host parity: ${failures.length} difference(s)`);
    process.exit(1);
  }
  console.log('Host parity passed: host.call names, handler wiring, endpoint method sets, and menu tables are equal');
}
