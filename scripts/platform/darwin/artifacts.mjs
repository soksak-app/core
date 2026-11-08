// The declared macOS application artifact: an application bundle (docs/spec/hosts.md).
import { join } from 'node:path';

/** The bundle of application `app` in the build output `folder`, `<folder>/sok-<app>.app`. */
export function applicationArtifact(folder, app) {
  return join(folder, `sok-${app}.app`);
}

/** The application and the command line `sok` of the bundle `artifact`, both in its Contents/MacOS. */
export function applicationExecutables(artifact, app) {
  const executables = join(artifact, 'Contents', 'MacOS');
  return { application: join(executables, `sok-${app}`), sok: join(executables, 'sok') };
}
