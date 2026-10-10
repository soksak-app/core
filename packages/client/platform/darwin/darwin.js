// Local endpoint transport of darwin: a Unix domain socket in an owner-only directory.
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const name = "darwin";
export const transport = "unix";

/** Creates the socket path in a temporary directory with permission 0700. remove deletes the directory. */
export function createAddress(label) {
  const directory = mkdtempSync(join(tmpdir(), `${label}-`));
  chmodSync(directory, 0o700);
  return {
    address: join(directory, "endpoint.sock"),
    remove: () => rmSync(directory, { recursive: true, force: true }),
  };
}
