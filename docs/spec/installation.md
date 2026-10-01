# Plugin installation formats

[한국어](installation.ko.md)

These are the formats that plugin installation uses. [`@soksak/plugin-api/install`](../../packages/plugin-api/install.js) defines and validates them; every validator rejects an unknown field and names the field that is wrong. How the hosts and the workbench install and load plugins is pending under [installable plugins](../plans/plugin-installation.md).

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

A sidecar version is released as one archive per platform, `<file name>-<version>-<platform>.tar.gz`. The file name of a sidecar `@scope/name` is `scope-name`; an unscoped name is used as it is. A platform is one of `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`, `windows-arm64` and `windows-x64`.

## Registry index

The registry index `index.json` has `format` 1 and these lists:

| Field | Entry |
| --- | --- |
| `plugins` | `{ id, package, name, description, license, repository, versions }`; each version is `{ version, package: { url, sha256 }, engines: { soksak }, sidecars }` where `sidecars` maps sidecar names to ranges and is `{}` for a plugin without sidecars |
| `sidecars` | `{ name, repository, versions }`; each version is `{ version, protocol: 1, assets }` where `assets` maps platforms to `{ url, sha256 }` |
| `packs` | `{ name, description, plugins }`: plugin ids installed together |
| `revoked` | `{ plugins: [{ id, version, reason }], sidecars: [{ name, version, reason }] }` |

`url` is a `file:` or `https:` URL and `sha256` is 64 lowercase hexadecimal digits. A description has 1 to 200 characters. The index check also rejects a repeated plugin id, package, sidecar, pack or version; a pack that names an unknown plugin; a plugin version that needs an unknown sidecar or a range that no listed sidecar version satisfies; and a revoked version that is not listed.

## Version selection

Installing a plugin for a core version and platform selects the newest plugin version whose `engines.soksak` contains the core version and that is not revoked. Each installation has one version of a sidecar, shared by every installed plugin that names it. For each sidecar of the selected plugin version, the ranges are the range of that version and the ranges of the other installed plugins that name the sidecar. The version in use is kept when it satisfies every range, is not revoked and has an asset for the platform; otherwise the newest sidecar version that satisfies every range, is not revoked and has an asset for the platform is selected. When a selection is empty, installation fails with the plugin, the version or ranges and the core version or platform; for a sidecar it names each plugin and range.

## Installation layout

Inside the configuration directory, plugin version `<version>` of `<id>` is extracted into `plugins/<id>/<version>`, and the platform asset of a sidecar version into `sidecars/<file name>/<version>/<platform>`. `plugins/installed.json` has `format` 1, `plugins` and `sidecars`. `plugins` maps each plugin id to `{ package, version, enabled, sidecars, previous? }`: the package name, the version in use, whether the plugin loads, the sidecar ranges of that version, and the version that rollback restores. A package appears once. `sidecars` maps each sidecar that an installed plugin names to the version in use, which satisfies the range of every installed plugin that names it; a sidecar that no installed plugin names is not listed.
