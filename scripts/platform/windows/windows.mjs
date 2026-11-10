// The Windows implementation of the platform operations of scripts/platform/platform.js. The selector loads this module only when an
// operation runs for the platform `win32`; an operation that this module does not export throws PlatformOperationNotImplemented.
import { tmpdir } from 'node:os';

/** The folder of the temporary folders of a test run: Windows has no limit of a socket path, so it keeps its temporary folder. */
export function processFolderRoot() {
  return tmpdir();
}
