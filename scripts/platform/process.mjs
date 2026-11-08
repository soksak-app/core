// Runs a program for a platform implementation. Only the platform implementations under scripts/platform/<platform>/ call it: the
// program and its arguments are a detail of the implementation, and the callers of scripts/platform/platform.js receive the result of
// the operation, never the program.
import { spawn } from 'node:child_process';
import { once } from 'node:events';

/**
 * Runs `file` with `args` to its end and resolves with `{code, signal}`. An abort of `signal` ends the program with SIGTERM; the
 * promise still resolves with the end of the program. A program that cannot start rejects with `cannot start <file>: <reason>`.
 */
export async function runProgram({ file, args }, { cwd, env, stdio = 'ignore', signal } = {}) {
  const child = spawn(file, args, { cwd, env, stdio });
  const stop = () => child.kill('SIGTERM');
  signal?.addEventListener('abort', stop, { once: true });
  try {
    return await Promise.race([
      once(child, 'exit').then(([code, ended]) => ({ code, signal: ended })),
      once(child, 'error').then(([error]) => { throw new Error(`cannot start ${file}: ${error.message}`); }),
    ]);
  } finally {
    signal?.removeEventListener('abort', stop);
  }
}

/** The end of a program as the messages of an operation name it: `code <n>` or `signal <name>`. */
export const describeEnd = ({ code, signal }) => (signal === null ? `code ${code}` : `signal ${signal}`);
