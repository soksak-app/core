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

test('release builds and packages each host after the reusable CI checks succeed', () => {
  const text = read('.github/workflows/release.yml');
  assert.match(text, /checks:\n\s+uses: \.\/\.github\/workflows\/ci\.yml/, 'release checks reuse the independent CI jobs');
  const job = (name) => {
    const start = text.indexOf(`  ${name}:`);
    assert.notEqual(start, -1, `release.yml has no job ${name}`);
    const next = text.slice(start + 1).search(/\n(?=  [a-z][a-z0-9-]+:\s*$)/m);
    return next < 0 ? text.slice(start) : text.slice(start, start + 1 + next);
  };
  for (const [host, target, binary] of [
    ['wailsv3', 'release-check-wailsv3', 'wailsv3/soksak.app/Contents/MacOS/soksak-wailsv3'],
    ['tauriv2', 'release-check-tauriv2', 'tauriv2/soksak.app/Contents/MacOS/soksak-tauriv2'],
  ]) {
    const hostJob = job(`release-${host}`);
    assert.match(hostJob, new RegExp(`run: make ${target}`));
    const list = steps(hostJob);
    const packaging = list.findIndex((step) => step.name === `Package ${host === 'wailsv3' ? 'Wails' : 'Tauri'} release bundle`);
    assert.ok(packaging >= 0, `${host}: no package step`);
    assert.match(list[packaging].text, /ditto -c -k --keepParent/);
    const nativeFetch = list.findIndex((step) => step.name === 'Fetch the pinned native release file');
    const build = list.findIndex((step) => step.name === `Build and audit ${host === 'wailsv3' ? 'Wails' : 'Tauri'} release bundle offline`);
    assert.ok(nativeFetch >= 0 && build > nativeFetch, `${host}: native dependency fetch must precede its offline build`);
    assert.match(list[build].text, /OFFLINE: '1'/);
  }
  const publish = job('publish');
  assert.match(publish, /needs: \[checks, gate, release-wailsv3, release-tauriv2\]/);
  assert.match(publish, /if: always\(\) && needs\.gate\.outputs\.release == 'true'/);
  for (const [name, env] of [['checks', 'CHECKS_RESULT'], ['gate', 'GATE_RESULT'], ['release-wailsv3', 'WAILS_RESULT'],
    ['release-tauriv2', 'TAURI_RESULT']]) {
    assert.match(publish, new RegExp(`${env}: \\$\\{\\{ needs\\.${name}\\.result \\}\\}`));
    assert.match(publish, new RegExp(`test \\"\\$${env}\\" = success`), `${name}: publication is not gated on success`);
  }
  assert.match(publish, /name: release-wailsv3/);
  assert.match(publish, /name: release-tauriv2/);
});

test('the release workflow runs no stored data migration step and no release step script', () => {
  const text = read('.github/workflows/release.yml');
  assert.doesNotMatch(text, /Migrate stored data|release-step/, 'the release workflow names no migration step');
  assert.equal(existsSync(join(ROOT, 'scripts', 'release-step.sh')), false, 'the release step script is removed');
});

test('the push check runs only the commit message check, and ci runs the structure, format and clippy checks', () => {
  const ci = read('.github/workflows/ci.yml');
  const targets = (name) => {
    const step = steps(ci).find((item) => item.name === name);
    assert.ok(step, `ci.yml has no step ${name}`);
    return /run:\s*make -C core (.+)$/m.exec(step.text)[1].trim().split(/\s+/);
  };
  // The event catalog and census audits are structure checks of CI: a source change that removes an emitter fails its run.
  assert.deepEqual(['events-check', 'census-check'].filter((target) => !targets('Structure checks').includes(target)), [],
    'the structure step of ci.yml does not run the event catalog and census audits');
  for (const name of ['Go format checks', 'Rust format and clippy checks']) assert.ok(targets(name).length > 0, `ci.yml step ${name} runs no target`);
  // A published commit message is kept, so the push checks it before it leaves the checkout; a later commit corrects any other
  // failure, and the release gate releases only a green run of CI.
  const recipe = /^push-check:[^\n]*\n((?:\t[^\n]*\n)+)/m.exec(read('Makefile'));
  assert.ok(recipe, 'the Makefile has no push-check target');
  assert.deepEqual(recipe[1].trim().split('\n').map((line) => line.trim()),
    ['@$(MAKE) --no-print-directory commits-check RANGE="$(or $(RANGE),origin/main..HEAD)"'], 'push-check runs a check other than the commit messages');
  assert.match(read('.githooks/pre-push'), /make -C "\$\(git rev-parse --show-toplevel\)" push-check/);
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
  const required = ['core-node', 'macos-wailsv3', 'macos-tauriv2', 'native-darwin', 'equivalence', 'required'];
  for (const name of required) assert.ok(jobNames.includes(name), `ci.yml has no required job ${name}`);
  // Linux and Windows are not verified platforms, so CI runs no product check on them; the Sok CLI tests run in the macOS host jobs.
  assert.deepEqual(jobNames.filter((name) => !required.includes(name)), [], 'ci.yml has a job outside the verified macOS scope');
  const job = (name) => {
    const start = jobsText.indexOf(`  ${name}:`);
    assert.notEqual(start, -1, `ci.yml has no job ${name}`);
    const next = jobsText.slice(start + 1).search(/\n(?=  [a-z][a-z0-9-]+:\s*$)/m);
    return next < 0 ? jobsText.slice(start) : jobsText.slice(start, start + 1 + next);
  };
  assert.match(job('macos-wailsv3'), /host-test-wailsv3/);
  assert.match(job('macos-tauriv2'), /host-test-tauriv2/);
  assert.match(job('core-node'), /node core\/scripts\/node-tests\.mjs --exclude scripts\/ --exclude native\//);
  assert.match(job('equivalence'), /node core\/scripts\/node-tests\.mjs --only scripts\//);
  assert.doesNotMatch(job('equivalence'), /needs:/, 'equivalence installs and builds its own inputs');
  assert.match(job('native-darwin'), /uses: \.\/core\/\.github\/actions\/setup-node[\s\S]*?root: core/,
    'native Darwin package tests need the Node and pnpm toolchains');
  assert.doesNotMatch(job('native-darwin'), /setup-go|setup-rust/,
    'native Darwin checks install unused language toolchains');
  const wailsSteps = steps(job('macos-wailsv3'));
  assert.match(wailsSteps.find((step) => step.name === 'Go format checks')?.text ?? '', /make -C core go-format-check/);
  const tauriSteps = steps(job('macos-tauriv2'));
  assert.match(tauriSteps.find((step) => step.name === 'Rust format and clippy checks')?.text ?? '', /make -C core rust-format-check rust-clippy-check/);
  // Each host suite runs once: the host jobs run it, and the audit of each host is separable, so equivalence runs no host suite.
  for (const name of jobNames) {
    const text = job(name);
    const suites = (text.match(/host-contract-check|host-test-wailsv3|host-test-tauriv2/g) ?? []);
    const expected = { 'macos-wailsv3': ['host-test-wailsv3'], 'macos-tauriv2': ['host-test-tauriv2'] }[name] ?? [];
    assert.deepEqual(suites, expected, `${name} runs the host suites ${JSON.stringify(suites)}`);
  }
  assert.match(steps(job('macos-tauriv2')).find((step) => step.name === 'Tauri host tests')?.text ?? '', /CARGO_INCREMENTAL: '0'/,
    'the Tauri host tests keep incremental build state that the job does not reuse');
  assert.doesNotMatch(job('equivalence'), /Fetch workspace sidecar dependencies|sidecars\/files mod download|sidecars\/vt\/Cargo\.toml/,
    'equivalence fetches sidecar build dependencies that host contract tests do not use');
  const gate = job('required');
  for (const [name, variable] of [
    ['core-node', 'CORE_NODE'], ['macos-wailsv3', 'WAILS'], ['macos-tauriv2', 'TAURI'],
    ['native-darwin', 'NATIVE'], ['equivalence', 'EQUIVALENCE'],
  ]) {
    assert.match(gate, new RegExp(`${variable}: \\$\\{\\{ needs\\.${name}\\.result \\}\\}`), `required gate does not read ${name}`);
  }
  assert.match(gate, /test "\$result" = success \|\| exit 1/);
  const gateLoop = /for result in ([^;]+); do/.exec(gate);
  assert.ok(gateLoop, 'required gate does not loop over its job results');
  assert.deepEqual(gateLoop[1].match(/"\$([A-Z_]+)"/g),
    ['"$CORE_NODE"', '"$WAILS"', '"$TAURI"', '"$NATIVE"', '"$EQUIVALENCE"']);
  for (const [host, jobName, testName] of [
    ['wailsv3', 'macos-wailsv3', 'Wails host tests'], ['tauriv2', 'macos-tauriv2', 'Tauri host tests'],
  ]) {
    const list = steps(job(jobName));
    const fetch = list.findIndex((step) => step.name === 'Fetch pinned native release file');
    const check = list.findIndex((step) => step.name === testName);
    assert.ok(fetch >= 0 && check > fetch, `${host}: native release file fetch must precede offline host tests`);
    assert.match(list[check].text, /OFFLINE: '1'/);
  }
  const native = steps(job('native-darwin'));
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

test('the native-darwin job records the display session before the native tests', () => {
  const text = read('.github/workflows/ci.yml');
  const job = text.split(/^ {2}(?=[a-z-]+:$)/m).find((part) => part.startsWith('native-darwin:'));
  assert.ok(job, 'ci.yml has no native-darwin job');
  const list = steps(job);
  const record = list.findIndex((step) => step.name === 'Record the display session');
  const tests = list.findIndex((step) => step.name === 'Native Darwin tests');
  assert.ok(record >= 0, `the native-darwin job has no step that records the display session: ${list.map((step) => step.name).join(', ')}`);
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
  const install = /run: pnpm -C core install --frozen-lockfile$/m;
  const core = /run: (?:make -C core|node core\/|pnpm -C core(?! install))/m;
  for (const job of jobs) {
    const name = job.split(':')[0];
    const list = steps(job);
    const first = list.findIndex((step) => core.test(step.text));
    if (first < 0) continue;
    const installed = list.findIndex((step) => install.test(step.text));
    assert.ok(installed >= 0 && installed < first,
      `${name}: the step ${list[first].name} runs a core command before the locked workspace dependencies are installed`);
  }
});

test('the hosted native job runs the native unit tests', () => {
  const job = read('.github/workflows/ci.yml').split(/^ {2}(?=[a-z-]+:$)/m).find((part) => part.startsWith('native-darwin:'));
  assert.ok(job, 'ci.yml has no native-darwin job');
  const hosted = steps(job).find((step) => step.name === 'Native Darwin tests');
  assert.ok(hosted, 'the native-darwin job has no step named Native Darwin tests');
  assert.match(hosted.text, /run: make -C core\/native\/darwin test$/m);
});

test('the release bundles build beside the checks and publication waits for both', () => {
  const release = read('.github/workflows/release.yml');
  // The gate and the bundle builds do not wait for the checks; publish requires the success of the checks and of both builds.
  assert.match(release, /^ {2}gate:\n {4}runs-on: /m, 'gate waits for the checks, so the bundle builds start after every check');
  for (const job of ['release-wailsv3', 'release-tauriv2']) {
    assert.match(release, new RegExp(`^ {2}${job}:\\n {4}needs: gate\\n`, 'm'), `${job} waits for a job other than gate`);
  }
  assert.match(release, /^ {2}publish:\n(?: {4}.+\n)*? {4}needs: \[checks, gate, release-wailsv3, release-tauriv2\]$/m,
    'publish does not require the checks and both builds');
});

test('a push to main releases the declared version after the checks and the gate succeed', () => {
  const release = read('.github/workflows/release.yml');
  assert.match(release, /^on:\n {2}push:\n {4}branches: \[main\]\n/m, 'release.yml starts on a push to main');
  assert.doesNotMatch(release, /tags: \['v\*'\]/, 'release.yml does not start on a tag push');
  assert.match(release, /^concurrency:\n {2}group: release\n {2}cancel-in-progress: false$/m);
  assert.match(release, /run: node packages\/plugin-api\/release-gate\.js packages\/plugin-api\/package\.json docs\/features\.md/);
  for (const job of ['release-wailsv3', 'release-tauriv2']) {
    assert.match(release, new RegExp(`  ${job}:\\n {4}needs: gate\\n {4}if: needs\\.gate\\.outputs\\.release == 'true'\\n`), `${job} runs only on a release`);
  }
  assert.match(release, /git ls-remote origin refs\/heads\/main/, 'publication requires the commit to be the head of main');
  // The registry lists a core release in its core.json; the release of core has no condition on the registry state.
  assert.doesNotMatch(release, /registry/i, 'release.yml reads no registry');
  assert.doesNotMatch(read('Makefile').match(/^release-check:.*$/m)[0], /registry/, 'release-check reads no registry');
  assert.match(release, /tag_name: v\$\{\{ needs\.gate\.outputs\.version \}\}/);
  assert.match(release, /target_commitish: \$\{\{ github\.sha \}\}/);
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
  for (const folder of ['packages/plugin-api', 'native/darwin/process-identity']) {
    assert.match(pack.text, new RegExp(`pnpm -C ${folder} pack --pack-destination "\\$PWD/dist"`), `${folder} is not packed into dist`);
  }
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
    'make -C core rust-repeat PACKAGE="$PACKAGE" TEST_TARGET="$TEST_TARGET" TEST="$TEST" COUNT="$COUNT"',
  ], `repeat.yml runs ${repeats.join(' | ')}`);
  // The dispatched values reach the commands through the environment, so no value is spliced into a shell line.
  assert.doesNotMatch(commands.join('\n'), /\$\{\{\s*inputs\./, 'a run line splices a dispatched input');
});
