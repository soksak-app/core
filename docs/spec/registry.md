# Public registry

[한국어](registry.ko.md)

The public registry is the repository `soksak-app/registry`. It holds one file per entry of the [registry index](installation.md#registry-index), and anyone adds an entry or a version with a pull request. A check validates each pull request, a workflow merges it when the check passes, and the merge publishes `index.json` at `https://soksak-app.github.io/registry/index.json`, the default registry of the applications ([first run](installation.md#first-run)).

## Files

| Path | Content | Changed by |
| --- | --- | --- |
| `plugins/<id>.json` | One plugin entry of the index | The owner of the entry's repository |
| `sidecars/<file name>.json` | One sidecar entry of the index | The owner of the entry's repository |
| `packs/<name>.json` | One pack of the index | Registry maintainers |
| `revoked.json` | `{ plugins, sidecars }` of the index | Registry maintainers |
| `.github/`, `scripts/`, `test/`, `CODEOWNERS` | The checks and workflows | Registry maintainers |

These files are the source of the index; `index.json` is built from them by `sok registry build` ([command line](cli.md#packages-releases-and-the-registry)) and is not committed. `CODEOWNERS` names the registry maintainers for every path that only they change. Core window checks and development use a local registry built from sibling checkouts by `make registry` ([repositories](plugins.md#repositories)); the public registry has no local build.

## Entry rules

A plugin or sidecar entry follows the [registry index](installation.md#registry-index) and these rules:

- `repository` is `https://github.com/<owner>/<repo>`, the repository that publishes the entry's archives.
- Every `url` is `https://github.com/<owner>/<repo>/releases/download/v<version>/<asset>` with the `<owner>` and `<repo>` of `repository` and the version of its entry. `<asset>` is `<id>-<version>.tgz` for a plugin version and `<file name>-<version>-<platform>.tar.gz` for a sidecar asset of a platform ([installation](installation.md)).
- A version that the published index lists does not change: its `url`, `sha256`, `engines`, `sidecars`, `protocol` and assets stay as they are, and it is not removed. A version is withdrawn only by a `revoked.json` entry.
- A plugin id, a plugin package name and a sidecar name belong to one entry.

## Owners

A pull request changes entries only for its author. The author owns an entry when the entry's `repository` belongs to the author's account, or belongs to an organization of which the author is a public member (`GET https://api.github.com/orgs/<owner>/public_members/<author>` answers 204). A new entry is accepted for its owner; a change to an existing entry is accepted when the author owns the entry as it is in the base branch and as it is in the pull request.

## Check

The check of a pull request reads the files of the pull request as data with the scripts of the base branch, and runs no file of the pull request. It fails, naming the file and the entry, when:

- the pull request changes a path other than `plugins/` and `sidecars/` entry files, which only maintainers change;
- a file name does not match its entry, or a file is not valid JSON;
- an entry breaks an entry rule;
- the author does not own an entry that the pull request adds or changes;
- `sok registry build` fails on the whole registry of the pull request: every archive is read over https and compared with its `sha256`, and each plugin archive must hold the `plugin.json` and `package.json` of its entry.

## Merge and publication

- `validate.yml` runs the check on `pull_request` with read permission only and records the head commit it checked.
- `merge.yml` runs on the completion of `validate.yml` with write permission. It merges the pull request with a squash merge only when the check succeeded, the head commit of the pull request is still the commit that was checked, and the pull request changes only entry files; it then publishes the index in the same run.
- `publish.yml` publishes the index on a push to `main`, for changes that maintainers merge, and is the publication job that `merge.yml` calls. Publication builds `index.json` with `sok registry build` and deploys it with GitHub Pages.

The `sok` of the check and of publication is the `sok` of the core release named by the workflow.

## Releases of soksak components

The soksak plugin and sidecar repositories add their versions the same way: after the release workflow of a component publishes its assets, it opens a pull request that adds the new version to its entry. The workflow uses the repository secret `REGISTRY_TOKEN`, a token that can open pull requests on `soksak-app/registry`, and the pull request author is the owner of that token.
