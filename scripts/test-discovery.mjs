// Finds the tests of Go packages and Rust packages so that each test runs as a process of its own
// (docs/operations/examples.md#test-runner). A package is built first, through the runner, so the build reports its elapsed
// time too; then the test binary lists its tests, and every test becomes one process with the working directory that
// `go test` and `cargo test` give it.
import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { runTests } from './test-runner.mjs';

const execFileAsync = promisify(execFile);

/** The limit of a build, which compiles a package and its dependencies. */
export const BUILD_TIMEOUT_MS = 300_000;

/**
 * The tests of the Go packages that match `patterns` (relative to `cwd`). `tags` is a build tag list and `ldflags` the link
 * flags; `buildDir` receives the test binaries. Returns `{tests, failures}`: `tests` are runner items with `testName` (the
 * name `go test -json` gives) and `failures` name the packages whose build failed.
 */
export async function discoverGo({ patterns, cwd, tags, ldflags, buildDir, id, write, concurrency }) {
  mkdirSync(buildDir, { recursive: true });
  const tagArgs = tags ? ['-tags', tags] : [];
  const listed = await execFileAsync('go', ['list', ...tagArgs, '-f', '{{if or .TestGoFiles .XTestGoFiles}}{{.ImportPath}} {{.Dir}}{{end}}', ...patterns], { cwd, maxBuffer: 1 << 24 });
  const packages = listed.stdout.split('\n').filter((line) => line !== '').map((line) => {
    const [importPath, dir] = line.split(' ');
    return { importPath, dir };
  });
  const builds = packages.map((pkg, index) => ({
    name: `build ${id} ${pkg.importPath}`, command: 'go', cwd,
    args: ['test', '-c', '-o', join(buildDir, `${id}-${index}.test`), ...tagArgs, ...(ldflags ? ['-ldflags', ldflags] : []), pkg.importPath],
    timeoutMs: BUILD_TIMEOUT_MS,
  }));
  const built = builds.length === 0 ? { results: new Map() } : await runTests({ tests: builds, concurrency, defaultTimeoutMs: BUILD_TIMEOUT_MS, write });
  const tests = [];
  const failures = [];
  for (const [index, pkg] of packages.entries()) {
    if (built.results.get(builds[index].name).status !== 'pass') {
      failures.push(`${id}: the build of ${pkg.importPath} failed`);
      continue;
    }
    const binary = join(buildDir, `${id}-${index}.test`);
    const names = await execFileAsync(binary, ['-test.list', '.'], { cwd: pkg.dir, maxBuffer: 1 << 24 });
    for (const testName of names.stdout.split('\n').filter((line) => /^(Test|Example)/.test(line))) {
      tests.push({ name: `${id} ${pkg.importPath}.${testName}`, run: id, testName, command: binary,
        args: ['-test.run', `^${testName}$`, '-test.count=1', '-test.v'], cwd: pkg.dir });
    }
  }
  return { tests, failures };
}

/**
 * The tests of the Rust package `packageName` built with `features`. `cargo test --no-run` builds the test executables; each
 * executable lists its tests and every test runs as `<executable> --exact <name>` in the folder of its manifest. Returns the
 * same `{tests, failures}` as discoverGo; a test that is `#[ignore]` is listed and its result is `skip`.
 */
export async function discoverRust({ packageName, features, cwd, env, id, write }) {
  const build = await runTests({
    tests: [{ name: `build ${id}`, command: 'cargo', cwd, env, timeoutMs: BUILD_TIMEOUT_MS,
      args: ['test', '-p', packageName, ...(features ? ['--features', features] : []), '--no-run', '--message-format=json'] }],
    concurrency: 1, defaultTimeoutMs: BUILD_TIMEOUT_MS, write: () => {},
  });
  const result = build.results.get(`build ${id}`);
  write(`${result.status === 'pass' ? 'PASS' : 'FAIL'} build ${id} ${(result.elapsedMs / 1000).toFixed(3)}s`);
  if (result.status !== 'pass') return { tests: [], failures: [`${id}: the build failed`] };
  const executables = [];
  for (const line of result.output.split('\n')) {
    if (!line.startsWith('{')) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.reason === 'compiler-artifact' && message.profile?.test && message.executable) {
      executables.push({ executable: message.executable, dir: dirname(message.manifest_path), target: message.target.name });
    }
  }
  const tests = [];
  for (const { executable, dir, target } of executables) {
    const listed = await execFileAsync(executable, ['--list', '--format', 'terse'], { cwd: dir, maxBuffer: 1 << 24 });
    for (const line of listed.stdout.split('\n')) {
      const match = line.match(/^(.+): test$/);
      if (match) tests.push({ name: `${id} ${target}::${match[1]}`, run: id, testName: match[1], command: executable, args: ['--exact', match[1]], cwd: dir, env });
    }
  }
  return { tests, failures: [] };
}

/**
 * The status of a finished test for the contract audit: `skip` for a Go test that skipped itself (`--- SKIP`) and for a Rust
 * test that was ignored, else the runner status; a test over its limit is a failure.
 */
export function auditStatus(result) {
  if (result.status === 'pass' && (/^--- SKIP: /m.test(result.output) || /\b0 passed\b.*\b[1-9]\d* ignored\b/.test(result.output))) return 'skip';
  return { pass: 'pass', fail: 'fail', timeout: 'fail' }[result.status];
}
