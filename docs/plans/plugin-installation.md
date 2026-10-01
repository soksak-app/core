# Installable plugins (0.0.2)

[한국어](plugin-installation.ko.md)

Status: proposal for version 0.0.2; implementation is pending. The canonical task checklist is [features](../features.md) item R1. Approved content moves into the specifications and this proposal is then removed. The formats are now specified in [plugin installation formats](../spec/installation.md); the sections below that describe them remain here only as the plan's overview.

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

A check in the registry repository validates every pull request: the entry format, unique ids, the downloaded package against its `sha256`, the package's `plugin.json` and `package.json` against the entry, and each named sidecar version. A reviewer merges the pull request. The check then writes `index.json`, the single file the application reads. In 0.0.2 the registry is a local repository, `url` values are `file:` URLs of local release archives, and `sok registry build` is the check; it runs locally.

The starter pack is `packs/starter.json` with the plugins `browser`, `terminal` and `files`.

## Plugin package

A plugin package is one archive `<id>-<version>.tgz` that holds `package.json`, `plugin.json` and the files listed in `package.json` `files`:

- `package.json` `version` is the plugin version; `engines.soksak` is the core API range the plugin supports; `soksak.sidecars` maps each sidecar package name to a version range.
- Page modules import only `PAGE_IMPORTS` names and relative paths. Third-party libraries are bundled under `ui/vendor` from pinned versions, as now; nothing is installed from npm at run time.
- `sok plugin pack` validates the manifest, the published imports and the import rule, and writes the archive and its `sha256`.

A plugin repository depends on `@soksak/plugin-api` at a core git tag, for example `v0.0.2`, so a plugin is built and tested against a fixed core API. The tool resolves the package from the tag; a working checkout is not a dependency.

## Command line

`sok` is the command line of the application, and every command is public through it: plugin installation, update and removal, packing, sidecar releases, the registry index, and every command that the running application declares; it replaces the Node command line `packages/cli`. `packages/sok/tauriv2` builds `sok` in Rust for the Tauri application and `packages/sok/wailsv3` builds it in Go for the Wails application; the two follow one contract like the hosts and do not link the application frameworks. Each application bundle holds its `sok` next to its executable, and the `sok` that `PATH` reaches decides which implementation runs and which configuration directory it uses. `PATH` reaches the bundle through a path entry (`/etc/paths.d`), not a symbolic link.

Every command that core or a plugin declares runs through `sok`, so a person or a program can drive a window from the command line:

- `sok <command> [--window <name> | --project <directory>] [--surface <id>] [--<parameter> <value>]...` runs a declared command in the running application. The parameter flags come from the command's declared parameter schema; the result is printed as JSON so that a following call can use it.
- `sok commands [--window <name> | --project <directory>]` lists the declared core and plugin commands with their parameters.

For example, `sok core.card.split --project ~/work --card shell --axis y --plugin terminal` splits a card of the window that shows `~/work` and prints the new tab, and `sok terminal.input --project ~/work --surface <tab> --bytes 'npm test\r'` runs a command in that terminal. Installing a plugin and placing it are the same kind of call:

```sh
sok plugin install db-studio
sok core.card.split --project ~/work --card shell --side left --plugin db-studio
```

`core.card.split` takes the side of the new card (`left`, `right`, `top` or `bottom`) instead of an axis, so one call places the new card.

## Sidecar release

`sok sidecar release` writes one archive per platform, `<name>-<version>-<os>-<arch>.tar.gz`, with the executable, `sidecar.json` and its helpers, and a `SHA256SUMS` file. In 0.0.2 the release is built locally for the current macOS architecture; the naming already covers other platforms. The host verifies the archive's `sha256` before it extracts and runs it. Version 0.0.2 checks only the hash; signing and a trust policy for third-party sidecars come later.

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
| `../registry` | The registry (`~/Projects/soksak/registry`) |

The `shell` plugin and its sidecar `@soksak/sidecar-shell` move to their own repositories but are not listed in the registry; the new-space layout uses a terminal card where it used a shell card. Each repository keeps its own checklist and tests. Window checks in core install plugins from a registry fixture with local archives and never use the network.

## Versions

Every core package becomes 0.0.2. After the split each plugin and sidecar has its own version; `scripts/check-versions.mjs` then checks only core packages. The core API version that `engines.soksak` names is the core release version.

