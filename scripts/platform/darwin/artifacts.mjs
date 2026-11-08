// The declared macOS application artifact: an application bundle (docs/spec/hosts.md).
import { join } from 'node:path';

/** The bundle of application `app` in the build output `folder`, `<folder>/sok-<app>.app`. */
export function applicationBundle(folder, app) {
  return join(folder, `sok-${app}.app`);
}

/** The application and the command line `sok`, both in Contents/MacOS of the bundle. */
export function artifactExecutables(bundle, app) {
  const executables = join(bundle, 'Contents', 'MacOS');
  return { application: join(executables, `sok-${app}`), installer: join(executables, 'sok') };
}
