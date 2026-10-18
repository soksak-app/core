// Runs a check command with a temporary folder of its own and fails when the check leaves a folder or file with the prefix
// `soksak-` in it (docs/operations/examples.md#temporary-folders):
//   node scripts/temp-audit.mjs <command> [arguments...]
// The command runs with TMPDIR set to a new empty folder, so the folders that other processes write to the system temporary
// folder at the same time are not counted. The entries `soksak-check-*` are the configuration folders of the window checks,
// which live across runs by design, so they are not counted. The audit removes its folder when the command ends.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The entries of a temporary folder that a check left: the names with the prefix `soksak-` except `soksak-check-*`. */
export function leftovers(names) {
  return names.filter((name) => name.startsWith('soksak-') && !name.startsWith('soksak-check-')).sort();
}

/** Runs the command in a new temporary folder and returns the exit status of the audit. */
export function audit(command, args, { write = (line) => process.stdout.write(`${line}\n`), parent = tmpdir() } = {}) {
  const folder = mkdtempSync(join(parent, 'temp-audit-'));
  try {
    const result = spawnSync(command, args, { stdio: 'inherit', env: { ...process.env, TMPDIR: `${folder}/` } });
    if (result.error) throw new Error(`temp-audit: ${command} could not start: ${result.error.message}`);
    const left = leftovers(readdirSync(folder));
    for (const name of left) write(`TEMP LEFT ${join(folder, name)}`);
    write(left.length === 0
      ? `TEMP PASS ${command} ${args.join(' ')} left no soksak- entry in its temporary folder`
      : `TEMP FAIL ${command} ${args.join(' ')} left ${left.length} soksak- entries in its temporary folder`);
    if (result.status !== 0) write(`TEMP ${command} ${args.join(' ')} exited with ${result.status ?? result.signal}`);
    return result.status === 0 && left.length === 0 ? 0 : 1;
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  if (command === undefined) {
    process.stderr.write('temp-audit requires a command: node scripts/temp-audit.mjs <command> [arguments...]\n');
    process.exitCode = 2;
  } else {
    try {
      process.exitCode = audit(command, args);
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    }
  }
}
