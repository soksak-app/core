# Public registry

[한국어](registry.ko.md)

The public registry is the repository `soksak-app/registry`. It holds one file per entry of the [registry index](installation.md#registry-index), and anyone adds an entry or a version with a pull request. A check validates each pull request, the registry maintainers review and merge it, and each push to `main` publishes `index.json` at `https://soksak-app.github.io/registry/index.json`, the default registry of the applications ([first run](installation.md#first-run)).

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

- `repository` is `https://github.com/<owner>/<repo>`, the repository that publishes the entry's releases.
- Every `url` is `https://github.com/<owner>/<repo>/releases/download/v<version>/<file>` with the `<owner>` and `<repo>` of `repository` and the version of its entry. `<file>` is `<id>-<version>.tgz` for a plugin version and `<file name>-<version>-<platform>.tar.gz` for a sidecar release of a platform ([installation](installation.md)).
- A version that the published index lists does not change: its `url`, `sha256`, `engines`, `sidecars`, `protocol` and releases stay as they are, and it is not removed. A version is withdrawn only by a `revoked.json` entry.
- A plugin id, the `name` of the plugin's `package.json` and a sidecar name belong to one entry.

## Owners

A pull request changes entries only for its author. The author owns an entry when the entry's `repository` belongs to the author's account, or belongs to an organization of which the author is a public member (`GET https://api.github.com/orgs/<owner>/public_members/<author>` answers 204). A new entry is accepted for its owner; a change to an existing entry is accepted when the author owns the entry as it is in the base branch and as it is in the pull request.

## Check

The check of a pull request reads the files of the pull request as data with the scripts of the base branch, and runs no file of the pull request. It fails, naming the file and the entry, when:

- the pull request changes a path other than `plugins/` and `sidecars/` entry files, which only maintainers change;
- a file name does not match its entry, or a file is not valid JSON;
- an entry breaks an entry rule;
- the author does not own an entry that the pull request adds or changes;
- `sok registry build` fails on the whole registry of the pull request: every release is read over https and compared with its `sha256`, and each plugin release must hold the `plugin.json` and `package.json` of its entry.

## Merge and publication

- `validate.yml` runs the check on `pull_request` with read permission only, so the maintainers review a pull request with its result.
- The registry maintainers merge a pull request after its check passes and they have reviewed it.
- `publish.yml` publishes the index on each push to `main`: it builds `index.json` with `sok registry build` and deploys it with GitHub Pages.

The `sok` of the check and of publication is the `sok` of the core release named by the workflow.

## Releases of soksak components

The soksak plugins and sidecars are maintained by the registry maintainers. After a repository publishes a release, a maintainer writes the new version into its entry with `scripts/add-version.mjs` of the registry and pushes the entry file to `main`, which publishes it; publication fails when an release does not match its entry.
