// Checks the workflows of .github/workflows against docs/operations/examples.md#continuous-integration: every runner label is
// a hosted label of the repository or a label that the document declares, and the window-check workflow runs the checks, then
// the audit of the run folder, and keeps the run folder of a failed job.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const WORKFLOWS = join(ROOT, '.github', 'workflows');
const HOSTED = ['macos-15', 'ubuntu-26.04-arm'];
// scripts/test-runner.mjs supplies these values to each test process and its owner test checks that contract.
const RUNNER_ENVIRONMENT = new Set(['SOKSAK_RUN_ID', 'SOKSAK_RUN_FOLDER']);

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

test('the window-check workflow runs on a hosted runner with a virtual display and skips the checks that record the screen', () => {
  const text = read('.github/workflows/window-checks.yml');
  assert.deepEqual(runnerLabels(text), [['macos-15']]);
  assert.match(text, /^\s+SOKSAK_CHECK_DISPLAY: absent$/m, 'the job does not declare that its display presents no frames');
  assert.match(text, /^\s+SOKSAK_CHECK_PERSON: absent$/m, 'the job does not declare that no person answers its system prompts');
  const list = steps(text);
  const at = (name) => list.findIndex((step) => step.name === name);
  assert.ok(at('Start the virtual display') >= 0 && at('Start the virtual display') < at('Start both applications'),
    'the virtual display does not start before the applications');
  assert.doesNotMatch(text, /test-presentation/, 'the job runs the native presentation tests, which need presented frames');
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
  assert.match(keep.text, /\$\{\{ steps\.run\.outputs\.path \}\}/, 'the artifact holds the run folder');
  assert.ok(index('Keep the run folder') > index('Audit of the logs'), 'the artifact is taken after the audit');
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
  assert.match(publish, /needs: \[checks, gate, window-checks, release-wailsv3, release-tauriv2\]/);
  assert.match(publish, /if: always\(\) && needs\.gate\.outputs\.release == 'true'/);
  for (const [name, env] of [['checks', 'CHECKS_RESULT'], ['gate', 'GATE_RESULT'], ['window-checks', 'WINDOW_RESULT'], ['release-wailsv3', 'WAILS_RESULT'],
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
  const equivalenceHostTests = steps(job('equivalence')).find((step) => step.name === 'Host tests')?.text ?? '';
  assert.match(equivalenceHostTests, /run: make -C core host-contract-check$/m);
  assert.doesNotMatch(equivalenceHostTests, /go-format-check|rust-format-check|rust-clippy-check/,
    'language-owned format and lint checks are duplicated in equivalence');
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
  const eqChecks = equivalence.findIndex((step) => step.name === 'Host tests');
  assert.ok(eqFetch >= 0 && eqChecks > eqFetch, 'equivalence does not fetch native dependency before offline host checks');
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

test('the window-check workflow sets every variable that a window check of the run requires', { timeout: 1000 }, () => {
  const text = read('.github/workflows/window-checks.yml');
  const required = new Set();
  for (const file of readdirSync(join(ROOT, 'e2e')).filter((name) => name.endsWith('.test.mjs'))) {
    const source = read(`e2e/${file}`);
    for (const match of source.matchAll(/assert\.ok\(process\.env\.(\w+)|const \w+ = process\.env\.(\w+);\s*\n\s*assert\.ok\(\w+,/g)) required.add(match[1] ?? match[2]);
  }
  const missing = [...required].filter((name) => !RUNNER_ENVIRONMENT.has(name) && !new RegExp(`\\b${name}=`).test(text));
  assert.deepEqual(missing, [], `window-checks.yml does not set ${missing.join(', ')}`);
  assert.match(text, /SOKSAK_CANDIDATE_REGISTRY=file:\/\/\$GITHUB_WORKSPACE\/core\/target\/registry\/index\.json/,
    'the window-check workflow does not pass the candidate registry built by make install-plugins');
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

test('the native tests that need display presentation run in no workflow and the others in the hosted job', () => {
  const job = read('.github/workflows/ci.yml').split(/^ {2}(?=[a-z-]+:$)/m).find((part) => part.startsWith('native-darwin:'));
  assert.ok(job, 'ci.yml has no native-darwin job');
  const hosted = steps(job).find((step) => step.name === 'Native Darwin tests');
  assert.ok(hosted, 'the native-darwin job has no step named Native Darwin tests');
  assert.match(hosted.text, /run: make -C core\/native\/darwin test-without-presentation$/m);
  // A hosted display presents no frames, so the presentation tests run in the local checks only.
  for (const file of readdirSync(WORKFLOWS).filter((name) => name.endsWith('.yml'))) {
    assert.doesNotMatch(readFileSync(join(WORKFLOWS, file), 'utf8'), /test-presentation\b/, `${file} runs the native presentation tests`);
  }
});

test('a push to main releases the declared version after the checks, the gate and the window checks succeed', () => {
  const release = read('.github/workflows/release.yml');
  assert.match(release, /^on:\n {2}push:\n {4}branches: \[main\]\n/m, 'release.yml starts on a push to main');
  assert.doesNotMatch(release, /tags: \['v\*'\]/, 'release.yml does not start on a tag push');
  assert.match(release, /^concurrency:\n {2}group: release\n {2}cancel-in-progress: false$/m);
  assert.match(release, /run: node packages\/plugin-api\/release-gate\.js packages\/plugin-api\/package\.json docs\/features\.md/);
  assert.match(release, /window-checks:\n {4}needs: gate\n {4}if: needs\.gate\.outputs\.release == 'true'\n {4}uses: \.\/\.github\/workflows\/window-checks\.yml/);
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
  const windows = read('.github/workflows/window-checks.yml');
  assert.match(windows, /^on:\n {2}workflow_call:\n {2}workflow_dispatch:\n/m, 'window-checks.yml runs for release.yml and on request');
});

test('the window-check jobs keep the output file of each application with the event logs', () => {
  for (const workflow of ['.github/workflows/window-checks.yml']) {
    const text = read(workflow);
    for (const app of ['wailsv3', 'tauriv2']) {
      assert.match(text, new RegExp(`\\$\\{\\{ runner\\.temp \\}\\}/${app}\\.out`), `${workflow} keeps no ${app}.out`);
    }
  }
});

test('a window-check job without a run folder uploads no part of the checkout', () => {
  for (const workflow of ['.github/workflows/window-checks.yml']) {
    const text = read(workflow);
    assert.doesNotMatch(text, /core\/\$\{\{ steps\.run\.outputs\.folder \}\}/, `${workflow} uploads core/ when no run folder exists`);
    assert.match(text, /if \[ -n "\$folder" \]; then[^\n]*path=core\//, `${workflow} names the run folder path only when it exists`);
    assert.match(text, /^\s+\$\{\{ steps\.run\.outputs\.path \}\}$/m, `${workflow} uploads no run folder path`);
  }
});

test('the window-check jobs record how each application ended and keep every crash report of the applications', { timeout: 1000 }, () => {
  for (const workflow of ['.github/workflows/window-checks.yml']) {
    const text = read(workflow);
    // A host that ends without a record of its own (no log.closed, no fatal record) is named by its exit status, which only the
    // parent shell of the application receives.
    assert.match(text, /wait "\$!"; echo "\$\? \$\(date -u [^\n]*\)" > "\$RUNNER_TEMP\/\$app\.status"/, `${workflow} does not record the exit status of each application`);
    assert.match(text, /^\s+\$\{\{ runner\.temp \}\}\/\*\.status$/m, `${workflow} uploads no exit status`);
    // The system writes a crash report also for a crash that the fatal record of the host did not reach.
    assert.match(text, /find "\$reports" -maxdepth 1 -name "soksak-\$app-\*\.ips" -exec cp \{\} "\$RUNNER_TEMP\/crash-reports\/" \\;/, `${workflow} keeps the crash reports only of a host that wrote a fatal record`);
  }
});

test('the window-check jobs resolve the fault of each crash report of an application on the runner', { timeout: 1000 }, () => {
  for (const workflow of ['.github/workflows/window-checks.yml']) {
    const text = read(workflow);
    // The library that holds the fault address is the build of the runner, so only the runner resolves it.
    assert.match(text, /fault="\$\(node core\/scripts\/crash-fault\.mjs "\$report"\)"/, `${workflow} does not name the fault of each crash report`);
    assert.match(text, /atos -o "\$\(jq -r \.path <<<"\$fault"\)" -arch "\$\(jq -r \.arch <<<"\$fault"\)" -l "\$\(jq -r \.load <<<"\$fault"\)" "\$\(jq -r \.address <<<"\$fault"\)" > "\$report\.fault\.txt"/,
      `${workflow} does not resolve the fault address with atos`);
  }
});

test('the window-check jobs wait for the applications to end and keep the crash report of an application that crashed', () => {
  for (const workflow of ['.github/workflows/window-checks.yml']) {
    const text = read(workflow);
    assert.match(text, /while kill -0 "\$pid"/, `${workflow} does not wait for the stopped applications to end`);
    assert.match(text, /- name: Keep the crash reports\n\s+if: always\(\)/, `${workflow} has no crash report step`);
    assert.match(text, /error native fatal: [^\n]*host-\*\.stderr/, `${workflow} does not read the fatal record of each host`);
    assert.match(text, /Library\/Logs\/DiagnosticReports/, `${workflow} does not read the crash reports of the system`);
    assert.match(text, /^\s+\$\{\{ runner\.temp \}\}\/crash-reports$/m, `${workflow} uploads no crash reports`);
    assert.match(text, /JetsamEvent-\*\.ips/, `${workflow} does not keep the memory pressure reports`);
    assert.match(text, /log show [^\n]*memorystatus/, `${workflow} does not keep the kernel records of ended processes`);
  }
});
