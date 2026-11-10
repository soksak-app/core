// The Linux implementation of the platform operations of scripts/platform/platform.js. The selector loads this module only when an
// operation runs for the platform `linux`; an operation that this module does not export throws PlatformOperationNotImplemented.
import { realpathSync } from 'node:fs';

export { processExecutable } from './process-executable.mjs';

/**
 * The folder of the temporary folders of a test run: `/tmp` with its symbolic links resolved, as on macOS, so that the sockets of
 * the host tests keep the same room under the limit of a socket path on every unix system.
 */
export function processFolderRoot() {
  return realpathSync('/tmp');
}
