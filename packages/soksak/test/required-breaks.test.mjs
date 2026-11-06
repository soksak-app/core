import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BREAKS } from "../scripts/breaks.mjs";

test("changed implementation owners select only their required defects", { timeout: 1000 }, async () => {
  const { selectRequiredBreaks } = await import("../scripts/required-breaks.mjs");
  assert.deepEqual(selectRequiredBreaks(["unrelated/fixture.js", "docs/features.md"]), []);
  assert.deepEqual(selectRequiredBreaks(["packages/soksak/src/soksak.ts"]).map(({ id }) => id), ["state"]);
  assert.deepEqual(selectRequiredBreaks(["packages/soksak/src/slicing.ts", "packages/soksak/dist/slicing.js"]).map(({ id }) => id), ["slicing"]);
  assert.throws(() => selectRequiredBreaks(["packages/soksak/src/unregistered.ts"]), /no required mutation owner/);
  assert.throws(() => selectRequiredBreaks(["pnpm-lock.yaml", "packages/soksak/src/unregistered.ts"]), /no required mutation owner/);
  assert.deepEqual(selectRequiredBreaks(["packages/soksak/dist/soksak.d.ts"]), []);
});

test("changed owning tests and shared inputs select a bounded declared set", { timeout: 1000 }, async () => {
  const { REQUIRED_BREAKS, selectRequiredBreaks } = await import("../scripts/required-breaks.mjs");
  assert.deepEqual(selectRequiredBreaks(["packages/soksak/test/dom.test.mjs"]).map(({ id }) => id), ["place", "grip-active"]);
  assert.deepEqual(selectRequiredBreaks(["pnpm-lock.yaml"]), REQUIRED_BREAKS);
  assert.deepEqual(selectRequiredBreaks(["packages/soksak/scripts/required-breaks.mjs"]), REQUIRED_BREAKS);
  assert.ok(REQUIRED_BREAKS.length <= 8, "the required gate became an exploratory sweep");
  for (const entry of REQUIRED_BREAKS) {
    assert.ok(BREAKS.some(({ id }) => id === entry.id), `unknown required mutation ${entry.id}`);
    assert.ok(entry.tests.length > 0 && entry.tests.length <= 3, `${entry.id} has no bounded owner selection`);
  }
});

test("changed-file selection reads both revisions and includes deleted owners", { timeout: 10000 }, async (t) => {
  const { changedMutationFiles } = await import("../scripts/required-breaks.mjs");
  const root = await mkdtemp(join(tmpdir(), "soksak-required-history-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "--quiet");
  await mkdir(join(root, "packages/soksak/src"), { recursive: true });
  await writeFile(join(root, "packages/soksak/src/soksak.ts"), "before");
  git("add", ".");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "before");
  const before = git("rev-parse", "HEAD");
  await rm(join(root, "packages/soksak/src/soksak.ts"));
  await writeFile(join(root, "packages/soksak/src/slicing.ts"), "after");
  git("add", ".");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "after");
  const after = git("rev-parse", "HEAD");
  assert.deepEqual(changedMutationFiles(root, `${before}..${after}`).sort(), ["packages/soksak/src/slicing.ts", "packages/soksak/src/soksak.ts"]);
  assert.deepEqual(changedMutationFiles(root, `${"0".repeat(40)}...${after}`), ["packages/soksak/src/slicing.ts"]);
  assert.throws(() => changedMutationFiles(root, ""), /revision range/);
  assert.throws(() => changedMutationFiles(root, "--cached"), /revision range/);
});
