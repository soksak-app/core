# Installable plugins (0.0.2)

[한국어](plugin-installation.ko.md)

Status: proposal for version 0.0.2; implementation is pending. The canonical task checklist is [features](../features.md) item R1. Approved content moves into the specifications and this proposal is then removed.

## Goal

A plugin is installed, updated, disabled and removed at run time, as in editors that host extensions. A registry lists the plugins anyone may install, and a third party adds a plugin by a pull request to the registry repository. Sidecars are released per platform and installed with the plugins that need them. Version 0.0.2 defines these concepts and runs them locally: the registry, the plugin packages and the sidecar releases live in local directories and local release archives, and the hosted GitHub flow uses the same formats later.

## What changes

The application currently fixes its plugins at build time: `environment.json` lists them, `soksak-stage` copies their files into the frontend, and the host runs sidecar executables from the application bundle. After this change:

- The workbench loads the installed plugin list from the configuration directory instead of the list in `environment.json`. `environment.json` keeps the new-space layout and the starter pack name.
- The host serves an installed plugin's files at `/modules/<package>/` from `<config-dir>/plugins/<id>/<version>/`.
- The host runs a sidecar executable from `<config-dir>/sidecars/<name>/<version>/<os>-<arch>/`.
- The application ships no plugin; its first run installs the starter pack.

## Registry

The registry is a repository with one file per plugin and one file per pack:

| Path | Content |
| --- | --- |
| `plugins/<id>.json` | `id`, `name`, `description`, `license`, `repository`, and `versions`: each `{ version, package: { url, sha256 }, engines: { soksak: <range> }, sidecars: { <name>: <range> } }` |
| `sidecars/<name>.json` | `name`, `repository`, and `versions`: each `{ version, protocol, assets: { "<os>-<arch>": { url, sha256 } } }` |
| `packs/<name>.json` | `name`, `description`, and `plugins`: plugin ids installed together |
| `revoked.json` | Plugin and sidecar versions that must not be installed or run |

A check in the registry repository validates every pull request: the entry format, unique ids, the downloaded package against its `sha256`, the package's `plugin.json` with `@soksak/plugin-api`, and each named sidecar version. A reviewer merges the pull request. The check then writes `index.json`, the single file the application reads. In 0.0.2 the registry is a local repository, `url` values are `file:` URLs of local release archives, and the same check runs locally.

The starter pack is `packs/starter.json` with the plugins `browser`, `terminal` and `files`.

## Plugin package

A plugin package is one archive `<id>-<version>.tgz` that holds `package.json`, `plugin.json` and the files listed in `package.json` `files`:

- `package.json` `version` is the plugin version; `engines.soksak` is the core API range the plugin supports; `soksak.sidecars` maps each sidecar package name to a version range.
- Page modules import only `PAGE_IMPORTS` names and relative paths. Third-party libraries are bundled under `ui/vendor` from pinned versions, as now; nothing is installed from npm at run time.
- `soksak-plugin pack`, a tool of `@soksak/plugin-api`, validates the manifest, the published imports and the import rule, and writes the archive and its `sha256`.

A plugin repository depends on `@soksak/plugin-api` at a core git tag, for example `v0.0.2`, so a plugin is built and tested against a fixed core API. The tool resolves the package from the tag; a working checkout is not a dependency.

## Sidecar release

A sidecar release holds one archive per platform, `<name>-<version>-<os>-<arch>.tar.gz`, with the executable, `sidecar.json` and its helpers, and a `SHA256SUMS` file. In 0.0.2 the release is built locally for the current macOS architecture; the naming already covers other platforms. The host verifies the archive's `sha256` before it extracts and runs it. Version 0.0.2 checks only the hash; signing and a trust policy for third-party sidecars come later.

## Installation

- Install resolves the plugin version whose `engines.soksak` contains the running core API version, then the sidecar versions its ranges allow, downloads the archives, verifies their hashes, and extracts them into the configuration directory. A failed step leaves the previous installation unchanged and reports the step and its reason.
- Update installs the newer version beside the old one and switches to it; rollback switches back. Remove deletes the files after the plugin is no longer loaded.
- Disable keeps the files and stops loading the plugin.
- A plugin that changes its stored data format converts data written in the earlier format when it reads it, as AGENTS.md requires, through a declared conversion of its state module.
- A saved space that holds a tab of a plugin that is not installed opens with a placeholder card that names the plugin and offers installation, instead of failing.
- Each operation is a declared command (`core.plugins.install`, `core.plugins.update`, `core.plugins.remove`, `core.plugins.enable`, `core.plugins.disable`) with a status that reports installed versions and the progress and result of each operation. The settings window gains a plugin page that searches the registry index and runs these commands.
- A development option loads an unpacked plugin directory without packing (`--plugin-dev <directory>`).

## Repositories

| Directory | Repository |
| --- | --- |
| `core` | Core: library, workbench, plugin-api, hosts, applications, specifications, window checks |
| `../plugins/<id>` | One plugin: `browser`, `terminal`, `files`, `shell`, and later others such as `db-studio` |
| `../sidecars/<name>` | One sidecar: `vt` (the current `vt-core` and `vt-alacritty`), `files`, `shell` |
| `../registry` | The registry |

Each repository keeps its own checklist and tests. Window checks in core install plugins from a registry fixture with local archives and never use the network.

## Versions

Every core package becomes 0.0.2. After the split each plugin and sidecar has its own version; `scripts/check-versions.mjs` then checks only core packages. The core API version that `engines.soksak` names is the core release version.

## Open points

- The location and name of the registry repository (`../registry` is proposed).
- Whether `shell`, which is not in the starter pack, stays a published plugin.
