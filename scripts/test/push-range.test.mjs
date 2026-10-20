// Checks the commit ranges that the pre-push hook derives from the ref lines git gives it (scripts/push-range.mjs).
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const script = fileURLToPath(new URL("../push-range.mjs", import.meta.url));
const ZERO = "0".repeat(40);

function git(cwd, ...args) {
  return execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "user.name=test", "-c", "user.email=test@example.com", ...args], { cwd, encoding: "utf8" }).trim();
}

// A bare remote named origin with main pushed, and a work repository whose origin points at it.
function repositories(t) {
  const root = mkdtempSync(join(tmpdir(), "push-range-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const remote = join(root, "origin.git");
  const work = join(root, "work");
  git(root, "init", "-q", "--bare", "-b", "main", remote);
  git(root, "init", "-q", "-b", "main", work);
  git(work, "remote", "add", "origin", remote);
  writeFileSync(join(work, "a.txt"), "a\n");
  git(work, "add", "a.txt");
  git(work, "commit", "-q", "-m", "base");
  git(work, "push", "-q", "origin", "main");
  return work;
}

function runScript(cwd, input, remote = "origin") {
  const result = spawnSync(process.execPath, [script, remote], { cwd, input, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test("a new branch without upstream resolves the commits that origin/main does not have", (t) => {
  const work = repositories(t);
  git(work, "checkout", "-q", "-b", "feat/new");
  writeFileSync(join(work, "b.txt"), "b\n");
  git(work, "add", "b.txt");
  git(work, "commit", "-q", "-m", "new commit");
  const local = git(work, "rev-parse", "HEAD");
  const base = git(work, "rev-parse", "origin/main");
  assert.throws(() => git(work, "rev-parse", "--abbrev-ref", "@{upstream}"));

  const ranges = runScript(work, `refs/heads/feat/new ${local} refs/heads/feat/new ${ZERO}\n`);

  assert.equal(ranges, `origin/main..${local}`);
  const commits = git(work, "rev-list", ranges).split("\n");
  assert.deepEqual(commits, [local]);
  assert.ok(!commits.includes(base));
});

test("an existing remote branch resolves the commits after its remote sha", (t) => {
  const work = repositories(t);
  git(work, "checkout", "-q", "-b", "feat/tracked");
  git(work, "push", "-q", "origin", "feat/tracked");
  const remoteSha = git(work, "rev-parse", "HEAD");
  writeFileSync(join(work, "c.txt"), "c\n");
  git(work, "add", "c.txt");
  git(work, "commit", "-q", "-m", "second commit");
  const local = git(work, "rev-parse", "HEAD");

  const ranges = runScript(work, `refs/heads/feat/tracked ${local} refs/heads/feat/tracked ${remoteSha}\n`);

  assert.equal(ranges, `${remoteSha}..${local}`);
});

test("a deleted ref sends no commits", (t) => {
  const work = repositories(t);
  const local = git(work, "rev-parse", "HEAD");

  const ranges = runScript(work, `(delete) ${ZERO} refs/heads/gone ${local}\n`);

  assert.equal(ranges, "");
});
