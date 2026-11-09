// A temporary folder of a run that is removed when the run ends: by its owner when the run returns or throws, and here when the
// run is ended by SIGINT, SIGTERM or SIGHUP, which skip the `finally` of the owner. After the removal the signal ends the process
// as it would have, so the caller sees the same exit.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/**
 * Creates a folder with the name prefix `prefix` and mode 0700 in `parent`, by default the temporary folder. `remove` removes it and its
 * signal handlers.
 */
export function temporaryFolder(prefix, parent = tmpdir()) {
  const path = mkdtempSync(join(parent, prefix));
  const handlers = new Map();
  const remove = () => {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    handlers.clear();
    rmSync(path, { recursive: true, force: true });
  };
  for (const signal of SIGNALS) {
    const handler = () => {
      remove();
      process.kill(process.pid, signal);
    };
    handlers.set(signal, handler);
    process.once(signal, handler);
  }
  return { path, remove };
}
