import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runE2E } from "../run.mjs";

const runner = fileURLToPath(new URL("../run.mjs", import.meta.url));

test("runE2E rejects missing or partial metadata before injected operations", async (t) => {
  for (const env of [{}, { SOKSAK_RUN_ID: "run-only" }, { SOKSAK_RUN_FOLDER: "/tmp/folder-only" }]) {
    await t.test(JSON.stringify(env), () => {
      let baselineCalls = 0;
      let spawnCalls = 0;
      let reported = "";
      const status = runE2E({
        args: ["--test", "fixture.test.mjs"], env,
        baselineEnvironment: () => { baselineCalls += 1; return {}; },
        spawn: () => { spawnCalls += 1; return { status: 0 }; },
        stderr: { write: (message) => { reported += message; } },
      });
      assert.equal(status, 1);
      assert.equal(baselineCalls, 0);
      assert.equal(spawnCalls, 0);
      assert.match(reported, /SOKSAK_RUN_ID and SOKSAK_RUN_FOLDER/);
    });
  }
});

test("runE2E passes both metadata values through unchanged", () => {
  const env = { SOKSAK_RUN_ID: "opaque/id", SOKSAK_RUN_FOLDER: "/tmp/run folder" };
  let received;
  const status = runE2E({
    args: ["--test", "fixture.test.mjs"], env,
    baselineEnvironment: ({ env: baselineEnv }) => {
      assert.equal(baselineEnv, env);
      return { SOKSAK_WINDOW_CHECK_BASELINE: "baseline-json" };
    },
    spawn: (_executable, args, options) => {
      received = { args, env: options.env };
      return { status: 0 };
    },
    stderr: { write: (message) => { throw new Error(message); } },
  });
  assert.equal(status, 0);
  assert.deepEqual(received.args, ["--test", "fixture.test.mjs"]);
  assert.equal(received.env.SOKSAK_RUN_ID, env.SOKSAK_RUN_ID);
  assert.equal(received.env.SOKSAK_RUN_FOLDER, env.SOKSAK_RUN_FOLDER);
  assert.equal(received.env.SOKSAK_WINDOW_CHECK_BASELINE, "baseline-json");
});

async function runWithMetadata(metadata) {
  const directory = await mkdtemp(join(tmpdir(), "soksak-e2e-run-metadata-"));
  const probe = join(directory, "baseline-probe");
  const child = join(directory, "child-started");
  const osascript = join(directory, "osascript");
  const childTest = join(directory, "child.test.mjs");
  await writeFile(osascript, `#!/bin/sh\nprintf x >> "$SOKSAK_BASELINE_PROBE"\nprintf '%s\\n' '{"pid":1,"name":"Baseline","bundle":"test.baseline"}'\n`);
  await chmod(osascript, 0o755);
  await writeFile(childTest, `import { writeFileSync } from "node:fs";\nwriteFileSync(process.env.SOKSAK_CHILD_MARKER, JSON.stringify({id: process.env.SOKSAK_RUN_ID ?? null, folder: process.env.SOKSAK_RUN_FOLDER ?? null}));\n`);
  const env = { ...process.env, PATH: `${directory}:${process.env.PATH}`, SOKSAK_BASELINE_PROBE: probe,
    SOKSAK_CHILD_MARKER: child };
  delete env.NODE_TEST_CONTEXT;
  delete env.SOKSAK_RUN_ID;
  delete env.SOKSAK_RUN_FOLDER;
  Object.assign(env, metadata);
  const result = spawnSync(process.execPath, [runner, "--test", childTest], { cwd: process.cwd(), env, encoding: "utf8" });
  try {
    return {
      result,
      probed: await readFile(probe, "utf8").catch(() => null),
      child: await readFile(child, "utf8").catch(() => null),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("run requires both run metadata values before baseline probe or child start", async (t) => {
  for (const metadata of [{}, { SOKSAK_RUN_ID: "run-only" }, { SOKSAK_RUN_FOLDER: "/tmp/folder-only" }]) {
    await t.test(JSON.stringify(metadata), async () => {
      const { result, probed, child } = await runWithMetadata(metadata);
      assert.deepEqual({ probed, child, status: result.status }, { probed: null, child: null, status: 1 },
        "invalid run metadata must fail before baseline probe and child start");
    });
  }
});

test("run forwards valid run metadata unchanged", async () => {
  const expected = { SOKSAK_RUN_ID: "run/opaque id", SOKSAK_RUN_FOLDER: "/tmp/run folder/child" };
  const { result, probed, child } = await runWithMetadata(expected);
  assert.equal(result.status, 0, result.stderr);
  assert.notEqual(probed, null);
  assert.notEqual(child, null, `child did not write metadata: ${result.stdout}\n${result.stderr}`);
  assert.deepEqual(JSON.parse(child), { id: expected.SOKSAK_RUN_ID, folder: expected.SOKSAK_RUN_FOLDER });
});
