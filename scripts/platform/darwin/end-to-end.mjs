// The macOS operations of the end-to-end run (docs/operations/examples.md#end-to-end-run).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { crashFault } from '../../crash-fault.mjs';

/** The Quit item of the application menu has the key equivalent Command+Q, which host.menu writes as `cmd+q`. */
export function quitShortcut() {
  return { name: 'Command+Q', menuKey: 'cmd+q', key: 'q', text: 'q', modifiers: ['command'] };
}

/** The native end-to-end targets are targets of the native library in native/darwin. */
export function nativeEndToEndCommand(target) {
  return ['make', '-C', 'native/darwin', target];
}

/**
 * lockf(1) takes the flock(2) lock that the host holds for its life, and the kernel wakes it when the owner exits, so the wait needs
 * no polling; it ends with another status than 0 when `seconds` pass first.
 */
export function lockReleaseCommand(lock, seconds) {
  return ['lockf', '-s', '-t', String(seconds), lock, 'true'];
}

/** `ps` lists every process with its full command. */
export function processTableCommand() {
  return ['ps', '-axo', 'pid=,command='];
}

/** The .ips reports that the system wrote for `app` into ~/Library/Logs/DiagnosticReports since `since` (ms), each with its fault. */
export function crashReports(app, since, { folder = join(homedir(), 'Library', 'Logs', 'DiagnosticReports') } = {}) {
  if (!existsSync(folder)) return [];
  return readdirSync(folder)
    .filter((name) => name.startsWith(`sok-${app}-`) && name.endsWith('.ips'))
    .map((name) => join(folder, name))
    .filter((file) => statSync(file).mtimeMs >= since)
    .map((file) => `${file}: ${JSON.stringify(crashFault(readFileSync(file, 'utf8'), file))}`);
}
