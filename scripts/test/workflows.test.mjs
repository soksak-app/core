// Checks the workflows of .github/workflows against docs/operations/examples.md#continuous-integration: every runner label is
// a hosted label of the repository or a label that the document declares, and the window-check workflow runs the checks, then
// the audit of the run folder, and keeps the run folder of a failed job.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const WORKFLOWS = join(ROOT, '.github', 'workflows');
const HOSTED = ['macos-15', 'ubuntu-26.04-arm'];

const read = (path) => readFileSync(join(ROOT, path), 'utf8');

/** The labels that examples.md declares for the self-hosted runner: the three backticked words after `the labels`. */
function declaredLabels() {
  const match = /the labels `([^`]+)`, `([^`]+)` and `([^`]+)`/.exec(read('docs/operations/examples.md'));
  assert.ok(match, 'docs/operations/examples.md does not declare the labels of the self-hosted runner');
  return match.slice(1);
}

/** The labels that a workflow names after `runs-on:`, as a flow list `[a, b]` or one word. */
function runnerLabels(text) {
  return [...text.matchAll(/^\s*runs-on:\s*(.+)$/gm)].map((match) => match[1].trim().replace(/^\[|\]$/g, '').split(',').map((label) => label.trim()));
}

/** The steps of the job of a workflow as `{name, text}`; a step starts with `      - ` at the indentation of a job step. */
function steps(text) {
  return text.split(/^ {6}- /m).slice(1).map((step) => ({ name: /^name:\s*(.+)$/m.exec(step)?.[1] ?? step.split('\n')[0], text: step }));
}

test('every runner label of a workflow is hosted or declared in examples.md', () => {
  const allowed = new Set([...HOSTED, ...declaredLabels()]);
  const files = readdirSync(WORKFLOWS).filter((name) => name.endsWith('.yml'));
  assert.ok(files.length > 0, 'no workflow file');
  for (const file of files) {
    for (const labels of runnerLabels(readFileSync(join(WORKFLOWS, file), 'utf8'))) {
      for (const label of labels) assert.ok(allowed.has(label), `${file}: the runner label ${label} is neither hosted nor declared in docs/operations/examples.md`);
    }
  }
});

test('the window-check workflow runs on the declared self-hosted labels', () => {
  const [labels] = runnerLabels(read('.github/workflows/window-checks.yml'));
  assert.deepEqual(labels, declaredLabels());
});

test('the window-check workflow names the window checks, the audit step and the artifact of a failed job', () => {
  const text = read('.github/workflows/window-checks.yml');
  const list = steps(text);
  const index = (name) => {
    const found = list.findIndex((step) => step.name === name);
    assert.notEqual(found, -1, `the workflow has no step named ${name}`);
    return found;
  };
  const checks = list[index('Window checks')];
  assert.match(checks.text, /run: pnpm verify:windows --when-idle 45$/m);
  const audit = list[index('Audit of the logs')];
  assert.match(audit.text, /run: node scripts\/audit-run\.mjs "\$\{\{ steps\.run\.outputs\.folder \}\}"$/m);
  assert.match(audit.text, /if: always\(\)/, 'the audit also runs when a check failed');
  assert.ok(index('Audit of the logs') > index('Window checks'), 'the audit follows the checks');
  const locate = list[index('Locate the run folder')];
  assert.match(locate.text, /target\/test-runs\//, 'the audited folder is a run folder of target/test-runs');
  const keep = list[index('Keep the run folder')];
  assert.match(keep.text, /if: failure\(\)/);
  assert.match(keep.text, /uses: actions\/upload-artifact@v4/);
  assert.match(keep.text, /core\/\$\{\{ steps\.run\.outputs\.folder \}\}/, 'the artifact holds the run folder');
  assert.ok(index('Keep the run folder') > index('Audit of the logs'), 'the artifact is taken after the audit');
});

test('the push check runs every check of the structure step and the format and clippy checks of ci', () => {
  const ci = read('.github/workflows/ci.yml');
  const targets = (name) => {
    const step = steps(ci).find((item) => item.name === name);
    assert.ok(step, `ci.yml has no step ${name}`);
    return /run:\s*make -C core (.+)$/m.exec(step.text)[1].trim().split(/\s+/);
  };
  const wanted = [...targets('Structure checks'), ...targets('Host tests').filter((target) => target !== 'host-contract-check')];
  const recipe = /^push-check:[^\n]*\n((?:\t[^\n]*\n)+)/m.exec(read('Makefile'));
  assert.ok(recipe, 'the Makefile has no push-check target');
  const named = recipe[0];
  assert.deepEqual(wanted.filter((target) => !named.includes(target)), [], `push-check does not run: ${wanted.join(' ')}`);
  assert.match(read('.githooks/pre-push'), /make -C "\$\(git rev-parse --show-toplevel\)" push-check/);
});
