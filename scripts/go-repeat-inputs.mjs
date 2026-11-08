// Resolves native artifacts from the selected public Go import graph before a
// test binary is built. Artifact paths belong to pkg-config or explicit inputs.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST = 'github.com/soksak-app/core/packages/host/';
const PRODUCTION_DYNAMIC = new Set([
  HOST + 'mygo/src/platform/darwin/bindings',
  HOST + 'go/tests/platform/darwin/standalone/dynamic',
]);
const TEST_DYNAMIC = new Set([
  HOST + 'mygo/tests/platform/darwin/bindings',
  HOST + 'go/tests/platform/darwin/standalone/testdynamic',
  HOST + 'go/tests/platform/darwin/testlibrary',
]);
const CALLBACK_ABI = HOST + 'mygo/tests/platform/darwin/nativecallback';
const CALLBACK_WORKER = HOST + 'mygo/tests/platform/darwin/nativeworker';
const STATIC_INPUTS = [
  ['soksak-darwin', 'SOKSAK_DARWIN_LIBRARY'],
  ['soksak-host-test', 'SOKSAK_HOST_TEST_LIBRARY'],
];

// `go list -json` emits adjacent JSON objects, not an array. Parse the stream
// without depending on indentation or on braces embedded in string values.
function graphObjects(text) {
  const objects = [];
  let start = -1, depth = 0, quoted = false, escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (start < 0) {
      if (/\s/.test(char)) continue;
      if (char !== '{') throw new Error('native Go input graph is not a JSON object stream');
      start = index;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) {
      objects.push(JSON.parse(text.slice(start, index + 1)));
      start = -1;
    }
  }
  if (start >= 0) throw new Error('native Go input graph contains an incomplete JSON object');
  return objects;
}

function artifact(path, name) {
  if (!path || !isAbsolute(path)) throw new Error(`${name} must name an absolute native artifact path`);
  let info;
  try { info = statSync(path); }
  catch (error) { throw new Error(`${name} native artifact ${path}: ${error.message}`); }
  if (!info.isFile()) throw new Error(`${name} native artifact ${path} is not a regular file`);
  return path;
}

/**
 * Resolves a selected graph with its CGO profile, before native bindings run.
 * `run` has execFileSync's signature and exists for deterministic owner tests.
 * Returns a complete selected environment; never mutates the caller's object.
 */
export function resolveGoNativeInputs({ patterns, tags = '', cwd = process.cwd(), env = process.env, run = execFileSync }) {
  const selected = { ...env };
  const execute = (command, args) => String(run(command, args, {
    cwd, env: selected, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  })).trim();
  const profile = execute('go', ['env', 'CGO_ENABLED']);
  if (profile !== '0' && profile !== '1') throw new Error(`selected Go CGO_ENABLED is invalid: ${JSON.stringify(profile)}`);
  selected.CGO_ENABLED = profile;
  const cgoEnabled = profile === '1';
  const packages = typeof patterns === 'string' ? [patterns] : patterns;
  if (!packages?.length) throw new Error('native Go input discovery requires selected package patterns');
  // Error/DepsErrors in -e metadata describe packages that still need their
  // mandatory test build. This resolver classifies artifact inputs only: it
  // never treats graph listing as evidence that a package compiled. Both test
  // runners subsequently build every selected test package and report failures
  // with its package name, including malformed test sources and dependencies.
  const graph = graphObjects(execute('go', ['list', '-deps', '-test', '-e', '-json', ...(tags ? ['-tags', tags] : []), ...packages]));
  // A dynamic artifact is loaded by a test executable, so only the packages that a test main links select one: a selected
  // package that no test executable links, such as a binding of another host under a shared pattern, needs no artifact.
  // A static artifact is read when cgo compiles a package, so every listed package selects it.
  const linked = new Set();
  for (const node of graph) {
    if (node.ImportPath?.endsWith('.test')) for (const id of node.Deps ?? []) linked.add(id);
  }
  const imports = new Set();
  const pkgConfig = new Set();
  for (const node of graph) {
    // Public ForTest identifies augmented test packages; Dir never selects an ABI.
    if (node.ImportPath && linked.has(node.ImportPath)) {
      for (const id of [node.ImportPath, node.ForTest]) {
        if (id) imports.add(id.replace(/ \[.*\]$/, ''));
      }
    }
    if (cgoEnabled) for (const name of node.CgoPkgConfig ?? []) pkgConfig.add(name);
  }
  const needs = [];
  if ([...PRODUCTION_DYNAMIC].some((id) => imports.has(id))) needs.push(['SOKSAK_NATIVE_LIBRARY', 'soksak-darwin', 'dynamic_library']);
  if ([...TEST_DYNAMIC].some((id) => imports.has(id))) needs.push(['SOKSAK_NATIVE_TEST_LIBRARY', 'soksak-host-test', 'dynamic_library']);
  if (imports.has(CALLBACK_ABI)) needs.push(['SOKSAK_NATIVE_CALLBACK_ABI_LIBRARY', 'soksak-host-test', 'callback_abi_library']);
  if (imports.has(CALLBACK_WORKER)) needs.push(['SOKSAK_NATIVE_CALLBACK_WORKER_LIBRARY', 'soksak-host-test', 'callback_worker_library']);
  // Validate every explicit override before querying any absent artifact. Empty
  // values are explicit errors, not permission to choose a different artifact.
  for (const [variable] of needs) {
    if (Object.hasOwn(selected, variable)) artifact(selected[variable], variable);
  }
  const pc = (name, variable) => execute('pkg-config', [`--variable=${variable}`, name]);
  for (const [variable, name, key] of needs) {
    if (!Object.hasOwn(selected, variable)) selected[variable] = artifact(pc(name, key), `${name} ${key}`);
  }
  for (const [name, define] of STATIC_INPUTS) {
    if (!pkgConfig.has(name)) continue;
    const path = artifact(pc(name, 'static_library'), `${name} static_library`);
    const digest = createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16);
    const previous = (selected.CGO_CFLAGS ?? '').replace(new RegExp(`(?:^|\\s)-D${define}=\\S+`, 'g'), '').trim();
    selected.CGO_CFLAGS = [previous, `-D${define}=${digest}`].filter(Boolean).join(' ');
  }
  return { env: selected, cgoEnabled };
}

// Diagnostic output is intentionally restricted to native/CGO configuration.
const DIAGNOSTIC_ENV = [
  'CGO_ENABLED', 'CGO_CFLAGS', 'CGO_CPPFLAGS', 'CGO_CXXFLAGS', 'CGO_LDFLAGS',
  'SOKSAK_NATIVE_LIBRARY', 'SOKSAK_NATIVE_TEST_LIBRARY',
  'SOKSAK_NATIVE_CALLBACK_ABI_LIBRARY', 'SOKSAK_NATIVE_CALLBACK_WORKER_LIBRARY',
];
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const [pattern, tags = ''] = process.argv.slice(2);
    const result = resolveGoNativeInputs({ patterns: [pattern].filter(Boolean), tags });
    process.stdout.write(JSON.stringify({ cgoEnabled: result.cgoEnabled,
      env: Object.fromEntries(DIAGNOSTIC_ENV.filter((key) => Object.hasOwn(result.env, key)).map((key) => [key, result.env[key]])) }) + '\n');
  } catch (error) {
    process.stderr.write(`native Go inputs: ${error.message}${error.stderr ? `\n${error.stderr}` : ''}\n`);
    process.exitCode = 1;
  }
}
