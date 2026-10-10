// Local endpoint transport of Windows: a named pipe.
export const name = "windows";
export const transport = "pipe";

/** Creates a named pipe name per process. The pipe is removed when the server closes, so remove has nothing to do. */
export function createAddress(label) {
  return { address: `\\\\.\\pipe\\${label}-${process.pid}`, remove: () => {} };
}
