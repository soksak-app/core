// The minimum macOS version of the repository, which `MACOS_MINIMUM` of the Makefile declares, and the warnings of the macOS
// linker that the runners judge (docs/spec/hosts.md#nativedarwin, docs/operations/examples.md#test-parity). Every compile and
// every external link uses the declared minimum, so a warning that an object was built for a newer macOS version than the link
// means that a compile or a link took another version: the build or test that printed it fails.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

/** The value of `MACOS_MINIMUM` in the Makefile of `root`. A Makefile that declares no version is an error that names the file. */
export function macosMinimum(root = ROOT) {
  const file = join(root, 'Makefile');
  const value = readFileSync(file, 'utf8').match(/^MACOS_MINIMUM = (\d+\.\d+(?:\.\d+)?)$/m)?.[1];
  if (value === undefined) throw new Error(`${file} declares no MACOS_MINIMUM = <macOS version>`);
  return value;
}

// ld prints the object, which can be a member of a static library (`lib.a[2](file.o)`), the version that it was built for and the
// version of the link. rustc prints the same line after `linker stderr: `, also inside the JSON messages of cargo.
const NEWER = /ld: warning: object file \((.+?)\) was built for newer '([^']+)' version \(([\d.]+)\) than being linked \(([\d.]+)\)/g;
// cmd/go adds -lobjc to the link flags of each package that has Objective-C files, and the link of the Wails host holds two such
// packages (the application package of the framework and the darwin layer of the Go host library), so ld reports the second
// -lobjc. No link flag of this repository names -lobjc, and the warning ends only with a cmd/go release that removes the
// repeated flag (F667-1), so the warning is held and does not fail a build.
const DUPLICATE_LIBRARIES = /ld: warning: ignoring duplicate libraries: ([^\n"\\]+)/g;

/**
 * The linker warnings in `output`, each once: `failures` are the objects built for a newer macOS version than the link, with the
 * object and both versions, and `held` the warnings that F667-1 holds.
 */
export function linkerWarnings(output) {
  const failures = new Set();
  for (const [, object, platform, built, linked] of output.matchAll(NEWER)) {
    failures.add(`ld built ${object} for ${platform} ${built}, newer than the ${platform} ${linked} of the link`);
  }
  const held = new Set();
  for (const [, libraries] of output.matchAll(DUPLICATE_LIBRARIES)) held.add(`ld ignored duplicate libraries: ${libraries.trim()}`);
  return { failures: [...failures], held: [...held] };
}

/**
 * Runs a build command (`go test -c`, `cargo test --no-run`) to its end and resolves with its standard output. Its standard error
 * is written to the standard error of the caller as it arrives. A command that fails rejects with an error with its `status` and
 * `stdout`; a command whose output holds a linker failure of `linkerWarnings` rejects with an error that names the command and
 * each failure.
 */
export function runBuild(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => {
      stderr.push(chunk);
      process.stderr.write(chunk);
    });
    child.once('error', reject);
    child.once('close', (status, signal) => {
      const out = Buffer.concat(stdout).toString('utf8');
      if (status !== 0) {
        reject(Object.assign(new Error(`${command} ${args.join(' ')} exited with ${status ?? signal}`), { status, stdout: out }));
        return;
      }
      const { failures } = linkerWarnings(`${out}\n${Buffer.concat(stderr).toString('utf8')}`);
      if (failures.length > 0) reject(new Error(`${command} ${args.join(' ')}: ${failures.join('; ')}`));
      else resolve(out);
    });
  });
}
