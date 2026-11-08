import assert from "node:assert/strict";
import test from "node:test";

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";

import { buildPublicRegistry, buildWorkspaceRegistry, checkDeclaration, checkOptions, checkPluginId, installFolders, packPlugin, publicRegistryEntries, readIndex,
  releaseSidecar, repositoryFolder, sidecarReleases, sourceRevision } from "../workspace-registry.mjs";

const SHA = "a".repeat(64);

test("the workspace registry declaration names sibling folders and is checked before anything is built", { timeout: 1000 }, () => {
  const declaration = checkDeclaration(JSON.parse(readFileSync(new URL("../workspace-registry.json", import.meta.url), "utf8")));
  assert.ok(declaration.plugins.length > 0);
  const base = { plugins: [{ repository: "../plugins/a", id: "a" }], sidecars: [{ repository: "../sidecars/a", folder: "." }], packs: [] };
  assert.deepEqual(checkDeclaration(base), base);
  for (const [change, message] of [
    [{ plugins: ["../plugins/a"] }, /plugins must be \{ repository, id \} with a relative folder and a plugin id/],
    [{ plugins: [{ repository: "/abs/a", id: "a" }] }, /plugins must be \{ repository, id \} with a relative folder and a plugin id/],
    [{ plugins: [{ repository: "../plugins/a", id: "" }] }, /plugins must be \{ repository, id \} with a relative folder and a plugin id/],
    [{ plugins: [{ repository: "../plugins/a", id: "a" }, { repository: "../plugins/a", id: "b" }] }, /a plugin folder is repeated/],
    [{ plugins: [{ repository: "../plugins/a", id: "a" }, { repository: "../plugins/b", id: "a" }] }, /a plugin id is repeated/],
    [{ sidecars: [{ repository: "../sidecars/a" }] }, /sidecars must be \{ repository, folder \}/],
    [{ packs: {} }, /packs must be a list/],
    [{ extra: 1 }, /expected the keys packs, plugins and sidecars/],
  ]) assert.throws(() => checkDeclaration({ ...base, ...change }), message);
});

test("the registry releases every declared sidecar, also one that no workspace plugin uses", { timeout: 1000 }, () => {
  const declared = ["@scope/sidecar-used", "@scope/sidecar-for-connectors"];
  const manifests = [{ id: "user", dependencies: { "@scope/sidecar-used": "^1.0.0", "@scope/plugin-other": "^1.0.0" } }, { id: "plain" }];
  assert.deepEqual(sidecarReleases(declared, manifests, new Set(["@scope/plugin-other"])), declared);
  assert.throws(() => sidecarReleases(declared, [{ id: "user", dependencies: { "@scope/sidecar-missing": "^1.0.0" } }], new Set()),
    /plugin user uses @scope\/sidecar-missing, which no declared sidecar or plugin folder holds/);
});

test("the repository table names the plugins that the workspace registry declares", { timeout: 1000 }, () => {
  const declaration = JSON.parse(readFileSync(new URL("../workspace-registry.json", import.meta.url), "utf8"));
  const declared = declaration.plugins.map((plugin) => plugin.repository.replace(/^\.\.\/plugins\//, "")).sort();
  const spec = readFileSync(new URL("../../docs/spec/plugins.md", import.meta.url), "utf8");
  const sentence = spec.match(/The plugins are ([^;|]+?)[;|]/)?.[1] ?? "";
  const listed = [...sentence.matchAll(/`([^`]+)`/g)].map((match) => match[1]).sort();
  assert.deepEqual(listed, declared);
});

test("a declared repository folder resolves from the main checkout, also when the script runs in a worktree", { timeout: 1000 }, () => {
  // The git common directory of a worktree under <main>/.claude/worktrees/ is <main>/.git, so the main checkout is its parent.
  assert.equal(repositoryFolder("../plugins/probe", "/work/core/.git"), "/work/plugins/probe");
  assert.equal(repositoryFolder("../sidecars/probe", "/work/core/.git"), "/work/sidecars/probe");
});

test("a plugin is packed by the make pack target of its repository, which receives only the output folder", { timeout: 30000 }, (t) => {
  const repository = mkdtempSync(join(tmpdir(), "workspace-pack-"));
  const out = mkdtempSync(join(tmpdir(), "workspace-releases-"));
  t.after(() => { rmSync(repository, { recursive: true, force: true }); rmSync(out, { recursive: true, force: true }); });
  // The release is the pnpm pack file of the plugin (docs/spec/installation.md#plugin-release), so the target needs no sok
  // executable and no flags; it writes a release that names the origin of each variable.
  writeFileSync(join(repository, "Makefile"), 'pack:\n\t@printf "%s %s" "$(origin SOK)" "$(origin PACK_FLAGS)" > "$(OUT)/probe-0.0.1.tgz"\n');
  const pack = packPlugin(repository, out);
  const release = join(out, "probe-0.0.1.tgz");
  assert.equal(readFileSync(release, "utf8"), "undefined undefined");
  assert.deepEqual(pack, { release, sha256: createHash("sha256").update("undefined undefined").digest("hex") });
  // A release that the folder already holds is not a new release of this run.
  assert.throws(() => packPlugin(repository, out), /make pack of .* wrote 0 new files into .*; expected 1/);
});

test("a sidecar is released by the make release target of its repository, which receives only the output folder", { timeout: 30000 }, (t) => {
  const repository = mkdtempSync(join(tmpdir(), "workspace-release-"));
  const out = mkdtempSync(join(tmpdir(), "workspace-releases-"));
  t.after(() => { rmSync(repository, { recursive: true, force: true }); rmSync(out, { recursive: true, force: true }); });
  // The release is the npm pack file of the built sidecar folder (docs/spec/installation.md#sidecar-release), so the target
  // needs no sok executable; it writes a release that names the origin of the variable, and its name gives the platform.
  writeFileSync(join(repository, "Makefile"), 'release:\n\t@printf "%s" "$(origin SOK)" > "$(OUT)/$(NAME)"\n');
  process.env.NAME = "worker-0.0.1-linux-x64.tgz";
  t.after(() => { delete process.env.NAME; });
  assert.deepEqual(releaseSidecar(repository, out), { release: join(out, "worker-0.0.1-linux-x64.tgz"), platform: "linux-x64",
    sha256: createHash("sha256").update("undefined").digest("hex") });
  assert.throws(() => releaseSidecar(repository, out), /make release of .* wrote 0 new files into .*; expected 1/);
  process.env.NAME = "worker-0.0.1.tgz";
  assert.throws(() => releaseSidecar(repository, out), /whose name ends with no <os>-<arch>\.tgz/);
});

test("the installation stage runs make install once in every declared repository", { timeout: 1000 }, () => {
  const declaration = { plugins: [{ repository: "../plugins/a", id: "a" }, { repository: "../plugins/b", id: "b" }],
    sidecars: [{ repository: "../sidecars/s", folder: "one" }, { repository: "../sidecars/s", folder: "two" }], packs: [] };
  assert.deepEqual(installFolders(declaration, (relative) => `/work/${relative.slice(3)}`),
    ["/work/plugins/a", "/work/plugins/b", "/work/sidecars/s"]);
});

test("a relative output folder of a pack resolves from the working directory, not from the plugin repository", { timeout: 30000 }, (t) => {
  const repository = mkdtempSync(join(tmpdir(), "workspace-pack-"));
  const out = mkdtempSync(join(tmpdir(), "workspace-releases-"));
  t.after(() => { rmSync(repository, { recursive: true, force: true }); rmSync(out, { recursive: true, force: true }); });
  // make -C runs the target in the repository, so the target receives the absolute folder that it writes into.
  writeFileSync(join(repository, "Makefile"), 'pack:\n\t@printf "%s" "$(OUT)" > "$(OUT)/probe-0.0.1.tgz"\n');
  const pack = packPlugin(repository, relative(process.cwd(), out));
  assert.equal(pack.release, join(out, "probe-0.0.1.tgz"));
  assert.equal(readFileSync(pack.release, "utf8"), out);
});

// make check-boundaries reads the plugin ids from the declaration, so the registry build, which reads each plugin.json, rejects a
// declaration that names another id.
test("a plugin.json that names another id than its declaration fails the registry build with the file and both values", { timeout: 1000 }, () => {
  assert.equal(checkPluginId({ repository: "../plugins/a", id: "a" }, { id: "a" }, "/work/plugins/a/plugin.json"), undefined);
  assert.throws(() => checkPluginId({ repository: "../plugins/a", id: "a" }, { id: "b" }, "/work/plugins/a/plugin.json"),
    /^Error: \/work\/plugins\/a\/plugin\.json: id is "b", but scripts\/workspace-registry\.json declares "a"$/);
});

const GIT = ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"];

/** Creates a git repository at dir with the files, all committed, and returns its HEAD. */
function gitRepository(dir, files) {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", [...GIT, "-C", dir, "add", "."]);
  execFileSync("git", [...GIT, "-C", dir, "commit", "-q", "-m", "fixture"]);
  return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

/** Writes into dir an executable that stands for sok: it answers `registry build <folder>` with the counts of the entry files of the folder. */
function fakeSok(dir) {
  const sok = join(dir, "sok");
  writeFileSync(sok, '#!/bin/sh\nprintf \'{"index":"%s/index.json","plugins":%s,"sidecars":%s,"packs":%s}\' "$3" '
    + '"$(ls "$3/plugins" | wc -l | tr -d " ")" "$(ls "$3/sidecars" | wc -l | tr -d " ")" "$(ls "$3/packs" | wc -l | tr -d " ")"\n');
  chmodSync(sok, 0o755);
  return sok;
}

/**
 * A workspace of a core checkout, one plugin repository and two sidecar repositories, and an executable that stands for sok.
 * The sidecar repository `rust` records in its release the PROFILE and FEATURES that its make release receives; the sidecar
 * repository `go` builds the same release whatever it receives. `rust` holds only an ignored file outside its revision and `go`
 * an untracked file.
 */
function workspaceFixture(t) {
  const work = mkdtempSync(join(tmpdir(), "workspace-registry-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const core = join(work, "core");
  gitRepository(core, { "scripts/workspace-registry.json": JSON.stringify({
    plugins: [{ repository: "../plugins/probe", id: "probe" }],
    sidecars: [{ repository: "../sidecars/rust", folder: "engine" }, { repository: "../sidecars/go", folder: "." }],
    packs: [{ name: "starter", description: "Probe.", plugins: ["probe"] }],
  }) });
  gitRepository(join(work, "plugins/probe"), {
    "Makefile": 'pack:\n\t@printf "pack" > "$(OUT)/probe-0.0.1.tgz"\n',
    "plugin.json": JSON.stringify({ id: "probe", name: "검사", dependencies: { "@scope/sidecar-engine": "^0.0.2" } }),
    "package.json": JSON.stringify({ name: "@scope/plugin-probe", version: "0.0.1", description: "Probe plugin.", license: "MIT",
      repository: "https://example.invalid/probe", engines: { soksak: "^0.0.1" } }),
  });
  const rust = gitRepository(join(work, "sidecars/rust"), {
    ".gitignore": "build/\n",
    "Makefile": 'release:\n\t@printf "%s|%s" "$(PROFILE)" "$(FEATURES)" > "$(OUT)/scope-sidecar-engine-0.0.2-linux-x64.tgz"\n',
    "engine/package.json": JSON.stringify({ name: "@scope/sidecar-engine", version: "0.0.2", repository: "https://example.invalid/engine" }),
    "engine/sidecar.json": JSON.stringify({ executable: "build/engine", protocol: 1 }),
  });
  mkdirSync(join(work, "sidecars/rust/build"));
  writeFileSync(join(work, "sidecars/rust/build/engine"), "built");
  const go = gitRepository(join(work, "sidecars/go"), {
    "Makefile": 'release:\n\t@printf "built" > "$(OUT)/scope-sidecar-files-0.0.3-linux-x64.tgz"\n',
    "package.json": JSON.stringify({ name: "@scope/sidecar-files", version: "0.0.3", repository: "https://example.invalid/files" }),
    "sidecar.json": JSON.stringify({ executable: "build/files", protocol: 1 }),
  });
  writeFileSync(join(work, "sidecars/go/notes.txt"), "not committed");
  return { work, root: pathToFileURL(`${core}/`), sok: fakeSok(work), out: join(work, "registry"), revisions: { rust, go } };
}

const releaseText = (out, name) => readFileSync(join(out, "releases", name), "utf8");

test("SIDECARS=diagnostic releases each sidecar with PROFILE=release FEATURES=diagnostics and records the revision of each sidecar repository", { timeout: 30000 }, async (t) => {
  const fixture = workspaceFixture(t);
  const result = await buildWorkspaceRegistry(fixture.sok, fixture.out, { sidecars: "diagnostic", root: fixture.root });
  assert.deepEqual(result, { index: join(fixture.out, "index.json"), plugins: 1, sidecars: 2, packs: 1 });
  assert.equal(releaseText(fixture.out, "scope-sidecar-engine-0.0.2-linux-x64.tgz"), "release|diagnostics");
  assert.equal(releaseText(fixture.out, "scope-sidecar-files-0.0.3-linux-x64.tgz"), "built");
  assert.equal(releaseText(fixture.out, "probe-0.0.1.tgz"), "pack");
  assert.deepEqual(JSON.parse(readFileSync(join(fixture.out, "sidecar-revisions.json"), "utf8")), { sidecars: [
    { repository: "../sidecars/rust", revision: fixture.revisions.rust, changes: false },
    { repository: "../sidecars/go", revision: fixture.revisions.go, changes: true },
  ] });
});

test("the default registry releases each sidecar as its make release builds it and removes the revision record of an earlier diagnostic run", { timeout: 30000 }, async (t) => {
  const fixture = workspaceFixture(t);
  mkdirSync(fixture.out);
  writeFileSync(join(fixture.out, "sidecar-revisions.json"), JSON.stringify({ sidecars: [] }));
  await buildWorkspaceRegistry(fixture.sok, fixture.out, { root: fixture.root });
  assert.equal(releaseText(fixture.out, "scope-sidecar-engine-0.0.2-linux-x64.tgz"), "|");
  assert.equal(releaseText(fixture.out, "scope-sidecar-files-0.0.3-linux-x64.tgz"), "built");
  assert.equal(existsSync(join(fixture.out, "sidecar-revisions.json")), false);
});

test("the revision of a sidecar repository counts a tracked modification as a change and fails for a folder without a repository", { timeout: 30000 }, (t) => {
  const work = mkdtempSync(join(tmpdir(), "workspace-revision-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const repository = join(work, "sidecar");
  const revision = gitRepository(repository, { "Makefile": "release:\n" });
  assert.deepEqual(sourceRevision(repository), { revision, changes: false });
  writeFileSync(join(repository, "Makefile"), "release: build\n");
  assert.deepEqual(sourceRevision(repository), { revision, changes: true });
  mkdirSync(join(work, "plain"));
  assert.throws(() => sourceRevision(join(work, "plain")), /plain: the revision of the sidecar repository cannot be read: .*not a git repository/s);
});

test("the registry options take SIDECARS=diagnostic and PLUGINS=public, and PLUGINS=public only with SIDECARS=diagnostic", { timeout: 1000 }, () => {
  assert.equal(checkOptions({}), undefined);
  assert.equal(checkOptions({ sidecars: "diagnostic" }), undefined);
  assert.equal(checkOptions({ sidecars: "diagnostic", plugins: "public" }), undefined);
  assert.throws(() => checkOptions({ sidecars: "debug" }), /^Error: --sidecars must be diagnostic \(make build-registry SIDECARS=diagnostic\), not "debug"$/);
  assert.throws(() => checkOptions({ sidecars: "diagnostic", plugins: "all" }), /^Error: --plugins must be public \(make build-registry PLUGINS=public\), not "all"$/);
  assert.throws(() => checkOptions({ plugins: "public" }),
    /^Error: --plugins public lists the sidecar releases of --sidecars diagnostic: make build-registry SIDECARS=diagnostic PLUGINS=public$/);
});

const ENGINE = "@scope/sidecar-engine";
const publicVersion = (version, sidecars) => ({ version,
  release: { url: `https://github.com/scope/probe/releases/download/v${version}/scope-plugin-probe-${version}.tgz`, sha256: SHA },
  engines: { soksak: "^0.0.1" }, sidecars });
const publicPlugin = (id, versions) => ({ id, package: `@scope/plugin-${id}`, name: id, description: "Probe plugin.", license: "MIT",
  repository: `https://github.com/scope/${id}`, versions });
/** An index of the public registry: its old plugin versions need sidecar versions that the diagnostic sidecar release is not. */
const publicIndex = (probe, revoked = []) => ({
  format: 1,
  plugins: [publicPlugin("probe", probe), publicPlugin("plain", [publicVersion("0.0.4", {})])],
  sidecars: [{ name: ENGINE, repository: "https://github.com/scope/engine", versions: ["0.0.1", "0.0.2"].map((version) => ({ version, protocol: 1,
    releases: { "linux-x64": { url: `https://github.com/scope/engine/releases/download/v${version}/scope-sidecar-engine-${version}-linux-x64.tgz`, sha256: SHA } } })) }],
  core: { versions: [{ version: "0.0.1", releases: { "linux-x64-tauriv2": { url: "https://github.com/soksak-app/core/releases/download/v0.0.1/soksak-0.0.1-linux-x64-tauriv2.zip", sha256: SHA } } }] },
  packs: [{ name: "starter", description: "Probe.", plugins: ["plain", "probe"] }],
  revoked: { plugins: [...revoked, { id: "plain", version: "0.0.4", reason: "Probe." }],
    sidecars: [{ name: ENGINE, version: "0.0.1", reason: "Probe." }], core: [] },
});
/** The sidecar entries that make build-registry SIDECARS=diagnostic wrote: one release of version 0.0.2. */
const diagnosticSidecars = (url = "file:///registry/releases/scope-sidecar-engine-0.0.2-linux-x64.tgz") => [{ name: ENGINE,
  repository: "https://github.com/scope/engine", versions: [{ version: "0.0.2", protocol: 1, releases: { "linux-x64": { url, sha256: SHA } } }] }];

test("PLUGINS=public lists the plugin versions of the public registry whose sidecar ranges the diagnostic sidecar releases satisfy", { timeout: 1000 }, () => {
  const index = publicIndex([publicVersion("0.0.1", { [ENGINE]: "0.0.1" }), publicVersion("0.0.2", { [ENGINE]: "^0.0.2" })],
    [{ id: "probe", version: "0.0.1", reason: "Probe." }]);
  assert.deepEqual(publicRegistryEntries(index, diagnosticSidecars()), {
    plugins: [publicPlugin("probe", [publicVersion("0.0.2", { [ENGINE]: "^0.0.2" })]), publicPlugin("plain", [publicVersion("0.0.4", {})])],
    packs: index.packs,
    // The public sidecars and the core releases are not listed, so the index withdraws none of them.
    revoked: { plugins: [{ id: "plain", version: "0.0.4", reason: "Probe." }], sidecars: [] },
    dropped: [{ id: "probe", version: "0.0.1", sidecar: ENGINE, range: "0.0.1" }],
  });
  // A revoked version is not selected, so a newer revoked version that the diagnostic sidecars do not satisfy is left out.
  const revoked = publicIndex([publicVersion("0.0.2", { [ENGINE]: "^0.0.2" }), publicVersion("0.0.3", { [ENGINE]: "^0.0.3" })],
    [{ id: "probe", version: "0.0.3", reason: "Probe." }]);
  assert.deepEqual(publicRegistryEntries(revoked, diagnosticSidecars()).dropped, [{ id: "probe", version: "0.0.3", sidecar: ENGINE, range: "^0.0.3" }]);
});

test("PLUGINS=public fails when leaving out a version would make an installation select an older version or no version", { timeout: 1000 }, () => {
  const newer = publicIndex([publicVersion("0.0.2", { [ENGINE]: "^0.0.2" }), publicVersion("0.0.3", { [ENGINE]: "^0.0.3" })]);
  assert.throws(() => publicRegistryEntries(newer, diagnosticSidecars()),
    /^Error: public registry: plugin probe 0\.0\.3 needs @scope\/sidecar-engine \^0\.0\.3, which no sidecar release of make build-registry SIDECARS=diagnostic satisfies, and its older version 0\.0\.2 is listed, so an installation would select 0\.0\.2 where the public registry selects 0\.0\.3$/);
  const none = publicIndex([publicVersion("0.0.1", { [ENGINE]: "0.0.1" })]);
  assert.throws(() => publicRegistryEntries(none, diagnosticSidecars()),
    /^Error: public registry: plugin probe has no version whose sidecar ranges the sidecar releases of make build-registry SIDECARS=diagnostic satisfy$/);
  const unknown = publicIndex([publicVersion("0.0.2", { "@scope/sidecar-other": "^0.0.1" })]);
  assert.throws(() => publicRegistryEntries(unknown, diagnosticSidecars()), /plugin probe has no version whose sidecar ranges/);
});

/** A registry folder as make build-registry SIDECARS=diagnostic leaves it: the revision record, the sidecar entries and their releases. */
function diagnosticRegistry(t) {
  const work = mkdtempSync(join(tmpdir(), "workspace-public-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const registry = join(work, "registry");
  const release = join(registry, "releases", "scope-sidecar-engine-0.0.2-linux-x64.tgz");
  mkdirSync(dirname(release), { recursive: true });
  writeFileSync(release, "diagnostic");
  mkdirSync(join(registry, "sidecars"));
  writeFileSync(join(registry, "sidecars", "scope-sidecar-engine.json"), JSON.stringify(diagnosticSidecars(pathToFileURL(release).href)[0]));
  writeFileSync(join(registry, "sidecar-revisions.json"), JSON.stringify({ sidecars: [{ repository: "../sidecars/engine", revision: "b".repeat(40), changes: false }] }));
  return { work, registry, release, sok: fakeSok(work), out: join(work, "registry-public") };
}

test("PLUGINS=public writes the public plugin entries beside the sidecar entries of make build-registry SIDECARS=diagnostic and builds no release", { timeout: 30000 }, async (t) => {
  const fixture = diagnosticRegistry(t);
  mkdirSync(join(fixture.out, "plugins"), { recursive: true });
  writeFileSync(join(fixture.out, "plugins", "earlier.json"), "{}");
  const index = publicIndex([publicVersion("0.0.1", { [ENGINE]: "0.0.1" }), publicVersion("0.0.2", { [ENGINE]: "^0.0.2" })]);
  const result = await buildPublicRegistry(fixture.sok, fixture.out, fixture.registry, index);
  assert.deepEqual(result, { index: join(fixture.out, "index.json"), plugins: 2, sidecars: 1, packs: 1,
    dropped: [{ id: "probe", version: "0.0.1", sidecar: ENGINE, range: "0.0.1" }] });
  const file = (...path) => JSON.parse(readFileSync(join(fixture.out, ...path), "utf8"));
  assert.deepEqual(file("plugins", "probe.json"), publicPlugin("probe", [publicVersion("0.0.2", { [ENGINE]: "^0.0.2" })]));
  assert.deepEqual(file("plugins", "plain.json"), index.plugins[1]);
  assert.deepEqual(file("sidecars", "scope-sidecar-engine.json"), diagnosticSidecars(pathToFileURL(fixture.release).href)[0]);
  assert.deepEqual(file("packs", "starter.json"), index.packs[0]);
  assert.deepEqual(file("revoked.json"), { plugins: [{ id: "plain", version: "0.0.4", reason: "Probe." }], sidecars: [] });
  assert.equal(existsSync(join(fixture.out, "releases")), false);
  assert.equal(existsSync(join(fixture.out, "core.json")), false);
});

test("PLUGINS=public fails when the checkout holds no sidecar releases of make build-registry SIDECARS=diagnostic", { timeout: 30000 }, async (t) => {
  const index = publicIndex([publicVersion("0.0.2", { [ENGINE]: "^0.0.2" })]);
  const fixture = diagnosticRegistry(t);
  rmSync(fixture.release);
  await assert.rejects(() => buildPublicRegistry(fixture.sok, fixture.out, fixture.registry, index),
    /sidecars\/scope-sidecar-engine\.json: release .*scope-sidecar-engine-0\.0\.2-linux-x64\.tgz of linux-x64 is missing; run make build-registry SIDECARS=diagnostic first$/);
  rmSync(join(fixture.registry, "sidecar-revisions.json"));
  await assert.rejects(() => buildPublicRegistry(fixture.sok, fixture.out, fixture.registry, index),
    /registry\/sidecar-revisions\.json is missing: --plugins public lists the sidecar releases that make build-registry SIDECARS=diagnostic writes; run make build-registry SIDECARS=diagnostic first$/);
  await assert.rejects(() => buildPublicRegistry(fixture.sok, fixture.registry, fixture.registry, index),
    /^Error: --out .*registry is the folder of the sidecar releases; PLUGINS=public writes another folder$/);
});

test("the index of the public registry is read from its address, and an answer other than 200 is an error", { timeout: 10000 }, async (t) => {
  const index = publicIndex([publicVersion("0.0.2", { [ENGINE]: "^0.0.2" })]);
  const server = createServer((request, response) => {
    if (request.url !== "/index.json") return response.writeHead(404).end();
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(index));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.deepEqual(await readIndex(`${base}/index.json`), index);
  await assert.rejects(readIndex(`${base}/missing.json`), new RegExp(`^Error: ${base}/missing\\.json: HTTP 404$`));
});
