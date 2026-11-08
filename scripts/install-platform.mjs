// Installs the locked workspace dependencies for one operating system: every workspace project except those whose package.json
// `os` field excludes that system. pnpm runs the lifecycle scripts of every workspace project without reading its `os` field, so
// a plain install on Linux would run the `prepare` of a darwin-only project, which builds native code against Apple frameworks.
// The script imports only Node built-ins, because it runs before the dependencies exist.
//
//   node scripts/install-platform.mjs <platform> [pnpm install options]     e.g. linux, or linux --offline
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

/** Whether the `os` field of a manifest (absent, or a list of names and `!name` exclusions) admits `platform`, as npm reads it. */
export function admits(os, platform) {
  if (os === undefined) return true;
  if (!Array.isArray(os) || os.some((name) => typeof name !== "string")) throw new Error(`os must be a list of names, found ${JSON.stringify(os)}`);
  if (os.includes(`!${platform}`)) return false;
  const allowed = os.filter((name) => !name.startsWith("!"));
  return allowed.length === 0 || allowed.includes(platform);
}

/** The workspace projects (`{name, os}`) that `platform` excludes, by name in the given order. */
export function excludedProjects(projects, platform) {
  return projects.filter((project) => !admits(project.os, platform)).map((project) => project.name);
}

/** The workspace projects of the checkout `root` as `{folder, name, os}`, the root first. */
export function workspaceProjects(root) {
  const listed = JSON.parse(execFileSync("pnpm", ["-r", "list", "--json", "--depth", "-1"], { cwd: root, encoding: "utf8" }));
  return listed.map((item) => {
    const manifest = JSON.parse(readFileSync(join(item.path, "package.json"), "utf8"));
    return { folder: relative(root, item.path) || ".", name: manifest.name, os: manifest.os };
  });
}

/** The arguments of the pnpm install of `platform`: the locked install with one `--filter !<name>` per excluded project. */
export function installArguments(projects, platform, options = []) {
  return ["install", "--frozen-lockfile", ...options, ...excludedProjects(projects, platform).map((name) => `--filter=!${name}`)];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [platform, ...options] = process.argv.slice(2);
  if (!platform || platform.startsWith("-")) {
    process.stderr.write("usage: node scripts/install-platform.mjs <platform> [pnpm install options]\n");
    process.exit(2);
  }
  const args = installArguments(workspaceProjects(ROOT), platform, options);
  process.stdout.write(`pnpm ${args.join(" ")}\n`);
  execFileSync("pnpm", args, { cwd: ROOT, stdio: "inherit" });
}
