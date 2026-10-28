// Checks that workflow setup actions resolve toolchains from the repository declarations without fetching packages.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (path) => readFileSync(join(ROOT, path), 'utf8');
const action = (name) => YAML.parse(read(`.github/actions/setup-${name}/action.yml`));

function compositeSteps(name) {
  const parsed = action(name);
  assert.equal(parsed.runs?.using, 'composite', `setup-${name} is not a composite action`);
  return parsed.runs.steps;
}

test('workflow setup actions declare only the shared root and Go module inputs', { timeout: 1000 }, () => {
  for (const name of ['node', 'go', 'rust', 'native']) {
    const inputs = action(name).inputs ?? {};
    const expected = name === 'go' ? ['module', 'root'] : ['root'];
    assert.deepEqual(Object.keys(inputs).sort(), expected, `setup-${name} inputs differ from the workflow contract`);
    assert.equal(inputs.root.default, 'core', `setup-${name} must default root to core`);
    if (name === 'go') assert.equal(inputs.module.default, '.', 'setup-go must default its root-relative module to the workspace root');
  }
});

test('setup-node uses the exact Node and pnpm versions declared by the workspace', { timeout: 1000 }, () => {
  const steps = compositeSteps('node');
  const setupNode = steps.find((step) => step.uses?.startsWith('actions/setup-node@'));
  const setupPnpm = steps.find((step) => step.uses?.startsWith('pnpm/action-setup@'));
  assert.ok(setupNode, 'setup-node does not install Node');
  assert.ok(setupPnpm, 'setup-node does not install pnpm');
  assert.match(setupNode.uses, /@[0-9a-f]{40}$/i, 'setup-node must use an immutable action revision');
  assert.match(setupPnpm.uses, /@[0-9a-f]{40}$/i, 'pnpm/action-setup must use an immutable action revision');
  assert.equal(setupNode.with['node-version-file'], '${{ inputs.root }}/.node-version');
  assert.equal(setupPnpm.with.package_json_file, '${{ inputs.root }}/package.json');
  assert.equal(setupPnpm.with.run_install, false, 'setup-node must not install workspace dependencies');
  assert.equal(read('.node-version').trim(), '26.11.1');
  assert.match(read('package.json'), /"packageManager":\s*"pnpm@11\.24\.0"/);
  assert.doesNotMatch(JSON.stringify(steps), /steps\.pnpm-version\.outputs\.version/,
    'setup-node must let pnpm/action-setup read the declared package manager version');
  assert.doesNotMatch(JSON.stringify(steps), /pnpm install|pnpm fetch|cache:/, 'setup-node must not fetch workspace dependencies');
});

test('setup-go reads the workspace Go version and resolves a module from root', { timeout: 1000 }, () => {
  const steps = compositeSteps('go');
  const setupGo = steps.find((step) => step.uses?.startsWith('actions/setup-go@'));
  assert.ok(setupGo, 'setup-go does not install Go');
  assert.match(setupGo.uses, /@[0-9a-f]{40}$/i, 'setup-go must use an immutable action revision');
  assert.equal(setupGo.with['go-version-file'], '${{ inputs.root }}/go.work');
  const moduleStep = steps.find((step) => step.id === 'module-path');
  assert.ok(moduleStep, 'setup-go does not resolve the selected module directory');
  assert.equal(moduleStep.env.WORKSPACE_ROOT, '${{ inputs.root }}');
  assert.equal(moduleStep.env.MODULE_PATH, '${{ inputs.module }}');
  assert.match(moduleStep.run, /directory="\$WORKSPACE_ROOT\/\$MODULE_PATH"/);
  assert.match(moduleStep.run, /test -d "\$directory"/);
  assert.doesNotMatch(JSON.stringify(steps), /go mod download/, 'setup-go must not fetch Go modules');
  assert.equal(setupGo.with['cache-dependency-path'].trimEnd(), '${{ inputs.root }}/go.work.sum\n${{ inputs.root }}/**/go.sum');
  assert.match(read('go.work'), /^go 1\.25\.0$/m);
});

test('setup-rust installs the repository toolchain with format and lint components', { timeout: 1000 }, () => {
  const steps = compositeSteps('rust');
  const rust = steps.find((step) => step.uses?.startsWith('dtolnay/rust-toolchain@'));
  assert.ok(rust, 'setup-rust does not install Rust');
  assert.match(rust.uses, /@[0-9a-f]{40}$/i, 'setup-rust must use an immutable action revision');
  assert.equal(rust.with.toolchain, '1.98.0');
  assert.deepEqual(rust.with.components.split(',').map((component) => component.trim()).sort(), ['clippy', 'rustfmt']);
  assert.doesNotMatch(JSON.stringify(steps), /cargo fetch/, 'setup-rust must not fetch Rust dependencies');
  const cache = steps.find((step) => step.uses?.startsWith('Swatinem/rust-cache@'));
  assert.ok(cache, 'setup-rust does not restore the Rust dependency cache');
  assert.match(cache.uses, /@[0-9a-f]{40}$/i, 'rust-cache must use an immutable action revision');
  assert.equal(cache.with.workspaces, '${{ inputs.root }} -> target');
  assert.equal(cache.with['cache-directories'], undefined, 'setup-rust must leave the cache workspace bound to the declared Cargo workspace');
});

test('setup-native validates the runner toolchain without installing packages', { timeout: 1000 }, () => {
  const steps = compositeSteps('native');
  assert.ok(steps.some((step) => step.run?.includes('xcode-select') && step.run.includes('clang')),
    'setup-native does not validate the macOS SDK and compiler');
  assert.ok(steps.some((step) => step.run?.includes('pkg-config') && step.run.includes('cmake')),
    'setup-native does not validate the native build tools');
  assert.doesNotMatch(JSON.stringify(steps), /brew install|apt(-get)? install|curl .*install|actions\/setup-[^@]+@v/i,
    'setup-native must use tools provided by the pinned runner');
});
