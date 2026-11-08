import { readlink } from 'node:fs/promises';

/**
 * Reads the executable the kernel associates with the live PID from the link /proc/<pid>/exe (proc(5)). The link names the mapped
 * executable, not argv text, which a process can change independently of its executable.
 */
export async function processExecutable(pid, { readLink = readlink } = {}) {
  try {
    return await readLink(`/proc/${pid}/exe`);
  } catch (error) {
    throw new Error(`process executable identity unavailable for PID ${pid}: ${error.message}`);
  }
}
