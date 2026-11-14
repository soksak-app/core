import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const runner = fileURLToPath(new URL("../run.mjs", import.meta.url));

async function runWithMetadata(metadata) {
  const directory = await mkdtemp(join(tmpdir(), "soksak-e2e-run-metadata-"));
  const child = join(directory, "child-started");
  const childTest = fileURLToPath(new URL("../fixtures/programs/run-child.mjs", import.meta.url));
  const env = { ...process.env, SOKSAK_CHILD_MARKER: child };
  delete env.NODE_TEST_CONTEXT;
  delete env.SOKSAK_RUN_ID;
  delete env.SOKSAK_RUN_FOLDER;
  Object.assign(env, metadata);
  const result = spawnSync(process.execPath, [runner, "--test", childTest], { cwd: process.cwd(), env, encoding: "utf8" });
  try {
    return {
      result,
      child: await readFile(child, "utf8").catch(() => null),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("run requires both run metadata values before child start", async (t) => {
  for (const metadata of [{}, { SOKSAK_RUN_ID: "run-only" }, { SOKSAK_RUN_FOLDER: "/tmp/folder-only" }]) {
    await t.test(JSON.stringify(metadata), async () => {
      const { result, child } = await runWithMetadata(metadata);
      assert.deepEqual({ child, status: result.status }, { child: null, status: 1 },
        "invalid run metadata must fail before child start");
      assert.match(result.stderr, /SOKSAK_RUN_ID and SOKSAK_RUN_FOLDER are required and must both be nonempty/);
    });
  }
});

test("run forwards valid run metadata unchanged", async () => {
  const expected = { SOKSAK_RUN_ID: "run/opaque id", SOKSAK_RUN_FOLDER: "/tmp/run folder/child" };
  const { result, child } = await runWithMetadata(expected);
  assert.equal(result.status, 0, result.stderr);
  assert.notEqual(child, null, `child did not write metadata: ${result.stdout}\n${result.stderr}`);
  assert.deepEqual(JSON.parse(child), { id: expected.SOKSAK_RUN_ID, folder: expected.SOKSAK_RUN_FOLDER });
});

test("run without --test prints its usage and exits 2 before child start", () => {
  const result = spawnSync(process.execPath, [runner, "fixture.test.mjs"], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.equal(result.stderr, "usage: node ./run.mjs --test <node test arguments>\n");
});
