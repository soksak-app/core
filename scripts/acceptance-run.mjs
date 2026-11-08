// Extends the existing window-check manifest with candidate inputs and its complete acceptance outcome.
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { hashFile, hashTree, hashValue } from './candidate-identity.mjs';
import { CANDIDATE_HOSTS } from './candidate-policy.mjs';
import { encodeAcceptanceReport } from './candidate-report.mjs';
import { runningProcess } from './test-evidence.mjs';
import { runCommand } from './test-command.mjs';
import { artifactExecutables, releasePlatform } from './platform/platform.js';

async function installReference(command, args, { signal } = {}) {
  const result = await runCommand({ id: `candidate reference ${args[0]} ${args[1]}`, command, args,
    cwd: dirname(command), timeoutMs: 600000, signal });
  if (result.status !== 'pass') throw new Error(`candidate reference installer ${result.status}: ${result.error?.message ?? result.stderr ?? result.exitCode}`);
}
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const byComponent = (a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`);
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const requireValue = (condition, message) => { if (!condition) throw new Error(`candidate acceptance: ${message}`); };
const configDir = (root, app) => join(root, `soksak-check-${app}`);
const executable = ({ bundle, app }) => artifactExecutables(bundle, app).application;

/** One checkout's complete tracked inputs; the subset hashes retain test and dependency ownership. */
export async function sourceIdentity(root) {
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const paths = git('ls-files', '-z').split('\0').filter(Boolean).sort();
  const entries = [];
  for (const path of paths) {
    const file = join(root, path);
    const info = await lstat(file);
    if (info.isSymbolicLink()) entries.push([path, 'link', await readlink(file), await hashFile(file)]);
    else {
      requireValue(info.isFile(), `tracked input ${path} is not a file`);
      entries.push([path, 'file', info.mode & 0o111, await hashFile(file)]);
    }
  }
  const tests = entries.filter(([path]) => /(^|\/)(test|tests|e2e)\/|(?:\.test\.|_test\.)/.test(path));
  const dependencies = entries.filter(([path]) => /(?:^|\/)(?:package\.json|Cargo\.(?:toml|lock)|pnpm-(?:lock|workspace)\.yaml|go\.(?:mod|sum)|Makefile|rust-toolchain(?:\.toml)?)$/.test(path));
  return { head: git('rev-parse', 'HEAD').trim(), dirty: git('status', '--porcelain=v1', '-z', '--untracked-files=all') !== '',
    sourceSha256: hashValue(entries), testsSha256: hashValue(tests), dependenciesSha256: hashValue(dependencies) };
}

/** Local installed bytes are compared across one run, never with another platform's optional dependencies.
 * Unlike bundle trees, pnpm dependencies link across package roots and may cycle; each resolved member is read once.
 */
export async function installedDependencyIdentity(root) {
  const base = await realpath(root), entries = [], visited = new Set();
  const paths = execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter((path) => basename(path) === 'package.json');
  const name = (path) => relative(base, path).replaceAll('\\', '/');
  async function visit(path) {
    const member = name(path);
    requireValue(member !== '' && member !== '..' && !member.startsWith('../') && !isAbsolute(member), 'installed dependency points outside its candidate checkout');
    if (visited.has(member)) return;
    visited.add(member);
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      entries.push([member, 'link', await readlink(path)]);
      await visit(await realpath(path));
    } else if (info.isDirectory()) {
      entries.push([member, 'directory']);
      for (const child of (await readdir(path)).sort()) await visit(join(path, child));
    } else {
      requireValue(info.isFile(), `installed dependency ${member} is not a regular file`);
      entries.push([member, 'file', info.mode & 0o111, await hashFile(path)]);
    }
  }
  for (const path of [...new Set(paths.map((path) => join(base, dirname(path), 'node_modules')))].sort()) {
    try { await lstat(path); }
    catch (error) { if (error.code === 'ENOENT') { entries.push([name(path), 'absent']); continue; } throw error; }
    await visit(path);
  }
  requireValue(visited.size > 0, 'installed dependencies are missing');
  return hashValue(entries.sort(([a], [b]) => a.localeCompare(b)));
}

async function componentDirectory(config, path) {
  requireValue(typeof path === 'string' && path !== '' && !isAbsolute(path), 'component path must be relative');
  const root = await realpath(config);
  const directory = await realpath(resolve(config, path));
  const inside = relative(root, directory);
  requireValue(inside !== '' && inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside), 'component path leaves its configuration');
  return directory;
}

function releaseOf(index, component, platform) {
  const collection = component.kind === 'plugin' ? index.plugins : index.sidecars;
  const owner = collection?.find((item) => (component.kind === 'plugin' ? item.id : item.name) === component.id);
  const version = owner?.versions?.find((item) => item.version === component.version);
  const release = component.kind === 'plugin' ? version?.release : version?.releases?.[platform];
  requireValue(release?.sha256 === component.releaseSha256, `component ${component.kind}:${component.id} release checksum differs from the frozen registry`);
  const revoked = component.kind === 'plugin' ? index.revoked?.plugins : index.revoked?.sidecars;
  requireValue(!revoked?.some((item) => (item.id ?? item.name) === component.id && item.version === component.version), `component ${component.id} is revoked`);
  return release;
}

async function installedComponents(config, context, index, checkTree = true) {
  const installed = await json(join(config, 'plugins', 'installed.json'));
  requireValue(installed?.format === 3 && installed.plugins && installed.sidecars, 'installed component format must be 3');
  const actual = [
    ...Object.entries(installed.plugins).map(([id, entry]) => ({ kind: 'plugin', id, ...entry })),
    ...Object.entries(installed.sidecars).map(([id, entry]) => ({ kind: 'sidecar', id, ...entry })),
  ].sort(byComponent);
  const expected = [...context.registry.components].sort(byComponent);
  requireValue(same(actual.map(({ kind, id }) => [kind, id]), expected.map(({ kind, id }) => [kind, id])), 'installed component cohort differs from the frozen cohort');
  const components = [];
  for (let i = 0; i < actual.length; i++) {
    const item = actual[i], wanted = expected[i];
    requireValue(item.version === wanted.version, `component ${item.id} version differs from the frozen cohort`);
    if (item.kind === 'plugin') requireValue(item.enabled === true, `component ${item.id} must be enabled`);
    releaseOf(index, wanted, context.platform ?? releasePlatform());
    const directory = await componentDirectory(config, item.path);
    const pkg = await json(join(directory, 'package.json'));
    requireValue(pkg.version === item.version, `component ${item.id} package version differs from its installation`);
    if (item.kind === 'plugin') requireValue((await json(join(directory, 'plugin.json'))).id === item.id, `component ${item.id} has another plugin identity`);
    const treeSha256 = await hashTree(directory);
    if (checkTree || wanted.treeSha256 !== undefined) requireValue(treeSha256 === wanted.treeSha256, `component ${item.id} content differs from its verified release payload`);
    components.push({ kind: item.kind, id: item.id, version: item.version, releaseSha256: wanted.releaseSha256, treeSha256 });
  }
  return components;
}

async function checkAssets(context) {
  requireValue(Array.isArray(context.assets) && context.assets.length > 0, 'candidate assets are required');
  requireValue(new Set(context.assets.map(({ name }) => name)).size === context.assets.length, 'candidate assets contain duplicate names');
  for (const asset of context.assets) {
    requireValue(typeof asset.name === 'string' && basename(asset.name) === asset.name && asset.name !== '', 'candidate asset name must not contain a path');
    requireValue(await hashFile(asset.path) === asset.sha256, `asset ${asset.name} changed`);
  }
}

/** Uses the candidate's public installer in an empty reference configuration to bind release bytes to installed trees. */
export async function prepareCandidate(input, { install = installReference, remove = rm, signal } = {}) {
  return prepareArtifactInputs(input, { install, remove, signal, candidate: true });
}

/** Ordinary prebuilt runs share the frozen component schema and actual installer verification, not candidate publication claims. */
export async function prepareOrdinaryArtifacts(input, { install = installReference, remove = rm, signal } = {}) {
  return prepareArtifactInputs(input, { install, remove, signal, candidate: false });
}

async function prepareArtifactInputs(input, { install, remove, signal, candidate }) {
  const context = structuredClone(input);
  requireValue(context.schema === 1 && (!candidate || context.candidate) && context.registry, 'candidate context schema must be 1');
  requireValue(same(context.hosts?.map(({ app }) => app).sort(), CANDIDATE_HOSTS), 'candidate context must name every candidate host exactly once');
  context.hosts.sort((a, b) => a.app.localeCompare(b.app));
  requireValue(context.registry.components?.length > 0, 'candidate component cohort is required');
  requireValue(new Set(context.registry.components.map(({ kind, id }) => `${kind}:${id}`)).size === context.registry.components.length, 'candidate component cohort contains duplicates');
  await checkAssets(context);
  const bytes = await readFile(context.registry.path);
  requireValue(await hashFile(context.registry.path) === context.registry.sha256, 'registry bytes differ from the frozen checksum');
  const index = JSON.parse(bytes);
  const pack = index.packs?.find(({ name }) => name === context.registry.pack);
  requireValue(Array.isArray(pack?.plugins) && pack.plugins.length > 0, 'candidate registry pack is missing or empty');
  const expectedPlugins = context.registry.components.filter(({ kind }) => kind === 'plugin').map(({ id }) => id);
  requireValue(pack.plugins.every((id) => expectedPlugins.includes(id)), 'candidate cohort omits a pack plugin');
  const directory = await mkdtemp(join(tmpdir(), 'soksak-candidate-reference-'));
  const dispose = () => remove(directory, { recursive: true, force: true });
  try {
    context.registry.path = join(directory, 'index.json');
    await writeFile(context.registry.path, bytes, { mode: 0o400 });
    requireValue(await hashFile(context.registry.path) === context.registry.sha256, 'registry bytes changed while the private copy was prepared');
    const reference = join(directory, 'reference');
    await mkdir(reference);
    const installer = artifactExecutables(context.hosts[0].bundle, context.hosts[0].app).installer;
    const bundleBefore = await hashTree(context.hosts[0].bundle);
    await install(installer, ['registry', 'use', context.registry.path, '--config-dir', reference], { signal });
    // Candidate scope is its pack; ordinary scope is its explicit full cohort.
    const referencePlugins = candidate ? pack.plugins : expectedPlugins;
    for (const id of referencePlugins) await install(installer, ['plugin', 'install', id, '--config-dir', reference], { signal });
    requireValue(await hashFile(context.registry.path) === context.registry.sha256, 'registry changed during reference installation');
    requireValue(await hashTree(context.hosts[0].bundle) === bundleBefore, 'candidate installer bundle changed during reference installation');
    context.registry.components = await installedComponents(reference, context, index, false);
    return { context, dispose };
  } catch (error) {
    try { await dispose(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'candidate reference installation and cleanup failed'); }
    throw error;
  }
}

/** Reads the actual endpoint process and every installed byte; a post-cleanup snapshot makes no live-process claim. */
export async function collectAcceptanceInputs(root, context, configRoot, { live = true, identify = runningProcess } = {}) {
  return collectArtifactInputs(root, context, configRoot, { live, identify, candidate: true });
}

/** Validates the same live executables and installed bytes while recording ordinary source state without a release claim. */
export async function collectOrdinaryInputs(root, context, configRoot, { live = true, identify = runningProcess } = {}) {
  return collectArtifactInputs(root, context, configRoot, { live, identify, candidate: false });
}

async function collectArtifactInputs(root, context, configRoot, { live, identify, candidate }) {
  await checkAssets(context);
  requireValue(await hashFile(context.registry.path) === context.registry.sha256, 'frozen registry changed during acceptance');
  const index = await json(context.registry.path);
  const source = await sourceIdentity(root);
  if (candidate) {
    requireValue(source.head === context.candidate.sha, 'candidate checkout does not match its artifact commit');
    requireValue(source.dirty === false, 'candidate checkout is dirty');
  }
  const hosts = [];
  for (const host of context.hosts) {
    const config = configDir(configRoot, host.app);
    const file = executable(host);
    let processIdentity;
    if (live) {
      const endpoint = await json(join(config, 'endpoint.json'));
      requireValue(endpoint.application === host.app, `endpoint does not belong to ${host.app}`);
      requireValue(await realpath(endpoint.executable) === await realpath(file), `endpoint executable differs from candidate ${host.app}`);
      processIdentity = await identify(root, { pid: endpoint.pid, executable: file });
    }
    const components = await installedComponents(config, context, index);
    hosts.push({ app: host.app, ...(live ? { pid: processIdentity.pid } : {}),
      executableSha256: live ? processIdentity.sha256 : await hashFile(file),
      bundleSha256: await hashTree(host.bundle), componentsSha256: hashValue(components) });
  }
  return { ...source, installedDependenciesSha256: await installedDependencyIdentity(root), hosts: hosts.sort((a, b) => a.app.localeCompare(b.app)) };
}

function immutableInputs(value) {
  if (!value) return null;
  return { ...value, hosts: value.hosts?.map(({ pid: _pid, ...host }) => host) };
}

const compactContext = (context) => ({ candidate: {
  repository: context.candidate.repository, workflow: context.candidate.workflow, runId: context.candidate.runId,
  runAttempt: context.candidate.runAttempt, sha: context.candidate.sha, version: context.candidate.version,
  artifacts: context.candidate.artifacts.map(({ id, name }) => ({ id, name })),
},
  assets: context.assets.map(({ name, sha256 }) => ({ name, sha256 })).sort((a, b) => a.name.localeCompare(b.name)),
  registry: { sha256: context.registry.sha256, pack: context.registry.pack, components: [...context.registry.components].sort(byComponent) } });

/** Attaches actual outcomes to the existing manifest, including failures that a passing file or log row cannot represent. */
export async function finishAcceptanceRun({ runFolder, context, script, initializationId, before, after, afterCleanup, plan, errors = [], finalize }) {
  const findings = [...errors];
  const read = async (name) => {
    try { return await json(join(runFolder, name)); }
    catch (error) { findings.push(`${name}: ${error.message}`); return null; }
  };
  const manifest = await read('manifest.json');
  const judgment = await read('judgment.json');
  const tests = manifest?.tests?.map(({ name, status }) => ({ name, status })) ?? [];
  if (!manifest?.finished_us || !tests.length || tests.some(({ status }) => status !== 'pass')) findings.push('window test execution is incomplete or failed');
  if (manifest?.script !== script) findings.push('window test script differs from the requested candidate script');
  const selection = manifest?.selection ?? null;
  if (!selection || selection.only !== null || selection.exclude?.length !== 0 || selection.changed !== false
    || selection.namePattern !== null || !same(selection.apps, CANDIDATE_HOSTS)) findings.push('candidate execution selected only part of the required cases or hosts');
  const audit = { status: judgment?.audit?.status ?? 'fail', findings: judgment?.audit?.findings ?? ['complete audit result is missing'],
    apps: [...new Set(judgment?.tests?.map(({ app }) => app) ?? [])].sort() };
  if (judgment?.run !== manifest?.run) findings.push('manifest and judgment belong to different runs');
  if (audit.status !== 'pass' || audit.findings.length || !same(audit.apps, CANDIDATE_HOSTS)
    || !judgment?.tests?.length || judgment.tests.some(({ result }) => result !== 'pass')) findings.push('application audit is incomplete or failed');
  if (!before || !after || !afterCleanup || !same(immutableInputs(before), immutableInputs(after))
    || !same(immutableInputs(before), immutableInputs(afterCleanup))) findings.push('candidate inputs changed or could not be verified through cleanup');
  if (plan.status !== 'pass' || !plan.steps?.length || plan.steps.some(({ status }) => status !== 'pass')) findings.push('candidate preparation, checks or cleanup failed');
  let native = null;
  if (script === 'test-app' || script === 'test-app:activation') {
    const evidence = await read('native/manifest.json');
    native = { tests: evidence?.tests?.map(({ name, status }) => ({ name, status })) ?? [] };
    if (!evidence?.finished_us || !native.tests.length || native.tests.some(({ status }) => status !== 'pass')) findings.push('native acceptance is incomplete or failed');
  }
  // A finalizer sees validation failures before deciding whether successful-run evidence may be removed.
  if (finalize) await finalize(findings);
  const run = { id: manifest?.run ?? basename(runFolder), script, initializationId, selection, before, after, afterCleanup, tests, audit, plan, native, errors: findings };
  const saved = { ...(manifest ?? { schema: 1, run: basename(runFolder), tests: [] }),
    acceptance: { schema: 1, ...compactContext(context), run } };
  await mkdir(runFolder, { recursive: true });
  await writeFile(join(runFolder, 'manifest.json'), `${JSON.stringify(saved, null, 2)}\n`);
  return run;
}

/** Combines retained manifests for transport; raw paths, outputs and failed results are never exported as acceptance. */
export async function writeAcceptanceReport(context, folders, output) {
  requireValue(folders.length > 0 && new Set(folders.map((folder) => resolve(folder))).size === folders.length, 'distinct acceptance run folders are required');
  await checkAssets(context);
  const records = [];
  for (const folder of folders) {
    const { acceptance } = await json(join(folder, 'manifest.json'));
    requireValue(acceptance?.schema === 1 && acceptance.run?.errors?.length === 0, 'acceptance run is incomplete or failed');
    requireValue(same(acceptance.candidate, compactContext(context).candidate), 'acceptance belongs to another candidate');
    requireValue(same(acceptance.assets, compactContext(context).assets), 'candidate assets differ between acceptance runs');
    requireValue(acceptance.registry.sha256 === context.registry.sha256 && acceptance.registry.pack === context.registry.pack, 'frozen registry differs between acceptance runs');
    if (records.length) requireValue(same(acceptance.registry, records[0].registry), 'installed cohort differs between acceptance runs');
    records.push(acceptance);
  }
  const report = { schema: 1, candidate: records[0].candidate, assets: records[0].assets, registry: records[0].registry,
    runs: records.map(({ run }) => run) };
  await writeFile(output, `${encodeAcceptanceReport(report)}\n`);
  return report;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { context: { type: 'string' }, run: { type: 'string', multiple: true }, out: { type: 'string' } } });
    requireValue(values.context && values.run?.length && values.out, 'usage: node scripts/acceptance-run.mjs --context <file> --run <folder>... --out <file>');
    await writeAcceptanceReport(await json(values.context), values.run, values.out);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
