// The macOS operations of the end-to-end run (docs/operations/examples.md#end-to-end-run).
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { crashFault } from '../../crash-fault.mjs';
import { describeEnd, runProgram } from '../process.mjs';

/** The Quit item of the application menu has the key equivalent Command+Q, which host.menu writes as `cmd+q`. */
const QUIT_MENU_KEY = 'cmd+q';
const QUIT_KEY = Object.freeze({ key: 'q', text: 'q', modifiers: ['command'] });

/** The endpoint error of a window that does not exist (docs/spec/endpoint.md). */
const WINDOW_GONE = 1003;

/**
 * Quits the application of the endpoint `client` as a person does: `menu` performs the item of the application menu whose key
 * equivalent is Command+Q with host.menu.select, and `key` sends Command+Q down and up to a window with input.key. Returns the name
 * of the action for the messages of the step.
 */
export async function quitApplication(client, by) {
  if (by === 'menu') {
    const { menus } = await client.request('status.get', { window: 'main', name: 'host.menu' });
    const menu = menus.find((entry) => entry.items.some((item) => item.key === QUIT_MENU_KEY));
    if (menu === undefined) throw new Error(`the application menu has no item with the key equivalent ${QUIT_MENU_KEY}`);
    const { title } = menu.items.find((item) => item.key === QUIT_MENU_KEY);
    const reply = await client.request('command.run', { window: 'main', name: 'host.menu.select', params: { menu: menu.title, title } });
    if (reply !== null) throw new Error(`host.menu.select of ${title} returned ${JSON.stringify(reply)}, expected null`);
    return `the item ${title}`;
  }
  if (by === 'key') {
    const [first] = await client.request('windows.list', {});
    if (first === undefined) throw new Error('the application has no window to take Command+Q');
    const press = async (phase) => {
      const reply = await client.request('input.key', { window: first.window, ...QUIT_KEY, phase });
      if (reply !== null) throw new Error(`input.key ${phase} of Command+Q returned ${JSON.stringify(reply)}, expected null`);
    };
    await press('down');
    // The key down starts the quit, which closes the window and may end the process before the key up arrives. The up of a person
    // then reaches no window of the application, so an up that finds the window gone (1003) or the connection closed completes the
    // press.
    try {
      await press('up');
    } catch (error) {
      if (error.code !== WINDOW_GONE && !client.closed) throw error;
    }
    return 'Command+Q';
  }
  throw new Error(`unknown quit path ${JSON.stringify(by)}`);
}

/** Runs the target `target` of the native library in native/darwin to its end; another status than 0 rejects. */
export async function runNativeTests(target, { cwd, env, signal } = {}) {
  const end = await runProgram({ file: 'make', args: ['-C', 'native/darwin', target] }, { cwd, env, stdio: 'inherit', signal });
  if (end.code !== 0) throw new Error(`exited with ${describeEnd(end)}`);
}

/** The status of lockf(1) when `-t` passes before it takes the lock: EX_TEMPFAIL of sysexits(3). */
const LOCK_TIMEOUT_STATUS = 75;

/**
 * Resolves with true once no process holds the lock file `lock`, and with false when `seconds` pass first. lockf(1) takes the
 * flock(2) lock that the host holds for its life, and the kernel wakes it when the owner exits, so the wait needs no polling.
 */
export async function waitForLockRelease(lock, seconds, { run = runProgram } = {}) {
  const end = await run({ file: 'lockf', args: ['-s', '-t', String(seconds), lock, 'true'] });
  if (end.code === 0) return true;
  if (end.code === LOCK_TIMEOUT_STATUS) return false;
  throw new Error(`lockf ended with ${describeEnd(end)}`);
}

/** The header of the executable column; its length is the width of that column, PATH_MAX, so no executable path is cut. */
const EXECUTABLE_HEADER = 'E'.repeat(1024);

/**
 * Parses the table of `ps -axww -o pid=PID,ppid=PPID,comm=<EXECUTABLE_HEADER>,args=ARGS` into `{pid, ppid, executable, arguments}`
 * records. The executable column has the fixed width of its header and the arguments column is the rest of each line, so a path
 * with spaces is read whole. `arguments` is the argument vector as ps prints it, joined by spaces.
 */
export function parseProcessTable(text) {
  const [header, ...rows] = text.split('\n');
  const executableStart = header.indexOf(EXECUTABLE_HEADER);
  const argumentsStart = executableStart + EXECUTABLE_HEADER.length + 1;
  if (executableStart < 0 || header.slice(argumentsStart).trim() !== 'ARGS') throw new Error(`the process table has no expected header: ${header.slice(0, 80)}`);
  return rows.filter((row) => row.trim() !== '').map((row) => {
    const ids = /^\s*(\d+)\s+(\d+) $/.exec(row.slice(0, executableStart));
    if (ids === null || row[argumentsStart - 1] !== ' ') throw new Error(`process row ${JSON.stringify(row.slice(0, 120))} does not match the table header`);
    return { pid: Number(ids[1]), ppid: Number(ids[2]), executable: row.slice(executableStart, argumentsStart - 1).trimEnd(), arguments: row.slice(argumentsStart) };
  });
}

/** Lists every process of the system as `{pid, ppid, executable, arguments}` records. */
export async function listProcesses({ execute = promisify(execFile) } = {}) {
  const { stdout } = await execute('ps', ['-axww', '-o', `pid=PID,ppid=PPID,comm=${EXECUTABLE_HEADER},args=ARGS`],
    { encoding: 'utf8', maxBuffer: 1 << 26 });
  return parseProcessTable(stdout);
}

/**
 * The .ips reports that the system wrote for `app` into ~/Library/Logs/DiagnosticReports since `since` (ms), as `{report, fault}`
 * records: the file of the report and the fault that names its address.
 */
export function crashReports(app, since, { folder = join(homedir(), 'Library', 'Logs', 'DiagnosticReports') } = {}) {
  if (!existsSync(folder)) return [];
  return readdirSync(folder)
    .filter((name) => name.startsWith(`sok-${app}-`) && name.endsWith('.ips'))
    .map((name) => join(folder, name))
    .filter((file) => statSync(file).mtimeMs >= since)
    .map((file) => ({ report: file, fault: crashFault(readFileSync(file, 'utf8'), file) }));
}

/**
 * Opens the running application whose executable is `executable` through Launch Services as a person does, which activates it:
 * `open -a` with the bundle that holds the executable.
 */
export async function openApplication(executable, { run = runProgram } = {}) {
  const end = executable.indexOf('.app/');
  if (end < 0) throw new Error(`the executable ${executable} is not inside an application bundle`);
  const opened = await run({ file: 'open', args: ['-a', executable.slice(0, end + '.app'.length)] });
  if (opened.code !== 0) throw new Error(`open ended with ${describeEnd(opened)}`);
}
