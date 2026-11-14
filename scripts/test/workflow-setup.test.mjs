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
  assert.match(read('.node-version').trim(), /^\d+\.\d+\.\d+$/);
  assert.match(read('package.json'), /"packageManager":\s*"pnpm@\d+\.\d+\.\d+"/);
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
});

// The value of each `directive` line of a go.work or go.mod file, in file order. Comments are not part of a value.
function directives(text, directive) {
  const pattern = new RegExp(`^${directive}[ \\t]+([^\\s/]+)[ \\t]*(?://.*)?$`, 'gm');
  return [...text.matchAll(pattern)].map((match) => match[1]);
}

// The module directories of the `use` directives of go.work, in the single-line and the block form.
function workspaceModules(text) {
  const modules = [];
  for (const match of text.matchAll(/^use[ \t]+(?:\(([^)]*)\)|(\S+))/gm)) {
    const entries = match[1] === undefined ? [match[2]] : match[1].split('\n');
    for (const entry of entries) {
      const path = entry.replace(/\/\/.*$/, '').trim();
      if (path) modules.push(path);
    }
  }
  return modules;
}

test('go.work and every module that it uses declare Go 1.27.3', { timeout: 1000 }, () => {
  const files = ['go.work', ...workspaceModules(read('go.work')).map((module) => join(module, 'go.mod'))];
  assert.ok(files.length > 1, 'go.work uses no module');
  for (const file of files) {
    const text = read(file);
    assert.deepEqual(directives(text, 'go'), ['1.27.3'], `${file} must declare go 1.27.3`);
    for (const toolchain of directives(text, 'toolchain')) {
      assert.equal(toolchain, 'go1.27.3', `${file} names a toolchain other than go1.27.3`);
    }
  }
});

test('setup-rust installs the repository toolchain with format and lint components', { timeout: 1000 }, () => {
  const steps = compositeSteps('rust');
  const rust = steps.find((step) => step.uses?.startsWith('dtolnay/rust-toolchain@'));
  assert.ok(rust, 'setup-rust does not install Rust');
  assert.match(rust.uses, /@[0-9a-f]{40}$/i, 'setup-rust must use an immutable action revision');
  const declared = read('rust-toolchain.toml');
  const channel = declared.match(/^channel\s*=\s*"([^"]+)"$/m)?.[1];
  assert.equal(channel, '1.98.0', 'rust-toolchain.toml declares no exact Rust version');
  assert.equal(rust.with.toolchain, channel, 'setup-rust installs another toolchain than rust-toolchain.toml declares');
  const components = JSON.parse(declared.match(/^components\s*=\s*(\[.*\])$/m)?.[1] ?? 'null');
  assert.deepEqual(components?.sort(), ['clippy', 'rustfmt'], 'rust-toolchain.toml declares other components than clippy and rustfmt');
  assert.deepEqual(rust.with.components.split(',').map((component) => component.trim()).sort(), components);
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

test('every CI job that runs the core package tests installs Rust before them', { timeout: 1000 }, () => {
  // The e2e setup tests run cargo metadata. A job without the toolchain lets the rustup proxy install it inside two tests at once,
  // and the two installations fail on the same folders.
  const jobs = Object.entries(YAML.parse(read('.github/workflows/ci.yml')).jobs);
  const running = jobs.filter(([, job]) => (job.steps ?? []).some((step) => /scripts\/node-tests\.mjs/.test(step.run ?? '')));
  assert.ok(running.length > 0, 'no CI job runs scripts/node-tests.mjs');
  for (const [name, job] of running) {
    const tests = job.steps.findIndex((step) => /scripts\/node-tests\.mjs/.test(step.run ?? ''));
    const rust = job.steps.findIndex((step) => step.uses === './core/.github/actions/setup-rust');
    assert.ok(rust >= 0 && rust < tests, `the CI job ${name} runs the core package tests without installing Rust first`);
  }
});
