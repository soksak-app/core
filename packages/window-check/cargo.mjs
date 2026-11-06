// The cargo that the scripts and the checks of the repository start. The Makefile exports CARGO, the cargo that it resolved, and
// cargo sets CARGO for the processes that it starts, so CARGO comes first. Without it the order is the order of the Makefile: the
// cargo folder of rustup, $CARGO_HOME/bin or ~/.cargo/bin when CARGO_HOME is not set, before PATH, so the rustup proxy, which
// selects the toolchain of rust-toolchain.toml, runs instead of another cargo of PATH. A shell that did not read the profile of
// rustup has no cargo folder in its PATH (docs/operations/examples.md).
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

function executable(file) {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/** The path of cargo for the environment `env`. A CARGO that is no executable file and no cargo at all are errors. */
export function cargoCommand(env = process.env) {
  if (env.CARGO) {
    if (!executable(env.CARGO)) throw new Error(`CARGO names ${env.CARGO}, which is no executable file`);
    return env.CARGO;
  }
  const toolchain = join(env.CARGO_HOME || join(env.HOME || homedir(), ".cargo"), "bin");
  for (const folder of [toolchain, ...(env.PATH ?? "").split(delimiter).filter(Boolean)]) {
    if (executable(join(folder, "cargo"))) return join(folder, "cargo");
  }
  throw new Error(`cargo is in neither ${toolchain} nor PATH; rustup installs it in $CARGO_HOME/bin`);
}
