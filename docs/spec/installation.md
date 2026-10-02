# Plugin installation formats

[한국어](installation.ko.md)

These are the formats that plugin installation uses. The [command line `sok`](cli.md) validates them in both implementations, and the host contract cases `install.*` state each rule ([host contract](host-contract.md)). Every check rejects an unknown field and names the field that is wrong; fields are checked in a fixed order, so a file with several errors reports the same one in both implementations. A version part is at most 4294967295. [Serving installed plugins](#serving-installed-plugins) states how the hosts and the workbench load them.

## Versions and ranges

A version is `x.y.z` with numeric parts and no leading zeros; versions compare by number. A range is one of:

| Range | Versions |
| --- | --- |
| `x.y.z` | that version only |
| `^x.y.z` | from `x.y.z` below the next change of the first non-zero part: `^1.2.3` is below `2.0.0`, `^0.2.3` below `0.3.0`, `^0.0.2` below `0.0.3` |
| `~x.y.z` | from `x.y.z` below `x.(y+1).0` |
| `>=x.y.z <a.b.c` | from `x.y.z` below `a.b.c`; an empty range is rejected |

Other forms, such as `*`, `latest` or pre-release suffixes, are rejected.

## Plugin package

A plugin package is the archive `<id>-<version>.tgz` of the plugin's files. Its `package.json` declares:

| Field | Meaning |
| --- | --- |
| `name` | Package name; the installed files are served at `/modules/<name>/` |
| `version` | Plugin version |
| `engines.soksak` | Range of core API versions the plugin supports |
| `soksak.sidecars` | Optional map from each sidecar that `plugin.json` `sidecars` names to a version range; it lists exactly those sidecars |
| `files` | Paths inside the package that the archive holds; it includes `plugin.json` |

Other `package.json` fields belong to package tools and are not read.

## Sidecar release asset

A sidecar version is released as one archive per platform, `<file name>-<version>-<platform>.tar.gz`. The file name of a sidecar `@scope/name` is `scope-name`; an unscoped name is used as it is. A platform is one of `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`, `windows-arm64` and `windows-x64`. The installer checks a sidecar archive only against the `sha256` of its registry entry before it extracts and runs it; a sidecar, including one from a third party, is not signed or otherwise reviewed by the application.

## Registry index

The registry index `index.json` has `format` 1 and these lists:

| Field | Entry |
| --- | --- |
| `plugins` | `{ id, package, name, description, license, repository, versions }`; each version is `{ version, package: { url, sha256 }, engines: { soksak }, sidecars }` where `sidecars` maps sidecar names to ranges and is `{}` for a plugin without sidecars |
| `sidecars` | `{ name, repository, versions }`; each version is `{ version, protocol: 1, assets }` where `assets` maps platforms to `{ url, sha256 }` |
| `packs` | `{ name, description, plugins }`: plugin ids installed together |
| `revoked` | `{ plugins: [{ id, version, reason }], sidecars: [{ name, version, reason }] }` |

`url` is an absolute `file:` URL of a local release archive, because version 0.0.2 installs only from a local registry; `sha256` is 64 lowercase hexadecimal digits. A description has 1 to 200 characters (Unicode code points). The index check also rejects a repeated plugin id, package, sidecar, pack or version; a pack that names an unknown plugin; a plugin version that needs an unknown sidecar or a range that no listed sidecar version satisfies; and a revoked version that is not listed.

## Version selection

Installing a plugin for a core version and platform selects the newest plugin version whose `engines.soksak` contains the core version and that is not revoked. Each installation has one version of a sidecar, shared by every installed plugin that names it. For each sidecar of the selected plugin version, the ranges are the range of that version and the ranges of the other installed plugins that name the sidecar. The version in use is kept when it satisfies every range, is not revoked and has an asset for the platform; otherwise the newest sidecar version that satisfies every range, is not revoked and has an asset for the platform is selected. When a selection is empty, installation fails with the plugin, the version or ranges and the core version or platform; for a sidecar it names each plugin and range.

## Installation layout

Inside the configuration directory, plugin version `<version>` of `<id>` is extracted into `plugins/<id>/<version>`, and the platform asset of a sidecar version into `sidecars/<file name>/<version>/<platform>`. `plugins/installed.json` has `format` 1, `plugins` and `sidecars`. `plugins` maps each plugin id to `{ package, version, path, enabled, sidecars, previous? }`: the package name, the version in use, the absolute folder that installation extracted that version into, whether the plugin loads, the sidecar ranges of that version, and the version that rollback restores. A package appears once. `sidecars` maps each sidecar that an installed plugin names to `{ version, path }`: the version in use, which satisfies the range of every installed plugin that names it, and the absolute folder that installation extracted its platform asset into; a sidecar that no installed plugin names is not listed. Installation records each `path` when it extracts the archive, and the hosts read files only from recorded paths.

## Serving installed plugins

Both hosts serve these paths from the configuration directory and read `plugins/installed.json` for each request, so a page that loads after a change sees it:

| Path | Content |
| --- | --- |
| `/installed-plugins.json` | `{ "plugins": [{ id, package, version, diagnostics? }] }`: each enabled plugin of `installed.json`, sorted by id. In a diagnostic build `diagnostics` is the content of the plugin's `diagnostics.json` when its installed package holds one; a release build never sends it. A missing `installed.json` gives `{ "plugins": [] }`. When `installed.json` or a `diagnostics.json` cannot be read or checked, the document is `{ "error": "<message>" }` |
| `/modules/<package>/<path>` | For the package of an enabled installed plugin, the file `<path>` inside the plugin's recorded `path`; a path with an empty, `.` or `..` segment, or a missing file, is not found. Other packages come from the application frontend |

The workbench reads its plugin list from `/installed-plugins.json` and fails the load with the `error` text when the document has one.

When a host starts, it reads the sidecars that the `plugin.json` of each enabled installed plugin names. A sidecar runs from the `path` that `installed.json` records for it, and its executable is the `executable` path of the `sidecar.json` in that folder. A plugin installed or enabled while the application runs is served to pages that load after the change, and its sidecars start after the application restarts.

## Plugin operations in the application

Both hosts run plugin operations with the installer library of their command line (`packages/sok`), so an operation in the application and the same `sok plugin` command change the configuration directory identically. The runtime adapter exposes two host calls and one event:

| Host call or event | Meaning |
| --- | --- |
| `pluginsState()` | Returns `{ registry, index, installed, firstRun }`: `registry` is the `index` URL of `plugins/registry.json` or `null` without one; `index` is the checked registry index, `null` without a registry, or `{ "error": "<message>" }` when it cannot be read or checked; `installed` is the content of `plugins/installed.json`, or `{ "format": 1, "plugins": {}, "sidecars": {} }` without one; `firstRun` is `true` while `plugins/installed.json` does not exist. A failure to read `installed.json` rejects the call with its message |
| `pluginsRun({ action, plugin })` | Runs `install`, `update`, `remove`, `enable` or `disable` for the plugin id with the core version and platform of the application, and returns the output of the matching `sok plugin` command. Any other `action` or a plugin id that is not a non-empty string rejects the call without a change. An operation that fails rejects the call with the message of the matching command and leaves `installed.json` as that command defines |
| `plugins-changed` | Sent to every window after `pluginsRun` changed `installed.json`, with `{ action, plugin }` |

A host runs one operation at a time: a `pluginsRun` call while another runs rejects with `another plugin operation is running`. A host does not observe changes that a `sok` process makes; the next `pluginsState` call and pages that load later read them. A change takes effect when the application restarts: the windows that are open keep the plugins they loaded, and sidecars start only at startup. The browser application has no host, so it has no plugin operations.

## First run

`environment.json` names the starter pack in `starter`. When a window starts and `pluginsState` reports `firstRun`, the workbench installs every plugin of that pack from the registry index with `pluginsRun`, in the pack's order, before it builds a space, and then reloads the page so that the installed plugins load. The first installation writes `installed.json`, so a later start, also after every plugin was removed, installs nothing. Without a registry the window starts with no plugin and logs `first run: no registry is set; the starter pack <name> was not installed`; a registry index that cannot be read, or one without the pack, fails the start with its error. An environment without `starter`, or without a host, installs nothing.

