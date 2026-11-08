// Checks the install of one operating system: the projects whose `os` field excludes that system are filtered out of the
// locked pnpm install, so their lifecycle scripts do not run there.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { admits, excludedProjects, installArguments, workspaceProjects } from "../install-platform.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

test("the os field admits a platform as npm reads it", { timeout: 1000 }, () => {
  assert.equal(admits(undefined, "linux"), true);
  assert.equal(admits(["darwin"], "linux"), false);
  assert.equal(admits(["darwin"], "darwin"), true);
  assert.equal(admits(["!win32"], "linux"), true);
  assert.equal(admits(["!win32"], "win32"), false);
  assert.equal(admits(["darwin", "!linux"], "linux"), false);
  assert.throws(() => admits("darwin", "linux"), /os must be a list of names/);
});

test("the install of a platform filters out every project whose os field excludes it and keeps the others", { timeout: 1000 }, () => {
  const projects = [{ name: "root" }, { name: "mac", os: ["darwin"] }, { name: "not-windows", os: ["!win32"] }];
  assert.deepEqual(excludedProjects(projects, "linux"), ["mac"]);
  assert.deepEqual(installArguments(projects, "linux", ["--offline"]), ["install", "--frozen-lockfile", "--offline", "--filter=!mac"]);
  assert.deepEqual(installArguments(projects, "darwin"), ["install", "--frozen-lockfile"]);
  assert.deepEqual(installArguments(projects, "win32"), ["install", "--frozen-lockfile", "--filter=!mac", "--filter=!not-windows"]);
});

test("the Linux install of the workspace leaves out every project of native/darwin and every other project whose os field excludes Linux", { timeout: 10_000 }, () => {
  const projects = workspaceProjects(ROOT);
  // Recomputed from each package.json, so a new darwin-only project cannot be missed.
  const darwinOnly = projects.filter(({ folder }) => {
    const { os } = JSON.parse(readFileSync(join(ROOT, folder, "package.json"), "utf8"));
    return os !== undefined && !admits(os, "linux");
  }).map(({ name }) => name);
  assert.deepEqual(excludedProjects(projects, "linux"), darwinOnly);
  const native = projects.filter(({ folder }) => folder.startsWith("native/darwin/"));
  assert.ok(native.length > 0, "the workspace has no project under native/darwin");
  for (const { folder, name } of native) {
    assert.ok(darwinOnly.includes(name), `${folder} builds darwin native code but its package.json does not declare os ["darwin"]`);
  }
  assert.deepEqual(installArguments(projects, "linux").filter((arg) => arg.startsWith("--filter=")),
    darwinOnly.map((name) => `--filter=!${name}`));
});
