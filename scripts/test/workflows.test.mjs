// Checks the workflows of .github/workflows against docs/operations/examples.md#continuous-integration: every runner label is
// a hosted label of the repository.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const WORKFLOWS = join(ROOT, '.github', 'workflows');
const HOSTED = ['macos-15', 'ubuntu-26.04-arm'];

const read = (path) => readFileSync(join(ROOT, path), 'utf8');

/** The labels that a workflow names after `runs-on:`, as a flow list `[a, b]` or one word. */
function runnerLabels(text) {
  return [...text.matchAll(/^\s*runs-on:\s*(.+)$/gm)].map((match) => match[1].trim().replace(/^\[|\]$/g, '').split(',').map((label) => label.trim()));
}

/** The steps of the job of a workflow as `{name, text}`; a step starts with `      - ` at the indentation of a job step. */
function steps(text) {
  return text.split(/^ {6}- /m).slice(1).map((step) => ({ name: /^name:\s*(.+)$/m.exec(step)?.[1] ?? step.split('\n')[0], text: step }));
}

test('every runner label of a workflow is a hosted label', () => {
  const allowed = new Set(HOSTED);
  const files = readdirSync(WORKFLOWS).filter((name) => name.endsWith('.yml'));
  assert.ok(files.length > 0, 'no workflow file');
  for (const file of files) {
    for (const labels of runnerLabels(readFileSync(join(WORKFLOWS, file), 'utf8'))) {
      for (const label of labels) assert.ok(allowed.has(label), `${file}: the runner label ${label} is not a hosted label`);
    }
  }
});

test('CI and release workflows pin each external action to an immutable revision', { timeout: 1000 }, () => {
  for (const file of ['.github/workflows/ci.yml', '.github/workflows/release.yml']) {
    const text = read(file);
    const uses = [...text.matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)/gm)].map((match) => match[1]);
    assert.ok(uses.length > 0, `${file} has no action or reusable workflow references`);
    for (const reference of uses) {
      if (reference.startsWith('./')) continue;
      assert.match(reference, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/i,
        `${file} uses an unpinned external action: ${reference}`);
    }
  }
});

test('release builds audited candidate packages and publication consumes their immutable identities', () => {
  const text = read('.github/workflows/release.yml');
  assert.match(text, /checks:\n\s+if: github.event_name == 'push'\n\s+uses: \.\/\.github\/workflows\/ci\.yml/, 'release checks reuse the independent CI jobs');
  const job = (name) => {
    const start = text.indexOf(`  ${name}:`);
    assert.notEqual(start, -1, `release.yml has no job ${name}`);
    const next = text.slice(start + 1).search(/\n(?=  [a-z][a-z0-9-]+:\s*$)/m);
    return next < 0 ? text.slice(start) : text.slice(start, start + 1 + next);
  };
  for (const [host, label] of [['wailsv3', 'Wails'], ['tauriv2', 'Tauri'], ['mygo', 'mygo']]) {
    const target = `check-release-${host}`;
    const hostJob = job(`release-${host}`);
    assert.match(hostJob, new RegExp(`run: make ${target}`));
    const list = steps(hostJob);
    const packaging = list.findIndex((step) => step.name === `Package ${label} release bundle`);
    assert.ok(packaging >= 0, `${host}: no package step`);
    assert.match(list[packaging].text, new RegExp(`ditto -c -k --keepParent target/release/${host}/soksak\\.app "dist/soksak-\\$version-darwin-arm64-${host}\\.zip"`));
    const nativeFetch = list.findIndex((step) => step.name === 'Fetch the pinned native release file');
    const build = list.findIndex((step) => step.name === `Build and audit ${label} release bundle offline`);
    assert.ok(nativeFetch >= 0 && build > nativeFetch, `${host}: native dependency fetch must precede its offline build`);
    assert.match(list[build].text, /OFFLINE: '1'/);
  }
  const publish = job('publish');
  assert.match(publish, /if: github.event_name == 'workflow_dispatch'/);
  assert.match(publish, /candidate-acceptance.mjs prepare/);
  assert.match(publish, /candidate-acceptance.mjs verify/);
  assert.match(publish, /artifact-ids: \$\{\{ steps.candidate.outputs.artifact_ids \}\}/);
});

test('the release workflow runs no stored data migration step and no release step script', () => {
  const text = read('.github/workflows/release.yml');
  assert.doesNotMatch(text, /Migrate stored data|release-step/, 'the release workflow names no migration step');
  assert.equal(existsSync(join(ROOT, 'scripts', 'release-step.sh')), false, 'the release step script is removed');
});

test('the push check runs only the commit message and checklist history checks, and ci runs them on the range of its event with the structure, format and clippy checks', () => {
  const ci = read('.github/workflows/ci.yml');
  const targets = (name) => {
    const step = steps(ci).find((item) => item.name === name);
    assert.ok(step, `ci.yml has no step ${name}`);
    return /run:\s*make -C core (.+)$/m.exec(step.text)[1].trim().split(/\s+/);
  };
  // The check of the event catalog and of the event sources is a structure check of CI: a source change that removes an emitter fails its run.
  assert.ok(targets('Structure checks').includes('check-events'), 'the structure step of ci.yml does not run check-events');
  for (const name of ['Go format checks', 'Rust format and clippy checks']) assert.ok(targets(name).length > 0, `ci.yml step ${name} runs no target`);
  // A published commit message and a published checklist change are kept, so the push checks both before they leave the checkout;
  // a later commit corrects any other failure, and the release gate releases only a green run of CI.
  const makefile = read('Makefile');
  const recipe = /^check-push:[^\n]*\n((?:\t[^\n]*\n)+)/m.exec(makefile);
  assert.ok(recipe, 'the Makefile has no check-push target');
  assert.deepEqual(recipe[1].trim().split('\n').map((line) => line.trim()), [
    '@$(MAKE) --no-print-directory check-commits RANGE="$(or $(RANGE),origin/main..HEAD)"',
    '@$(MAKE) --no-print-directory check-checklist-history RANGE="$(or $(RANGE),origin/main..HEAD)"',
  ], 'check-push runs a check other than the commit messages and the checklist history');
  // The range is one argument of the kit command, which splits it into its revision ranges.
  assert.match(makefile, /^check-checklist-history:\n\t@test -n "\$\(RANGE\)" \|\| [^\n]*\n\t@pnpm exec sok-check docs --range "\$\(RANGE\)"\n/m);
  const history = steps(ci).find((item) => item.name === 'Checklist history');
  const messages = steps(ci).find((item) => item.name === 'Commit messages');
  assert.ok(history, 'ci.yml has no step Checklist history');
  assert.equal(history.text.replace('check-checklist-history', 'check-commits').replace('Checklist history', 'Commit messages'), messages.text,
    'the checklist history step of ci.yml does not run on the range and the condition of the commit message step');
  assert.match(read('.githooks/pre-push'), /make -C "\$\(git rev-parse --show-toplevel\)" check-push/);
});

test('the Tauri host job builds its tests with line tables as debug information, set on the job so that the Rust cache key holds it', { timeout: 1000 }, () => {
  const ci = read('.github/workflows/ci.yml');
  const job = /^  macos-tauriv2:\n([\s\S]*?)(?=^  [a-z][a-z0-9-]+:\s*$)/m.exec(ci)?.[1] ?? '';
  // The job env precedes the steps; the cache action reads the CARGO variables of its environment for its key.
  assert.match(job, /^ {4}env:\n {6}CARGO_PROFILE_DEV_DEBUG: line-tables-only\n {4}steps:/m);
});

test('ci keeps language host checks independent and gates release on every required job', () => {
  const ci = read('.github/workflows/ci.yml');
  const jobsText = /^jobs:\n([\s\S]*)$/m.exec(ci)?.[1] ?? '';
  const jobNames = [...jobsText.matchAll(/^  ([a-z][a-z0-9-]+):\s*$/gm)].map((match) => match[1]);
  const required = ['core-node', 'macos-wailsv3', 'macos-tauriv2', 'macos-mygo', 'build-native', 'equivalence', 'linux-node', 'required'];
  for (const name of required) assert.ok(jobNames.includes(name), `ci.yml has no required job ${name}`);
  // The applications are verified on macOS only; Linux runs the headless owner tests, and the Sok CLI tests run in the macOS host jobs.
  assert.deepEqual(jobNames.filter((name) => !required.includes(name)), [], 'ci.yml has a job outside the declared scope');
  const job = (name) => {
    const start = jobsText.indexOf(`  ${name}:`);
    assert.notEqual(start, -1, `ci.yml has no job ${name}`);
    const next = jobsText.slice(start + 1).search(/\n(?=  [a-z][a-z0-9-]+:\s*$)/m);
    return next < 0 ? jobsText.slice(start) : jobsText.slice(start, start + 1 + next);
  };
  assert.match(job('macos-wailsv3'), /test-wailsv3/);
  assert.match(job('macos-tauriv2'), /test-tauriv2/);
  assert.match(steps(job('macos-mygo')).find((step) => step.name === 'mygo host tests')?.text ?? '', /make -C core test-mygo/);
  assert.match(job('core-node'), /node core\/scripts\/node-tests\.mjs --exclude scripts\/ --exclude native\//);
  assert.match(job('equivalence'), /node core\/scripts\/node-tests\.mjs --only scripts\//);
  assert.doesNotMatch(job('equivalence'), /needs:/, 'equivalence installs and builds its own inputs');
  assert.match(job('build-native'), /uses: \.\/core\/\.github\/actions\/setup-node[\s\S]*?root: core/,
    'native Darwin package tests need the Node and pnpm toolchains');
  assert.doesNotMatch(job('build-native'), /setup-go|setup-rust/,
    'native Darwin checks install unused language toolchains');
  const wailsSteps = steps(job('macos-wailsv3'));
  assert.match(wailsSteps.find((step) => step.name === 'Go format checks')?.text ?? '', /make -C core check-go-format/);
  const tauriSteps = steps(job('macos-tauriv2'));
  assert.match(tauriSteps.find((step) => step.name === 'Rust format and clippy checks')?.text ?? '', /make -C core check-rust-format check-rust-clippy/);
  // Each host suite runs once: the host jobs run it, and the audit of each host is separable, so equivalence runs no host suite.
  for (const name of jobNames) {
    const text = job(name);
    const suites = (text.match(/\btest-(?:hosts|wailsv3|tauriv2|mygo)\b/g) ?? []);
    const expected = { 'macos-wailsv3': ['test-wailsv3'], 'macos-tauriv2': ['test-tauriv2'], 'macos-mygo': ['test-mygo'] }[name] ?? [];
    assert.deepEqual(suites, expected, `${name} runs the host suites ${JSON.stringify(suites)}`);
  }
  assert.match(steps(job('macos-tauriv2')).find((step) => step.name === 'Tauri host tests')?.text ?? '', /CARGO_INCREMENTAL: '0'/,
    'the Tauri host tests keep incremental build state that the job does not reuse');
  assert.doesNotMatch(job('equivalence'), /Fetch workspace sidecar dependencies|sidecars\/files mod download|sidecars\/vt\/Cargo\.toml/,
    'equivalence fetches sidecar build dependencies that host contract tests do not use');
  const gate = job('required');
  for (const [name, variable] of [
    ['core-node', 'CORE_NODE'], ['macos-wailsv3', 'WAILS'], ['macos-tauriv2', 'TAURI'], ['macos-mygo', 'MYGO'],
    ['build-native', 'NATIVE'], ['equivalence', 'EQUIVALENCE'], ['linux-node', 'LINUX_NODE'],
  ]) {
    assert.match(gate, new RegExp(`${variable}: \\$\\{\\{ needs\\.${name}\\.result \\}\\}`), `required gate does not read ${name}`);
  }
  assert.match(gate, /test "\$result" = success \|\| exit 1/);
  const gateLoop = /for result in ([^;]+); do/.exec(gate);
  assert.ok(gateLoop, 'required gate does not loop over its job results');
  assert.deepEqual(gateLoop[1].match(/"\$([A-Z_]+)"/g),
    ['"$CORE_NODE"', '"$WAILS"', '"$TAURI"', '"$MYGO"', '"$NATIVE"', '"$EQUIVALENCE"', '"$LINUX_NODE"']);
  for (const [host, jobName, testName] of [
    ['wailsv3', 'macos-wailsv3', 'Wails host tests'], ['tauriv2', 'macos-tauriv2', 'Tauri host tests'], ['mygo', 'macos-mygo', 'mygo host tests'],
  ]) {
    const list = steps(job(jobName));
    const fetch = list.findIndex((step) => step.name === 'Fetch pinned native release file');
    const check = list.findIndex((step) => step.name === testName);
    assert.ok(fetch >= 0 && check > fetch, `${host}: native release file fetch must precede offline host tests`);
    assert.match(list[check].text, /OFFLINE: '1'/);
  }
  const native = steps(job('build-native'));
  const nativeFetch = native.findIndex((step) => step.name === 'Fetch pinned native release file');
  const nativeBuild = native.findIndex((step) => step.name === 'Build the native library offline');
  const nativeTest = native.findIndex((step) => step.name === 'Native Darwin tests');
  const processIdentityTest = native.findIndex((step) => step.name === 'Native process identity package tests');
  assert.ok(nativeFetch >= 0 && nativeBuild > nativeFetch && nativeTest > nativeBuild && processIdentityTest > nativeBuild,
    'native dependency fetch, build, and tests are not ordered');
  assert.match(native[processIdentityTest].text, /pnpm -C core\/native\/darwin\/process-identity test/);
  assert.match(native[nativeBuild].text, /OFFLINE: '1'/);
  assert.match(native[nativeTest].text, /OFFLINE: '1'/);
  const equivalence = steps(job('equivalence'));
  const eqFetch = equivalence.findIndex((step) => step.name === 'Fetch pinned native release file');
  const eqChecks = equivalence.findIndex((step) => step.name === 'Structure checks');
  assert.ok(eqFetch >= 0 && eqChecks > eqFetch, 'equivalence does not fetch native dependency before offline structure checks');
  assert.match(equivalence[eqChecks].text, /OFFLINE: '1'/);
  // A hosted runner serves one job, so its Rust builds use every processor; a one-job limit builds each crate on one processor.
  assert.doesNotMatch(job('equivalence'), /CARGO_BUILD_JOBS/, 'equivalence limits its Rust builds to fewer jobs than the runner has processors');
});

/** The text of a job of ci.yml, from its name line to the next job. */
function ciJob(name) {
  const text = read('.github/workflows/ci.yml');
  const start = text.indexOf(`\n  ${name}:\n`);
  assert.notEqual(start, -1, `ci.yml has no job ${name}`);
  const next = text.slice(start + 1).search(/\n(?=  [a-z][a-z0-9-]+:\s*$)/m);
  return next < 0 ? text.slice(start + 1) : text.slice(start + 1, start + 1 + next);
}

test('the linux-node job runs the headless owner tests on Linux after the locked install and the required gate waits for it', { timeout: 1000 }, () => {
  const job = ciJob('linux-node');
  assert.match(job, /^ {4}runs-on: ubuntu-26\.04-arm$/m, 'linux-node does not run on the hosted Linux runner');
  const list = steps(job);
  const install = list.findIndex((step) => /run: node core\/scripts\/install-platform\.mjs linux$/m.test(step.text));
  const owners = list.findIndex((step) => step.name === 'Headless owner tests');
  assert.ok(install >= 0 && owners > install, 'linux-node does not install the locked dependencies before the headless owner tests');
  assert.match(list[owners].text, /run: make -C core test-headless-owners$/m);
  assert.match(list[owners].text, /npm_config_offline: 'true'/);
  const tools = list.findIndex((step) => step.name === 'Install the system tools of the owners');
  assert.ok(tools >= 0 && tools < install, 'linux-node does not install the system tools of the owners before the locked install');
  assert.match(list[tools].text, /sudo apt-get install --yes zsh clang pkg-config unzip build-essential python3$/m);
  assert.ok(list.some((step) => step.name === 'Reject lockfile changes'), 'linux-node does not reject lockfile changes');
  const gate = ciJob('required');
  assert.match(gate, /^ {6}- linux-node$/m, 'the required gate does not need linux-node');
  assert.match(gate, /LINUX_NODE: \$\{\{ needs\.linux-node\.result \}\}/);
});

test('make test-headless-owners runs the Node tests of scripts/test, e2e/test and packages/window-check/test outside platform/darwin/system', { timeout: 1000 }, () => {
  const recipe = /^test-headless-owners:[^\n]*\n((?:\t[^\n]*\n)+)/m.exec(read('Makefile'));
  assert.ok(recipe, 'the Makefile has no test-headless-owners target');
  assert.deepEqual(recipe[1].trim().split('\n').map((line) => line.trim()),
    ['@node scripts/node-tests.mjs --only scripts/test/ --only e2e/test/ --only packages/window-check/test/ --exclude-folder platform/darwin/system'],
    'test-headless-owners runs another selection or excludes another folder of the owners');
});

test('every system owner under platform/darwin/system runs in a macOS job of CI and in no Linux job', { timeout: 10_000 }, async () => {
  const { discoverNodeTests, selectNodeTests } = await import('../node-tests.mjs');
  const packages = JSON.parse(execFileSync('pnpm', ['-r', 'list', '--json', '--depth', '-1'], { cwd: ROOT, encoding: 'utf8' }))
    .map((item) => relative(ROOT, item.path) || '.')
    .sort((a, b) => (a === '.' ? -1 : b === '.' ? 1 : a.localeCompare(b)));
  const { tests } = discoverNodeTests({ root: ROOT, packages });
  const system = tests.filter(({ name }) => name.includes('/platform/darwin/system/')).map(({ name }) => name).sort();
  assert.ok(system.length > 0, 'no discovered test file is a system owner under platform/darwin/system');
  // The scopes of the macOS jobs core-node and equivalence, and the selection of linux-node, as ci.yml and the Makefile state them.
  assert.match(ciJob('core-node'), /node core\/scripts\/node-tests\.mjs --exclude scripts\/ --exclude native\//);
  assert.match(ciJob('equivalence'), /node core\/scripts\/node-tests\.mjs --only scripts\//);
  assert.match(ciJob('linux-node'), /make -C core test-headless-owners/);
  const macos = [...selectNodeTests(tests, { exclude: ['scripts/', 'native/'] }), ...selectNodeTests(tests, { only: 'scripts/' })]
    .map(({ name }) => name);
  assert.deepEqual(system.filter((name) => !macos.includes(name)), [], 'a system owner runs in no macOS job');
  const linux = selectNodeTests(tests, { only: ['scripts/test/', 'e2e/test/', 'packages/window-check/test/'],
    excludeFolder: ['platform/darwin/system'] }).map(({ name }) => name);
  assert.deepEqual(system.filter((name) => linux.includes(name)), [], 'a system owner runs in the Linux job');
});

test('make check-windows-rust checks the Rust host library for x86_64-pc-windows-msvc with and without diagnostics without installing the target', { timeout: 10_000 }, () => {
  const output = execFileSync('make', ['-n', 'check-windows-rust'], { cwd: ROOT, encoding: 'utf8' });
  // A local make does not change the toolchain: the target requires the installed Windows target, and CI adds it.
  assert.doesNotMatch(output, /^\S*rustup target add/m, output);
  assert.match(output, /rustup target list --installed \| grep -qx 'x86_64-pc-windows-msvc' \|\| \{ echo "the Rust target x86_64-pc-windows-msvc is not installed; run rustup target add x86_64-pc-windows-msvc" >&2; exit 1; \}/, output);
  const checks = output.split('\n').filter((line) => / check --locked -p soksak-host --target x86_64-pc-windows-msvc/.test(line))
    .map((line) => line.replace(/^.* check --locked/, 'check --locked'));
  assert.deepEqual(checks, [
    'check --locked -p soksak-host --target x86_64-pc-windows-msvc',
    'check --locked -p soksak-host --target x86_64-pc-windows-msvc --features diagnostics',
  ], output);
  // The build script of ring compiles C for the MSVC target even for cargo check, which needs the MSVC tools of a Windows host,
  // so no macOS or Linux job of CI runs this target.
  assert.doesNotMatch(read('.github/workflows/ci.yml'), /check-windows-rust|x86_64-pc-windows-msvc/);
});

test('make test-mygo runs the unit tests of the Go packages of the mygo host', { timeout: 1000 }, () => {
  const recipe = /^test-mygo:[^\n]*\n((?:\t[^\n]*\n)+)/m.exec(read('Makefile'));
  assert.ok(recipe, 'the Makefile has no test-mygo target');
  // Each package of the mygo host that holds unit tests is a pattern of the Go test runner, which fails when a pattern has no test.
  const patterns = [...recipe[1].matchAll(/node scripts\/go-tests\.mjs --package '([^']+)'/g)].map((match) => match[1]);
  for (const folder of ['packages/workbench-mygo']) {
    assert.ok(patterns.includes(`./${folder}/...`), `test-mygo runs no test of ${folder}: ${JSON.stringify(patterns)}`);
  }
});

test('make test-mygo runs the contract run of the mygo host and the unit tests of the mygo application', { timeout: 10_000 }, () => {
  const output = execFileSync('make', ['-n', '-o', 'build-native', '-o', 'build', 'test-mygo'], { cwd: ROOT, encoding: 'utf8' });
  assert.match(output, /pnpm -F @soksak\/mygo test/, output);
  assert.match(output, /test-hosts\.mjs --host mygo/, output);
});

test('CI JavaScript scopes cover every discovered test file exactly once', { timeout: 10_000 }, async () => {
  const { discoverNodeTests, selectNodeTests } = await import('../node-tests.mjs');
  const packages = JSON.parse(execFileSync('pnpm', ['-r', 'list', '--json', '--depth', '-1'], { cwd: ROOT, encoding: 'utf8' }))
    .map((item) => relative(ROOT, item.path) || '.')
    .sort((a, b) => (a === '.' ? -1 : b === '.' ? 1 : a.localeCompare(b)));
  const { tests } = discoverNodeTests({ root: ROOT, packages });
  const core = selectNodeTests(tests, { exclude: ['scripts/', 'native/'] });
  const scripts = selectNodeTests(tests, { only: 'scripts/' });
  const native = selectNodeTests(tests, { only: 'native/darwin/process-identity/' });
  assert.deepEqual(native.map(({ name }) => name), ['native/darwin/process-identity/tests/package.test.mjs']);
  const assigned = [...core, ...scripts, ...native].map(({ name }) => name);
  assert.deepEqual([...assigned].sort(), tests.map(({ name }) => name).sort(), 'the three CI scopes do not cover the complete discovered inventory');
  assert.equal(new Set(assigned).size, tests.length, 'a Node test file is assigned to both CI scopes');
});

test('the build-native job records the display session before the native tests', () => {
  const text = read('.github/workflows/ci.yml');
  const job = text.split(/^ {2}(?=[a-z-]+:$)/m).find((part) => part.startsWith('build-native:'));
  assert.ok(job, 'ci.yml has no build-native job');
  const list = steps(job);
  const record = list.findIndex((step) => step.name === 'Record the display session');
  const tests = list.findIndex((step) => step.name === 'Native Darwin tests');
  assert.ok(record >= 0, `the build-native job has no step that records the display session: ${list.map((step) => step.name).join(', ')}`);
  assert.ok(record < tests, 'the display session is recorded before the native tests');
  for (const command of ['system_profiler SPDisplaysDataType', 'pmset -g', 'ioreg -n Root -d1 -k IOConsoleUsers']) {
    assert.ok(list[record].text.includes(command), `the session record runs ${command}`);
  }
});

// The root scripts import the packages that the root package.json declares (scripts/test-runner.mjs imports
// @soksak/window-check), and every make target of core runs through them, so a job installs the locked workspace
// dependencies before its first core command.
test('every CI job installs the locked workspace dependencies before its first core command', { timeout: 1000 }, () => {
  const jobs = read('.github/workflows/ci.yml').split(/^ {2}(?=[a-z-]+:$)/m).filter((part) => /^[a-z-]+:\n/.test(part));
  assert.ok(jobs.length > 0, 'ci.yml has no job');
  // A job of another operating system installs through scripts/install-platform.mjs, which leaves out the projects whose os
  // field excludes that system and runs the same locked install.
  const install = /run: (?:pnpm -C core install --frozen-lockfile|node core\/scripts\/install-platform\.mjs [a-z0-9]+)$/m;
  const core = /run: (?:make -C core|node core\/|pnpm -C core(?! install))/m;
  for (const job of jobs) {
    const name = job.split(':')[0];
    const list = steps(job);
    const first = list.findIndex((step) => core.test(step.text));
    if (first < 0) continue;
    const installed = list.findIndex((step) => install.test(step.text));
    // The install through scripts/install-platform.mjs is itself the first core command of its job.
    assert.ok(installed >= 0 && installed <= first,
      `${name}: the step ${list[first].name} runs a core command before the locked workspace dependencies are installed`);
  }
});

test('the hosted native job runs the native unit tests', () => {
  const job = read('.github/workflows/ci.yml').split(/^ {2}(?=[a-z-]+:$)/m).find((part) => part.startsWith('build-native:'));
  assert.ok(job, 'ci.yml has no build-native job');
  const hosted = steps(job).find((step) => step.name === 'Native Darwin tests');
  assert.ok(hosted, 'the build-native job has no step named Native Darwin tests');
  assert.match(hosted.text, /run: make -C core\/native\/darwin test$/m);
});

test('candidate bundles build beside checks and publication requires their recorded acceptance', () => {
  const release = read('.github/workflows/release.yml');
  // The gate and the bundle builds do not wait for the checks; publication requires the recorded acceptance of every build.
  assert.match(release, /^ {2}gate:\n {4}if: github.event_name == 'push'\n {4}runs-on: /m, 'gate runs only for candidate pushes');
  for (const job of ['release-wailsv3', 'release-tauriv2', 'release-mygo']) {
    assert.match(release, new RegExp(`^ {2}${job}:\\n {4}needs: gate\\n`, 'm'), `${job} waits for a job other than gate`);
  }
  const publish = release.slice(release.indexOf('  publish:'));
  assert.match(publish, /if: github.event_name == 'workflow_dispatch'/);
  assert.match(publish, /candidate-acceptance\.mjs prepare/);
  assert.match(publish, /candidate-acceptance\.mjs verify/);
  assert.doesNotMatch(publish, /make .*build|check-release-(wailsv3|tauriv2|mygo)/, 'publication must reuse the accepted files');
});

test('a push creates candidate files and authenticated dispatch publishes only their accepted bytes', () => {
  const release = read('.github/workflows/release.yml');
  assert.match(release, /^on:\n {2}push:\n {4}branches: \[main\]\n/m, 'release.yml starts on a push to main');
  assert.match(release, /workflow_dispatch:\n {4}inputs:\n {6}acceptance:/);
  assert.doesNotMatch(release, /tags: \['v\*'\]/, 'release.yml does not start on a tag push');
  assert.match(release, /^concurrency:\n {2}group: release\n {2}cancel-in-progress: false$/m);
  assert.match(release, /run: pnpm exec sok-check release packages\/plugin-api\/package\.json docs\/features\.md/);
  for (const job of ['release-wailsv3', 'release-tauriv2', 'release-mygo']) {
    assert.match(release, new RegExp(`  ${job}:\\n {4}needs: gate\\n {4}if: needs\\.gate\\.outputs\\.release == 'true'\\n`), `${job} runs only on a release`);
  }
  assert.match(release, /git ls-remote origin refs\/heads\/main/, 'publication requires the commit to be the head of main');
  assert.match(release, /tags="\$\(git ls-remote --tags origin "refs\/tags\/v\$VERSION"\)"/, 'a failed tag query must not be read as an absent tag');
  // The registry lists a core release in its core.json; the release of core has no condition on the registry state.
  assert.doesNotMatch(release, /registry/i, 'release.yml reads no registry');
  assert.doesNotMatch(read('Makefile').match(/^check-release:.*$/m)[0], /registry/, 'check-release reads no registry');
  assert.match(release, /tag_name: v\$\{\{ steps\.candidate\.outputs\.version \}\}/);
  assert.match(release, /target_commitish: \$\{\{ steps\.candidate\.outputs\.sha \}\}/);
  assert.match(release, /artifact-ids: \$\{\{ steps\.candidate\.outputs\.artifact_ids \}\}/);
  assert.match(release, /run-id: \$\{\{ steps\.candidate\.outputs\.run_id \}\}/);
  assert.match(release, /ACCEPTANCE_REPORT: \$\{\{ inputs\.acceptance \}\}/);
  assert.doesNotMatch(release, /run:.*\$\{\{ inputs\.acceptance \}\}/);
  const ci = read('.github/workflows/ci.yml');
  assert.match(ci, /^on:\n {2}workflow_call:\n {2}pull_request:\n/m, 'ci.yml runs for a pull request and for release.yml only');
});


// A repository consumes a lower layer only as its published release, and core consumes no plugin or sidecar, so a workflow
// of core checks out only core (AGENTS.md, Verification).
test('no workflow checks out another repository of the workspace', { timeout: 1000 }, () => {
  for (const file of readdirSync(WORKFLOWS).filter((name) => name.endsWith('.yml'))) {
    const others = [...readFileSync(join(WORKFLOWS, file), 'utf8').matchAll(/^\s+repository:\s*(\S+)$/gm)].map((match) => match[1]);
    assert.deepEqual(others, [], `${file} checks out ${others.join(', ')}`);
  }
});

test('the release publishes the packed releases that plugins and sidecars build with and sok only inside the bundles', { timeout: 1000 }, () => {
  const text = read('.github/workflows/release.yml');
  const start = text.indexOf('  release-wailsv3:');
  const job = text.slice(start, text.indexOf('\n  release-tauriv2:'));
  const list = steps(job);
  const pack = list.find((step) => step.name === 'Package the releases that plugins and sidecars build with');
  assert.ok(pack, 'release-wailsv3 has no step that packages the packed releases');
  // Each application zip holds the sok of its host, so the release publishes no second copy of sok.
  assert.doesNotMatch(text, /dist\/sok-/, 'the release publishes sok outside the application bundles');
  assert.match(pack.text, /make -C native\/darwin\/process-identity\n/);
  // The script packs every release package and names their workspace dependencies by their release files.
  assert.match(pack.text, /make -C native\/darwin\/process-identity\n\s+node scripts\/pack-release-packages\.mjs dist\n/,
    'the release packages are not packed into dist after the process identity library is built');
  assert.doesNotMatch(pack.text, /pnpm -C \S+ pack/, 'a release package is packed without the release addresses of its workspace dependencies');
  const upload = list.find((step) => /upload-artifact/.test(step.text));
  assert.match(upload.text, /path: core\/dist\/\*\n/, 'the upload of release-wailsv3 does not hold every file of dist');
  assert.ok(list.indexOf(pack) < list.indexOf(upload), 'the packed releases are made after the upload');
});

test('repeat.yml starts on a dispatch and runs only the tracked repeat targets', () => {
  const file = '.github/workflows/repeat.yml';
  assert.ok(existsSync(join(ROOT, file)), `${file} does not exist`);
  const text = read(file);
  assert.match(text, /^on:\n {2}workflow_dispatch:\n/m, 'repeat.yml starts only on a dispatch');
  const commands = steps(text).flatMap((step) => [...step.text.matchAll(/^\s*run:\s*(.+)$/gm)].map((match) => match[1]));
  const repeats = commands.filter((command) => /\brepeat\b/.test(command));
  assert.deepEqual(repeats, [
    'make -C core/native/darwin repeat TEST="$TEST" COUNT="$COUNT"',
    'make -C core repeat-rust PACKAGE="$PACKAGE" TEST_TARGET="$TEST_TARGET" TEST="$TEST" COUNT="$COUNT"',
  ], `repeat.yml runs ${repeats.join(' | ')}`);
  // The dispatched values reach the commands through the environment, so no value is spliced into a shell line.
  assert.doesNotMatch(commands.join('\n'), /\$\{\{\s*inputs\./, 'a run line splices a dispatched input');
});

test('the kit release that core pins defines the kit term', () => {
  const { terms } = JSON.parse(readFileSync(fileURLToPath(import.meta.resolve('@soksak/kit/terms.json')), 'utf8'));
  const kit = terms.find((entry) => entry.term === 'kit');
  assert.ok(kit, 'the term list of the pinned kit has no entry for kit');
  assert.doesNotMatch(kit.definition, /static library|link/, 'the kit term names a library that core owns');
});

test('the kit release that core pins defines the presentation mode terms', () => {
  const { terms } = JSON.parse(readFileSync(fileURLToPath(import.meta.resolve('@soksak/kit/terms.json')), 'utf8'));
  for (const term of ['presentation mode', 'lease']) {
    assert.ok(terms.some((entry) => entry.term === term), `the term list of the pinned kit has no entry for ${term}`);
  }
});

test('the hooks, the record targets and the release gate run the commands of the kit release', () => {
  assert.match(read('.githooks/commit-msg'), /exec pnpm --dir "\$\(git rev-parse --show-toplevel\)" exec sok-check commits "\$1"/);
  assert.match(read('.githooks/pre-commit'), /exec pnpm --dir "\$root" exec sok-check docs "\$root"/);
  const makefile = read('Makefile');
  assert.doesNotMatch(makefile, /packages\/plugin-api\/(?:records|commits)-check\.js/, 'the Makefile runs a record check of the plugin API');
  assert.match(makefile, /^\t@pnpm exec sok-check docs$/m);
  assert.match(makefile, /^\t@pnpm exec sok-check commits \$\(RANGE\)$/m);
  assert.match(read('scripts/checklist.mjs'), /^import \{ checklist \} from "@soksak\/kit\/checklist";$/m);
});

test('check-events and the event scripts run the event source check of the kit release', () => {
  const { devDependencies } = JSON.parse(read('package.json'));
  assert.match(read('Makefile'), /^\t@pnpm exec sok-check events --config scripts\/event-sources\.json$/m);
  for (const file of ['scripts/check-events.mjs', 'scripts/check-fallbacks.mjs']) {
    assert.match(read(file), /from ["']@soksak\/kit\/events["'];$/m, file);
  }
});

test('the structure step of CI checks the names of the commands', () => {
  assert.match(read('.github/workflows/ci.yml'), /make -C core [^\n]*\bcheck-commands\b/);
  assert.match(read('Makefile'), /^check-commands:\n\t@pnpm exec sok-check commands$/m);
});

test('the core Node gate runs changed-owner required mutations and retains their evidence', { timeout: 1000 }, () => {
  const ci = read('.github/workflows/ci.yml');
  const core = /  core-node:\n([\s\S]*?)(?=\n  [a-z][a-z0-9-]+:\s*$)/m.exec(ci)?.[1] ?? '';
  assert.match(core, /fetch-depth: 0/, 'changed-owner selection needs both revisions');
  const list = steps(core);
  const baseline = list.findIndex(({ name }) => name === 'Core package tests');
  const mutation = list.findIndex(({ name }) => name === 'Required mutations for changed owners');
  assert.ok(mutation > baseline, 'required mutations must follow the owning package build and tests');
  assert.match(list[mutation].text, /check-breaks\.mjs --changed/);
  assert.match(list[mutation].text, /github\.event\.pull_request\.base\.sha/);
  assert.match(list[mutation].text, /github\.event\.before/);
  assert.doesNotMatch(list[mutation].text, /continue-on-error|\|\| true|mutate\.mjs/);
  const evidence = list.find(({ name }) => name === 'Keep required mutation evidence');
  assert.ok(evidence, 'required mutation logs are not retained');
  assert.match(evidence.text, /if: always\(\)/);
  assert.match(evidence.text, /soksak-break-evidence-\*/);
});
