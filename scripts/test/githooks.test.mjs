// The git hooks of this repository run pnpm in the root of the checkout (#F918). pnpm takes a node_modules that is a symbolic
// link into another checkout for the install of that checkout and removes it for the install of this one, so every hook refuses
// that form with an error that names the link before it runs pnpm.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** A git repository whose node_modules is a symbolic link into another checkout, the form a worktree takes when its install is linked. */
function linkedRepository(holder) {
  const other = join(holder, "other-checkout");
  mkdirSync(other);
  const repository = join(holder, "repository");
  execFileSync("git", ["init", "-q", repository]);
  symlinkSync(other, join(repository, "node_modules"));
  return repository;
}

test("every git hook refuses a node_modules that is a symbolic link into another checkout before it runs pnpm", { timeout: 20_000 }, (t) => {
  const holder = mkdtempSync(join(tmpdir(), "soksak-hooks-"));
  t.after(() => rmSync(holder, { recursive: true, force: true }));
  const repository = linkedRepository(holder);
  const message = join(holder, "message");
  writeFileSync(message, "test(scope): Subject (#F918)\n");
  for (const [hook, args] of [["pre-commit", []], ["commit-msg", [message]], ["pre-push", ["origin"]]]) {
    const done = spawnSync("sh", [join(ROOT, ".githooks", hook), ...args], { cwd: repository, encoding: "utf8" });
    assert.notEqual(done.status, 0, `${hook} passes a linked node_modules`);
    assert.ok((done.stderr ?? "").includes(`${repository}/node_modules is a symbolic link to`),
      `${hook} names the link, but answered ${JSON.stringify(done.stderr ?? done.stdout)}`);
  }
});
