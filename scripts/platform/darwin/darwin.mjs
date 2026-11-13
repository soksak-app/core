// The macOS implementation of the platform operations of scripts/platform/platform.js. The selector loads this module only when an
// operation runs for the platform `darwin`.
import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { promisify } from 'node:util';
import { macosMinimum } from '../../macos-minimum.mjs';

export { applicationArtifact, applicationExecutables } from './artifacts.mjs';
export { crashReports, listProcesses, openApplication, quitApplication, runNativeTests, waitForLockRelease } from './end-to-end.mjs';
export { processExecutable } from './process-executable.mjs';
export { launchdServices as processServices, sampleProcess as processStacks } from '@soksak/window-check/stall-sample.mjs';

/**
 * The folder of the temporary folders of a test run. The temporary folder of the user has 49 bytes, which leaves the sockets of the
 * host tests too little room, so the folders lie in `/tmp`, with its symbolic links resolved so that the path a test resolves has the
 * same length.
 */
export function processFolderRoot() {
  return realpathSync('/tmp');
}

/**
 * The JSON AST of clang for the Objective-C translation unit `file`, compiled as cgo compiles the darwin layer: with blocks, with the
 * modules of the Apple frameworks (`#import <Cocoa/Cocoa.h>`) and for the macOS minimum of the Makefile, without warnings.
 */
export async function objectiveCSyntaxTree(file, { cwd, defines, includes }) {
  const args = ['-x', 'objective-c', '-fmodules', '-fblocks', `-mmacosx-version-min=${macosMinimum()}`, '-w', '-fsyntax-only',
    '-Xclang', '-ast-dump=json', ...defines, ...includes.flatMap((folder) => ['-I', folder]), file];
  const { stdout } = await promisify(execFile)('clang', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 30 });
  return stdout;
}
