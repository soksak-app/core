// Runs the benchmarks of the hosts, each benchmark as a process of its own with its own limit, through the test runner
// (docs/operations/examples.md#test-runner). A Go benchmark is one `Benchmark` function of a package: the package is compiled once with
// `go test -c`, and each matching function runs as `<binary> -test.run ^$ -test.bench ^<name>$ -test.benchtime 1x`. A Rust benchmark is
// one bench target with its own main, which prints its measurements, so each target runs as one command. The output of a benchmark is
// its measurement, so it is printed after the line that names its result. A benchmark over its limit is killed and reported as TIME.
// Usage: node scripts/benchmarks.mjs go <package> <regexp> [--timeout <seconds>] [--tags <tags>] [--ldflags=<flags>]
//        node scripts/benchmarks.mjs cargo <name> [--timeout <seconds>] -- <command> [arguments...]
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { runTests } from './test-runner.mjs';

/** The limit of one benchmark when `--timeout` is not given. */
export const BENCHMARK_TIMEOUT_MS = 300_000;

/** The names of the benchmarks in the output of `<binary> -test.list`. */
export function benchmarkNames(listing) {
  return listing.split('\n').filter((line) => /^Benchmark[A-Za-z0-9_]*$/.test(line));
}

/** Runs one benchmark and prints its result line and its output, which is the measurement. Resolves with the exit status. */
async function runOne(item, timeoutMs, write) {
  const { results } = await runTests({ tests: [{ ...item, timeoutMs }], concurrency: 1, write });
  const result = results.get(item.name);
  if (result.status === 'pass') {
    for (const line of result.output.split('\n')) if (line !== '') write(line);
  }
  return result.status === 'pass' ? 0 : 1;
}

/** Runs the Go benchmarks of `pkg` whose names match `pattern`, each with `timeoutMs`. Resolves with the exit status. */
export async function runGoBenchmarks({ pkg, pattern, tags = '', ldflags = '', timeoutMs, write }) {
  const folder = mkdtempSync(join(tmpdir(), 'soksak-go-benchmarks-'));
  try {
    const binary = join(folder, 'benchmark.binary');
    const tagArgs = tags ? ['-tags', tags] : [];
    execFileSync('go', ['test', '-c', '-o', binary, ...tagArgs, ...(ldflags ? ['-ldflags', ldflags] : []), pkg], { stdio: ['ignore', 'pipe', 'inherit'] });
    const listed = benchmarkNames(execFileSync(binary, ['-test.list', '.*'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }));
    const chosen = listed.filter((name) => new RegExp(pattern).test(name));
    if (chosen.length === 0) throw new Error(`${pkg} has no benchmark matching ${pattern}`);
    let status = 0;
    for (const name of chosen) {
      const item = { name, command: binary, args: ['-test.run', '^$', '-test.bench', `^${name}$`, '-test.benchtime', '1x'] };
      status = Math.max(status, await runOne(item, timeoutMs, write));
    }
    return status;
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

/** Runs one Rust bench target with `command` as one benchmark with `timeoutMs`. Resolves with the exit status. */
export async function runCargoBenchmark({ name, command, timeoutMs, write }) {
  return runOne({ name, command: command[0], args: command.slice(1) }, timeoutMs, write);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [mode, ...rest] = process.argv.slice(2);
  const write = (line) => process.stdout.write(`${line}\n`);
  const fail = (error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  };
  if (mode === 'go') {
    const { values, positionals } = parseArgs({
      args: rest, strict: true, allowPositionals: true,
      options: { timeout: { type: 'string' }, tags: { type: 'string' }, ldflags: { type: 'string' } },
    });
    const timeoutMs = values.timeout === undefined ? BENCHMARK_TIMEOUT_MS : Number(values.timeout) * 1000;
    if (positionals.length !== 2) throw new Error('usage: benchmarks.mjs go <package> <regexp>');
    runGoBenchmarks({ pkg: positionals[0], pattern: positionals[1], tags: values.tags, ldflags: values.ldflags, timeoutMs, write })
      .then((code) => { process.exitCode = code; }, fail);
  } else if (mode === 'cargo') {
    const separator = rest.indexOf('--');
    if (separator < 1 || rest[0].startsWith('--')) throw new Error('usage: benchmarks.mjs cargo <name> [--timeout <seconds>] -- <command> [arguments...]');
    const { values } = parseArgs({ args: rest.slice(1, separator), strict: true, options: { timeout: { type: 'string' } } });
    const timeoutMs = values.timeout === undefined ? BENCHMARK_TIMEOUT_MS : Number(values.timeout) * 1000;
    runCargoBenchmark({ name: rest[0], command: rest.slice(separator + 1), timeoutMs, write })
      .then((code) => { process.exitCode = code; }, fail);
  } else {
    throw new Error('the first argument is go or cargo');
  }
}
