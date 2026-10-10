// Replaces a staged executable file with a new file.
//
// macOS keeps the code signature information of an executable in the file (vnode). Overwriting a file that has been run at the same
// place leaves the earlier signature information, and the kernel terminates (SIGKILL) a process started with the new content.
// Writing to a temporary file in the same directory and then renaming it makes a new file.
import { copyFileSync, renameSync, rmSync } from "node:fs";

/** Copies from to to. to becomes a new file different from the existing file. The permissions are the same as from. */
export function replaceFile(from, to) {
  const pending = `${to}.partial-${process.pid}`;
  try {
    copyFileSync(from, pending);
    renameSync(pending, to);
  } catch (error) {
    rmSync(pending, { force: true });
    throw error;
  }
}
