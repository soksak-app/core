# Public registry

[한국어](registry.ko.md)

The public registry is the repository `soksak-app/registry`. It holds one file per entry of the [registry index](installation.md#registry-index), and anyone adds an entry or a version with a pull request. A check validates each pull request, the registry maintainers review and merge it, and each push to `main` publishes `index.json` at `https://soksak-app.github.io/registry/index.json`, the default registry of the applications ([first run](installation.md#first-run)).

## Files

| Path | Content | Changed by |
| --- | --- | --- |
| `plugins/<id>.json` | One plugin entry of the index | The owner of the entry's repository |
| `sidecars/<file name>.json` | One sidecar entry of the index | The owner of the entry's repository |
| `packs/<name>.json` | One pack of the index | Registry maintainers |
| `core.json` | `core` of the index: the core releases, each `<platform>-<host>` with the zip of the application bundle | Registry maintainers |
| `revoked.json` | `{ plugins, sidecars, core }` of the index | Registry maintainers |
| `.github/`, `scripts/`, `test/`, `CODEOWNERS` | The checks and workflows | Registry maintainers |

These files are the source of the index; `index.json` is built from them by `sok registry build` ([command line](cli.md#releases-and-the-registry)) and is not committed. `CODEOWNERS` names the registry maintainers for every path that only they change. Core window checks use the fixture registry that `make build-fixture-registry` builds from the fixtures of core ([verification boundaries](plugin-processes.md#verification-boundaries)) and read no plugin repository and no public index; the public registry has no local build in core.

## Entry rules

A plugin or sidecar entry follows the [registry index](installation.md#registry-index) and these rules:

- `repository` is `https://github.com/<owner>/<repo>`, the repository that publishes the entry's releases.
- Every `url` is `https://github.com/<owner>/<repo>/releases/download/v<version>/<file>` with the `<owner>` and `<repo>` of `repository` and the version of its entry. `<file>` is `<scope>-<name>-<version>.tgz`, the `pnpm pack` file of the plugin `@<scope>/<name>`, for a plugin version, and `<file name>-<version>-<platform>.tgz`, the `npm pack` file of the built sidecar folder, for a sidecar release of a platform ([installation](installation.md)).
- Every `url` of `core.json` is `https://github.com/soksak-app/core/releases/download/v<version>/soksak-<version>-<platform>-<host>.zip`.
- A version that the published index lists does not change: its `url`, `sha256`, `engines`, `sidecars`, `protocol` and releases stay as they are, and it is not removed. A version is withdrawn only by a `revoked.json` entry. A plugin or sidecar that is retired, whose repository is archived and on which no listed plugin depends, is removed from the registry with its revocation entries, so the index never offers what does not work.
- A plugin id, the `name` of the plugin's `package.json` and a sidecar name belong to one entry.

## Owners

A pull request changes entries only for its author. The author owns an entry when the entry's `repository` belongs to the author's account, or belongs to an organization of which the author is a public member (`GET https://api.github.com/orgs/<owner>/public_members/<author>` answers 204). A new entry is accepted for its owner; a change to an existing entry is accepted when the author owns the entry as it is in the base branch and as it is in the pull request.

## Check

The check of a pull request reads the files of the pull request as data with the scripts of the base branch, and runs no file of the pull request. It fails, naming the file and the entry, when:

- the pull request changes a path other than `plugins/` and `sidecars/` entry files, which only maintainers change;
- a file name does not match its entry, or a file is not valid JSON;
- an entry breaks an entry rule;
- the author does not own an entry that the pull request adds or changes;
- `sok registry build --previous <published index>` fails on the whole registry of the pull request: every release that the build reads ([build](#build)) is read over https and compared with its `sha256`, and each plugin release that it reads must hold the `plugin.json` and `package.json` of its entry.
- a plugin version that `revoked.json` does not withdraw has an `engines.soksak` range that contains a core version newer than the newest core version that `core.json` lists and `revoked.json` does not withdraw, read with the range rule of that newest core and probed with its next patch, minor and major version. A core release publishes before the plugin releases for it, so such a range would make that core select a plugin version whose manifest its reader was never checked against; a plugin publishes a version for each core release instead. A later `0.0` core that a range `^0.0.z`, or such a part of a union `<range> || <range>`, contains, from `0.0.z` below `0.1.0`, is not such an error: a patch release of core is a compatible release, and that range admits the later patch releases of its line by intent.

Publication runs the same checks on the files of `main`. A core version enters `core.json` without a check of the plugins that installation selects for it: a plugin keeps its own compatibility with a new core and releases a version for it. A plugin whose manifest or source a listed core refuses is left out by that core alone, with its error shown ([serving installed plugins](installation.md#serving-installed-plugins)), until the plugin releases a version that the core accepts. The release of core reads no registry, and a published core release that `core.json` does not list yet is not offered.

## Build

`sok registry build <directory> [--previous <location>]` ([command line](cli.md#releases-and-the-registry)) builds the `index.json` of a registry folder. `<location>` is an https: URL or an absolute file: URL of the index that the previous publication wrote, `https://soksak-app.github.io/registry/index.json` for the public registry.

- Without `--previous`, the build is a first build: it reads and checks every release of the folder. Only a registry with no published index runs it.
- With `--previous`, the build reads the previous index with the rules of [fetching](installation.md#fetching) and checks it as a registry index. A missing, unreachable, not JSON or invalid previous index fails the build with an error that names `<location>`. The build then writes nothing, and it never falls back to a first build.
- A release is carried when the previous index lists the same release. A plugin version is carried when the previous index has the same plugin `id`, `package`, `name` and `repository` and the same version record: `version`, `release`, `engines` and `sidecars`. A sidecar release of a platform is carried when the previous index has the same sidecar `name` and `repository`, and the same `version` and `protocol`, with the same release for that platform. A core release of a key is carried when the previous index lists the same core `version` with the same release for that key. A release is the same when its `url` and its `sha256` are the same.
- A carried release is not read. Its `sha256` is the hash that the previous build checked, and a listed version does not change ([entry rules](#entry-rules)).
- Every other release is read and checked as in [check](#check): a new release, or a release whose recorded facts changed.
- Every entry is still validated, and the index is still checked as a whole and written in one step. Each plugin version records its plugin dependencies in `plugins` of the index ([registry index](installation.md#registry-index)): a read release records the dependencies of its `plugin.json`, and a carried version keeps the `plugins` of the previous index. Every plugin version, read or carried, is judged by the same dependency check against the listed versions, so a carried version whose dependency has no listed version fails the build.
- Each plugin entry takes `maker` and `categories` from the `plugin.json` of its newest listed version when the build reads that release; a carried version keeps the values of the previous index. `updated` is the UTC date of the build that first lists the newest version, and a carried version keeps the `updated` of the previous index.
- A previous index whose `format` is not 3, or whose plugin entries lack `maker`, `categories` or `updated`, or whose plugin versions lack `plugins`, fails the build with an error that names `<location>`. The publication of this format change therefore runs one first build without `--previous`; later builds pass the index that it published.

## Merge and publication

- `validate.yml` runs the check on `pull_request` with read permission only, so the maintainers review a pull request with its result.
- The registry maintainers merge a pull request after its check passes and they have reviewed it.
- `publish.yml` publishes the index on each push to `main`: it builds `index.json` with `sok registry build --previous` of the published index and deploys it with GitHub Pages by the id of the artifact that its upload returns. A lookup of the artifact by name lists the artifacts of the run, which is empty for an artifact finalized less than a second earlier and holds two after a re-run, so the deployment never looks the artifact up by name and a re-run of the workflow deploys again.

The `sok` of the check and of publication is the `sok` of the core release named by the workflow.

## Releases of soksak components

The soksak plugins and sidecars are maintained by the registry maintainers. After a repository publishes a release, a maintainer writes the new version into its entry with `scripts/add-version.mjs` of the registry and pushes the entry file to `main`, which publishes it; publication fails when an release does not match its entry.
