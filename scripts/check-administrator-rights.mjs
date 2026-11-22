// Finds the sources of the hosts and of the mygo workbench that name the sudo command, so that no operation of the application needs
// administrator rights (docs/spec/cli.md#agents-in-the-application). The test of packages/sok/go judges the sources of the command line.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const SUDO_FOLDERS = [
  ["packages/host/go/src", ".go"],
  ["packages/host/rust/src", ".rs"],
  ["packages/workbench-mygo/src", ".go"],
];

/** The repository paths of the sources under root that name "sudo"; a folder without a source of its language is an error. */
export function sudoSources(root) {
  const named = [];
  for (const [folder, extension] of SUDO_FOLDERS) {
    const files = readdirSync(join(root, folder), { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
      .map((entry) => join(entry.parentPath, entry.name));
    if (files.length === 0) throw new Error(`${folder} holds no ${extension} source`);
    for (const file of files) if (readFileSync(file, "utf8").includes('"sudo"')) named.push(file.slice(root.length));
  }
  return named;
}
