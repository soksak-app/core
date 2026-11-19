// The declared macOS application artifact: an application bundle (docs/spec/hosts.md).
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

/** The bundle of application `app` in the build output `folder`, `<folder>/sok-<app>.app`. */
export function applicationArtifact(folder, app) {
  return join(folder, `sok-${app}.app`);
}

/** The application and the command line `sok` of the bundle `artifact`, both in its Contents/MacOS. */
export function applicationExecutables(artifact, app) {
  const executables = join(artifact, 'Contents', 'MacOS');
  return { application: join(executables, `sok-${app}`), sok: join(executables, 'sok') };
}

/**
 * Verifies the signature of the bundle `artifact` and every code inside it with `codesign --verify --deep --strict`, the check that
 * the system makes before it starts a bundle; a bundle whose files no longer match its signature rejects with the output of codesign.
 */
export async function verifyApplicationArtifact(artifact) {
  try {
    await promisify(execFile)('codesign', ['--verify', '--deep', '--strict', artifact], { encoding: 'utf8' });
  } catch (error) {
    const reason = typeof error.stderr === 'string' && error.stderr.trim() !== '' ? error.stderr.trim() : error.message;
    throw new Error(`the bundle ${artifact} does not verify: ${reason}`);
  }
}
