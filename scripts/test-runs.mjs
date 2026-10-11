// Keeps and removes the runs of the test runner under target/test-runs (docs/operations/examples.md#test-runner).
//   node scripts/test-runs.mjs prune    removes the runs without a failure and the runs whose failures a classification names.
// A run holds `manifest.json` and the output of each test. A run with a test that did not pass, or that stopped, stays until
// `classified.json` (an array of `{name, record}`) names every such test with the record that classifies it.
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

function readJson(path, check) {
  let value;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${path}: ${error.message}`, { cause: error });
  }
  check?.(value, path);
  return value;
}

/** The runs under `<root>/target/test-runs` that can be removed (`removed`) and those that stay with the reason (`kept`). */
export function pruneRuns(root) {
  const base = join(root, 'target', 'test-runs');
  const removed = [];
  const kept = [];
  if (!existsSync(base)) return { removed, kept };
  for (const id of readdirSync(base).sort()) {
    const folder = join(base, id);
    const manifest = readJson(join(folder, 'manifest.json'));
    const unfinished = manifest.tests.filter((item) => item.status !== 'pass').map((item) => item.name);
    const classifiedPath = join(folder, 'classified.json');
    const classified = existsSync(classifiedPath)
      ? readJson(classifiedPath, (value, path) => {
        if (!Array.isArray(value) || value.some((item) => typeof item?.name !== 'string' || typeof item?.record !== 'string')) {
          throw new Error(`${path}: expected an array of {name, record}, found ${JSON.stringify(value).slice(0, 80)}`);
        }
      }).map((item) => item.name)
      : [];
    const open = unfinished.filter((name) => !classified.includes(name));
    if (open.length === 0) {
      rmSync(folder, { recursive: true });
      removed.push(id);
    } else {
      kept.push({ run: id, reason: `unclassified failures: ${open.join(', ')}` });
    }
  }
  return { removed, kept };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv[2] !== 'prune') throw new Error('usage: node scripts/test-runs.mjs prune');
    const { removed, kept } = pruneRuns(ROOT);
    for (const id of removed) process.stdout.write(`removed ${id}\n`);
    for (const item of kept) process.stdout.write(`kept ${item.run}: ${item.reason}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
